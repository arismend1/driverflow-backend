/**
 * lazy_matching.js — Scalable match generation with candidate pool filtering
 *
 * Architecture (100k+ scale):
 *   Phase 1: SQL hard filters → candidate pool (max CANDIDATE_POOL_SIZE)
 *   Phase 2: JS pre-filter    → operation/license overlap check (fast, no scoring)
 *   Phase 3: Full scoring      → existing weighted algorithm
 *   Phase 4: Top N insert      → potential_matches (ON CONFLICT)
 *
 * Infrastructure (cooldown, locks, freshness) is handled by server.js helpers.
 */

const db = require('./db_adapter');

const MATCH_MAX_GENERATE = parseInt(process.env.MATCH_MAX_GENERATE) || 20;
const CANDIDATE_POOL_SIZE = parseInt(process.env.CANDIDATE_POOL_SIZE) || 200;
const MIN_SCORE = 0.2;

const nowIso = () => new Date().toISOString();

// ─── Utility ────────────────────────────────────────────────────────────────

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

/** Fast overlap check — returns true if any element in A exists in B */
function hasOverlap(arrA, arrB) {
    if (arrA.length === 0 || arrB.length === 0) return true; // no filter = compatible
    const setB = new Set(arrB);
    return arrA.some(a => setB.has(a));
}

// ─── Scoring (unchanged: 40/25/20/15 weights) ──────────────────────────────

function computeScore(co, dr) {
    if (co.req_truck && !dr.has_truck) return null;

    const breakdown = { operation: 0, license: 0, experience: 0, availability: 0 };

    const reqOps = toArray(co.req_operation_types).map(s => s.toLowerCase());
    const drOps = toArray(dr.operation_types).map(s => s.toLowerCase());
    breakdown.operation = (reqOps.length === 0 || drOps.length === 0)
        ? 1.0 : reqOps.filter(r => drOps.includes(r)).length / reqOps.length;

    const reqLics = toArray(co.req_license_types).map(s => s.toLowerCase());
    const drLics = toArray(dr.license_types).map(s => s.toLowerCase());
    breakdown.license = (reqLics.length === 0 || drLics.length === 0)
        ? 1.0 : reqLics.filter(r => drLics.includes(r)).length / reqLics.length;

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
        breakdown.availability = String(co.availability).toLowerCase().trim()
            === String(dr.availability).toLowerCase().trim() ? 1.0 : 0.5;
    }

    const score = Math.min(Math.max(
        (breakdown.operation * 0.40) + (breakdown.license * 0.25) +
        (breakdown.experience * 0.20) + (breakdown.availability * 0.15)
        , 0), 1);

    return score >= MIN_SCORE ? { score, breakdown } : null;
}

// ─── Upsert helper ──────────────────────────────────────────────────────────

async function upsertMatch(companyId, driverId, score, breakdown, nowStr) {
    try {
        const existing = await db.get(
            'SELECT id, status FROM potential_matches WHERE company_id = ? AND driver_id = ?',
            companyId, driverId
        );
        if (existing && ['DECLINED', 'EXPIRED'].includes(existing.status)) return 'skipped';

        if (existing) {
            await db.run(
                'UPDATE potential_matches SET match_score = ?, score_breakdown = ?, updated_at = ? WHERE id = ?',
                score, JSON.stringify(breakdown), nowStr, existing.id
            );
            return 'updated';
        } else {
            await db.run(
                `INSERT INTO potential_matches (company_id, driver_id, match_score, score_breakdown, status, created_at)
                 VALUES (?, ?, ?, ?, 'NEW', ?)`,
                companyId, driverId, score, JSON.stringify(breakdown), nowStr
            );
            return 'inserted';
        }
    } catch (e) {
        if (e.code === '23505' || (e.message && e.message.includes('UNIQUE'))) {
            return 'conflict';
        }
        console.error(`[LazyMatch] upsert error (company=${companyId}, driver=${driverId}):`, e.message);
        return 'error';
    }
}

// ─── Generate matches for driver ────────────────────────────────────────────

