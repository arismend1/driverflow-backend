/**
 * lazy_matching.js — Hardened on-demand match generation
 *
 * Features:
 *   - Freshness + minCount: regenerate if active matches < MIN or stale
 *   - Cooldown: prevent spam regeneration (configurable per-user)
 *   - Race conditions: pg_advisory_lock prevents duplicate generation
 *   - Eligibility: only search_status='ON' users
 *   - Scoring: same algorithm as run_matching.js
 *   - DEFENSIVE: all infrastructure calls wrapped in try/catch to prevent 500s
 */

const db = require('./db_adapter');

// --- Configuration (ENV with defaults) ---
const MATCH_FRESH_HOURS = parseInt(process.env.MATCH_FRESH_HOURS) || 24;
const MATCH_MIN_ACTIVE = parseInt(process.env.MATCH_MIN_ACTIVE) || 5;
const MATCH_MAX_GENERATE = parseInt(process.env.MATCH_MAX_GENERATE) || 20;
const MATCH_COOLDOWN_MINUTES = parseInt(process.env.MATCH_COOLDOWN_MINUTES) || 10;
const MIN_SCORE = 0.2;

const nowIso = () => new Date().toISOString();

// --- Utility ---
function toArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.map(x => String(x).trim()).filter(Boolean);
    if (typeof val === 'string') {
        const s = val.trim();
        if (s.startsWith('[')) {
            try {
                const parsed = JSON.parse(s);
                if (Array.isArray(parsed)) return parsed.map(x => String(x).trim()).filter(Boolean);
            } catch (_) { /* fallback */ }
        }
        return s.split(',').map(x => x.trim()).filter(Boolean);
    }
    return [String(val).trim()].filter(Boolean);
}

function computeScore(co, dr) {
    if (co.req_truck && !dr.has_truck) return null;

    const breakdown = { operation: 0, license: 0, experience: 0, availability: 0 };

    const reqOps = toArray(co.req_operation_types).map(s => s.toLowerCase());
    const drOps = toArray(dr.operation_types).map(s => s.toLowerCase());
    if (reqOps.length === 0 || drOps.length === 0) {
        breakdown.operation = 1.0;
    } else {
        breakdown.operation = reqOps.filter(r => drOps.includes(r)).length / reqOps.length;
    }

    const reqLics = toArray(co.req_license_types).map(s => s.toLowerCase());
    const drLics = toArray(dr.license_types).map(s => s.toLowerCase());
    if (reqLics.length === 0 || drLics.length === 0) {
        breakdown.license = 1.0;
    } else {
        breakdown.license = reqLics.filter(r => drLics.includes(r)).length / reqLics.length;
    }

    if (!co.req_experience_years) {
        breakdown.experience = 1.0;
    } else {
        const reqExp = parseInt(co.req_experience_years) || 0;
        const drExp = parseInt(dr.experience_years) || 0;
        breakdown.experience = (reqExp <= 0) ? 1.0 : (drExp >= reqExp) ? 1.0 : drExp / reqExp;
    }

    if (!co.availability || !dr.availability) {
        breakdown.availability = 1.0;
    } else {
        breakdown.availability = String(co.availability).toLowerCase().trim() === String(dr.availability).toLowerCase().trim() ? 1.0 : 0.5;
    }

    const score = Math.min(Math.max(
        (breakdown.operation * 0.40) + (breakdown.license * 0.25) +
        (breakdown.experience * 0.20) + (breakdown.availability * 0.15)
        , 0), 1);

    return score >= MIN_SCORE ? { score, breakdown } : null;
}

// --- Cooldown check (DEFENSIVE: if table missing → not in cooldown) ---
async function checkCooldown(userId, userType) {
    try {
        const row = await db.get(
            'SELECT last_generated_at FROM user_match_generation_log WHERE user_id = ? AND user_type = ?',
            userId, userType
        );
        if (!row) return false;
        const lastGen = new Date(row.last_generated_at);
        const cooldownMs = MATCH_COOLDOWN_MINUTES * 60 * 1000;
        return (Date.now() - lastGen.getTime()) < cooldownMs;
    } catch (e) {
        console.error(`[LazyMatch] checkCooldown error (table may not exist): ${e.message}`);
        return false; // Fail open: allow generation if cooldown table broken
    }
}

async function updateCooldown(userId, userType) {
    try {
        await db.run(
            `INSERT INTO user_match_generation_log (user_id, user_type, last_generated_at)
             VALUES (?, ?, ?)
             ON CONFLICT (user_id, user_type) DO UPDATE SET last_generated_at = EXCLUDED.last_generated_at`,
            userId, userType, nowIso()
        );
    } catch (e) {
        console.error(`[LazyMatch] updateCooldown error: ${e.message}`);
        // Non-fatal: generation still succeeds even if cooldown can't be recorded
    }
}

