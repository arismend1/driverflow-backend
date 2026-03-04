/**
 * lazy_matching.js — Pure match generation (scoring + insert)
 *
 * All infrastructure (cooldown, freshness, advisory locks) is now handled
 * by the endpoint helpers in server.js. This module only does:
 *   1. Load user profile
 *   2. Score against candidates
 *   3. Insert/update potential_matches
 */

const db = require('./db_adapter');

const MATCH_MAX_GENERATE = parseInt(process.env.MATCH_MAX_GENERATE) || 20;
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
        breakdown.availability = String(co.availability).toLowerCase().trim() === String(dr.availability).toLowerCase().trim() ? 1.0 : 0.5;
    }

    const score = Math.min(Math.max(
        (breakdown.operation * 0.40) + (breakdown.license * 0.25) +
        (breakdown.experience * 0.20) + (breakdown.availability * 0.15)
        , 0), 1);

    return score >= MIN_SCORE ? { score, breakdown } : null;
}

// --- Generate matches for driver ---
async function generateMatchesForDriver(driverId) {
    console.log(`[LazyMatch] Generating matches for driver #${driverId}`);

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
            if (existing && ['DECLINED', 'EXPIRED'].includes(existing.status)) continue;

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

    console.log(`[LazyMatch] driver #${driverId}: generated=${inserted} updated=${updated} scored=${scored.length}`);
    return inserted + updated;
}

// --- Generate matches for company ---
async function generateMatchesForCompany(companyId) {
    console.log(`[LazyMatch] Generating matches for company #${companyId}`);

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
            if (existing && ['DECLINED', 'EXPIRED'].includes(existing.status)) continue;

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

    console.log(`[LazyMatch] company #${companyId}: generated=${inserted} updated=${updated} scored=${scored.length}`);
    return inserted + updated;
}

module.exports = { generateMatchesForDriver, generateMatchesForCompany, computeScore, toArray };