async function generateMatchesForDriver(driverId) {
    console.log(`[LazyMatch] driver #${driverId}: starting candidate pool filtering`);

    // Phase 0: Load driver profile
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

    // Phase 1: SQL hard filters → candidate pool
    // Filter: search_status=ON + truck requirement + LIMIT pool size
    const driverHasTruck = driver.has_truck ? 1 : 0;
    const candidates = await db.all(`
        SELECT e.id, e.nombre,
               cr.req_license_types, cr.req_endorsements, cr.req_experience_years,
               cr.req_operation_types, cr.req_modalities, cr.req_truck,
               cr.offered_payment_methods, cr.req_relationships, cr.availability
        FROM empresas e
        LEFT JOIN company_requirements cr ON e.id = cr.company_id
        WHERE e.search_status = 'ON'
          AND (cr.req_truck IS NULL OR cr.req_truck = false OR ? = 1)
        LIMIT ?
    `, driverHasTruck, CANDIDATE_POOL_SIZE);

    console.log(`[LazyMatch] driver #${driverId}: pool=${candidates.length}/${CANDIDATE_POOL_SIZE} (SQL hard filter)`);

    // Phase 2: JS pre-filter — operation type & license overlap
    const drOps = toArray(driver.operation_types).map(s => s.toLowerCase());
    const drLics = toArray(driver.license_types).map(s => s.toLowerCase());

    const preFiltered = candidates.filter(co => {
        const reqOps = toArray(co.req_operation_types).map(s => s.toLowerCase());
        const reqLics = toArray(co.req_license_types).map(s => s.toLowerCase());
        return hasOverlap(reqOps, drOps) && hasOverlap(reqLics, drLics);
    });

    console.log(`[LazyMatch] driver #${driverId}: preFiltered=${preFiltered.length} (op+license overlap)`);

    // Phase 3: Full scoring
    const scored = [];
    for (const co of preFiltered) {
        const result = computeScore(co, driver);
        if (result) scored.push({ company: co, ...result });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MATCH_MAX_GENERATE);

    // Phase 4: Insert/update
    const nowStr = nowIso();
    let inserted = 0, updated = 0;
    for (const { company, score, breakdown } of top) {
        const result = await upsertMatch(company.id, driverId, score, breakdown, nowStr);
        if (result === 'inserted') inserted++;
        if (result === 'updated' || result === 'conflict') updated++;
    }

    console.log(`[LazyMatch] driver #${driverId}: generated=${inserted} updated=${updated} scored=${scored.length} pool=${candidates.length}`);
    return inserted + updated;
}

// ─── Generate matches for company ───────────────────────────────────────────

async function generateMatchesForCompany(companyId) {
    console.log(`[LazyMatch] company #${companyId}: starting candidate pool filtering`);

    // Phase 0: Load company profile
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

    // Phase 1: SQL hard filters → candidate pool
    const reqTruck = company.req_truck ? 1 : 0;
    const candidates = await db.all(`
        SELECT id, nombre, has_cdl, license_types, endorsements, experience_years,
               operation_types, job_preferences, has_truck, payment_methods,
               work_relationships, availability
        FROM drivers
        WHERE search_status = 'ON'
          AND (? = 0 OR has_truck = true)
        LIMIT ?
    `, reqTruck, CANDIDATE_POOL_SIZE);

    console.log(`[LazyMatch] company #${companyId}: pool=${candidates.length}/${CANDIDATE_POOL_SIZE} (SQL hard filter)`);

    // Phase 2: JS pre-filter — operation type & license overlap
    const reqOps = toArray(company.req_operation_types).map(s => s.toLowerCase());
    const reqLics = toArray(company.req_license_types).map(s => s.toLowerCase());

    const preFiltered = candidates.filter(dr => {
        const drOps = toArray(dr.operation_types).map(s => s.toLowerCase());
        const drLics = toArray(dr.license_types).map(s => s.toLowerCase());
        return hasOverlap(reqOps, drOps) && hasOverlap(reqLics, drLics);
    });

    console.log(`[LazyMatch] company #${companyId}: preFiltered=${preFiltered.length} (op+license overlap)`);

    // Phase 3: Full scoring
    const scored = [];
    for (const dr of preFiltered) {
        const result = computeScore(company, dr);
        if (result) scored.push({ driver: dr, ...result });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MATCH_MAX_GENERATE);

    // Phase 4: Insert/update
    const nowStr = nowIso();
    let inserted = 0, updated = 0;
    for (const { driver, score, breakdown } of top) {
        const result = await upsertMatch(companyId, driver.id, score, breakdown, nowStr);
        if (result === 'inserted') inserted++;
        if (result === 'updated' || result === 'conflict') updated++;
    }

    console.log(`[LazyMatch] company #${companyId}: generated=${inserted} updated=${updated} scored=${scored.length} pool=${candidates.length}`);
    return inserted + updated;
}

module.exports = { generateMatchesForDriver, generateMatchesForCompany, computeScore, toArray };