// --- Advisory lock (Postgres) / no-op (SQLite) ---
// IMPORTANT: Uses ? placeholder so db_adapter converts to $1 for Postgres
async function acquireLock(lockKey) {
    if (db.IS_POSTGRES) {
        try {
            const result = await db.get('SELECT pg_try_advisory_lock(?) AS acquired', lockKey);
            return result && result.acquired === true;
        } catch (e) {
            console.error(`[LazyMatch] acquireLock error: ${e.message}`);
            return true; // Fail open: allow generation if lock fails
        }
    }
    return true;
}

async function releaseLock(lockKey) {
    if (db.IS_POSTGRES) {
        try {
            await db.get('SELECT pg_advisory_unlock(?) AS released', lockKey);
        } catch (e) {
            console.error(`[LazyMatch] releaseLock error: ${e.message}`);
        }
    }
}

// --- Freshness check ---
async function countRecentActive(userId, userType) {
    try {
        const col = userType === 'driver' ? 'driver_id' : 'company_id';
        const intervalClause = db.IS_POSTGRES
            ? `AND pm.created_at >= NOW() - INTERVAL '${MATCH_FRESH_HOURS} hours'`
            : `AND pm.created_at >= datetime('now', '-${MATCH_FRESH_HOURS} hours')`;

        const row = await db.get(
            `SELECT COUNT(*) AS cnt FROM potential_matches pm
             WHERE pm.${col} = ?
               AND pm.status NOT IN ('DECLINED','EXPIRED')
               ${intervalClause}`,
            userId
        );
        return row ? parseInt(row.cnt) : 0;
    } catch (e) {
        console.error(`[LazyMatch] countRecentActive error: ${e.message}`);
        return 0; // Fail open: treat as 0 active → will generate
    }
}

// --- Should generate? ---
async function shouldGenerate(userId, userType) {
    const recentActive = await countRecentActive(userId, userType);
    const inCooldown = await checkCooldown(userId, userType);
    const needsMore = recentActive < MATCH_MIN_ACTIVE;

    console.log(`[LazyMatch] user=${userType} id=${userId} recent_active=${recentActive} min=${MATCH_MIN_ACTIVE} freshHours=${MATCH_FRESH_HOURS} cooldown=${inCooldown ? 'IN_COOLDOWN' : 'OK'} needsMore=${needsMore}`);

    if (inCooldown) {
        console.log(`[LazyMatch] Skipped — cooldown active for ${userType} #${userId}`);
        return { generate: false, reason: 'cooldown', recentActive };
    }

    if (!needsMore) {
        return { generate: false, reason: 'sufficient', recentActive };
    }

    return { generate: true, reason: 'needed', recentActive };
}

// --- Generate matches for driver ---
async function generateMatchesForDriver(driverId) {
    const decision = await shouldGenerate(driverId, 'driver');
    if (!decision.generate) {
        console.log(`[LazyMatch] driver #${driverId}: skip (${decision.reason}, active=${decision.recentActive})`);
        return 0;
    }

    const lockKey = 100000 + driverId;
    const acquired = await acquireLock(lockKey);
    if (!acquired) {
        console.log(`[LazyMatch] driver #${driverId}: lock=blocked (concurrent generation in progress)`);
        return 0;
    }

    try {
        console.log(`[LazyMatch] driver #${driverId}: lock=acquired, generating...`);

        const driver = await db.get(`
            SELECT id, nombre, has_cdl, license_types, endorsements, experience_years,
                   operation_types, job_preferences, has_truck, payment_methods,
                   work_relationships, availability
            FROM drivers WHERE id = ? AND search_status = 'ON'
        `, driverId);

        if (!driver) {
            console.log(`[LazyMatch] driver #${driverId}: not found or search_status != ON`);
            return 0;
        }

        const companies = await db.all(`
            SELECT e.id, e.nombre,
                   cr.req_license_types, cr.req_endorsements, cr.req_experience_years,
                   cr.req_operation_types, cr.req_modalities, cr.req_truck,
                   cr.offered_payment_methods, cr.req_relationships, cr.availability
            FROM empresas e
            LEFT JOIN company_requirements cr ON e.id = cr.company_id
            WHERE e.search_status = 'ON'
        `);

        const nowStr = nowIso();
        const scored = [];

        for (const co of companies) {
            const result = computeScore(co, driver);
            if (result) scored.push({ company: co, ...result });
        }

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, MATCH_MAX_GENERATE);

        let inserted = 0, updated = 0;
        for (const { company, score, breakdown } of top) {
            try {
                const existing = await db.get(
                    'SELECT id, status FROM potential_matches WHERE company_id = ? AND driver_id = ?',
                    company.id, driverId
                );

                if (existing && ['DECLINED', 'EXPIRED'].includes(existing.status)) {
                    continue;
                }

                if (existing) {
                    await db.run(
                        'UPDATE potential_matches SET match_score = ?, score_breakdown = ?, updated_at = ? WHERE id = ?',
                        score, JSON.stringify(breakdown), nowStr, existing.id
                    );
                    updated++;
                } else {
                    await db.run(
                        `INSERT INTO potential_matches (company_id, driver_id, match_score, score_breakdown, status, created_at)
                         VALUES (?, ?, ?, ?, 'NEW', ?)`,
                        company.id, driverId, score, JSON.stringify(breakdown), nowStr
                    );
                    inserted++;
                }
            } catch (e) {
                if (e.code === '23505' || (e.message && e.message.includes('UNIQUE'))) {
                    updated++;
                } else {
                    console.error(`[LazyMatch] Insert error (company=${company.id}, driver=${driverId}):`, e.message);
                }
            }
        }

        await updateCooldown(driverId, 'driver');
        console.log(`[LazyMatch] driver #${driverId}: generated=${inserted} updated=${updated} total_scored=${scored.length}`);
        return inserted + updated;

    } finally {
        await releaseLock(lockKey);
    }
}

// --- Generate matches for company ---
async function generateMatchesForCompany(companyId) {
    const decision = await shouldGenerate(companyId, 'empresa');
    if (!decision.generate) {
        console.log(`[LazyMatch] company #${companyId}: skip (${decision.reason}, active=${decision.recentActive})`);
        return 0;
    }

    const lockKey = 200000 + companyId;
    const acquired = await acquireLock(lockKey);
    if (!acquired) {
        console.log(`[LazyMatch] company #${companyId}: lock=blocked (concurrent generation in progress)`);
        return 0;
    }

    try {
        console.log(`[LazyMatch] company #${companyId}: lock=acquired, generating...`);

        const company = await db.get(`
            SELECT e.id, e.nombre,
                   cr.req_license_types, cr.req_endorsements, cr.req_experience_years,
                   cr.req_operation_types, cr.req_modalities, cr.req_truck,
                   cr.offered_payment_methods, cr.req_relationships, cr.availability
            FROM empresas e
            LEFT JOIN company_requirements cr ON e.id = cr.company_id
            WHERE e.id = ? AND e.search_status = 'ON'
        `, companyId);

        if (!company) {
            console.log(`[LazyMatch] company #${companyId}: not found or search_status != ON`);
            return 0;
        }

        const drivers = await db.all(`
            SELECT id, nombre, has_cdl, license_types, endorsements, experience_years,
                   operation_types, job_preferences, has_truck, payment_methods,
                   work_relationships, availability
            FROM drivers
            WHERE search_status = 'ON'
        `);

        const nowStr = nowIso();
        const scored = [];

        for (const dr of drivers) {
            const result = computeScore(company, dr);
            if (result) scored.push({ driver: dr, ...result });
        }

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, MATCH_MAX_GENERATE);

        let inserted = 0, updated = 0;
        for (const { driver, score, breakdown } of top) {
            try {
                const existing = await db.get(
                    'SELECT id, status FROM potential_matches WHERE company_id = ? AND driver_id = ?',
                    companyId, driver.id
                );

                if (existing && ['DECLINED', 'EXPIRED'].includes(existing.status)) {
                    continue;
                }

                if (existing) {
                    await db.run(
                        'UPDATE potential_matches SET match_score = ?, score_breakdown = ?, updated_at = ? WHERE id = ?',
                        score, JSON.stringify(breakdown), nowStr, existing.id
                    );
                    updated++;
                } else {
                    await db.run(
                        `INSERT INTO potential_matches (company_id, driver_id, match_score, score_breakdown, status, created_at)
                         VALUES (?, ?, ?, ?, 'NEW', ?)`,
                        companyId, driver.id, score, JSON.stringify(breakdown), nowStr
                    );
                    inserted++;
                }
            } catch (e) {
                if (e.code === '23505' || (e.message && e.message.includes('UNIQUE'))) {
                    updated++;
                } else {
                    console.error(`[LazyMatch] Insert error (company=${companyId}, driver=${driver.id}):`, e.message);
                }
            }
        }

        await updateCooldown(companyId, 'empresa');
        console.log(`[LazyMatch] company #${companyId}: generated=${inserted} updated=${updated} total_scored=${scored.length}`);
        return inserted + updated;

    } finally {
        await releaseLock(lockKey);
    }
}

module.exports = { generateMatchesForDriver, generateMatchesForCompany, shouldGenerate, computeScore, toArray };
