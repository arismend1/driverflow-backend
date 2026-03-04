/**
 * lazy_matching.js
 *
 * On-demand match generation. Matches are created ONLY when a user opens
 * the matches screen, not globally for all users.
 *
 * Reuses the exact same scoring algorithm from run_matching.js:
 *   - Operation Types: 40%
 *   - Licenses: 25%
 *   - Experience: 20%
 *   - Availability: 15%
 */

const db = require('./db_adapter');

const MATCH_LIMIT = 20;
const MIN_SCORE = 0.2;

const nowIso = () => new Date().toISOString();

/**
 * Normalizes a field that may come as:
 * - JSONB array: ["OTR","LOCAL"]
 * - JSON string: '["OTR","LOCAL"]'
 * - CSV string: "OTR, LOCAL"
 * - null/undefined
 */
function toArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.map(x => String(x).trim()).filter(Boolean);
    if (typeof val === 'string') {
        const s = val.trim();
        if (s.startsWith('[')) {
            try {
                const parsed = JSON.parse(s);
                if (Array.isArray(parsed)) return parsed.map(x => String(x).trim()).filter(Boolean);
            } catch (_) { /* fallback to CSV */ }
        }
        return s.split(',').map(x => x.trim()).filter(Boolean);
    }
    return [String(val).trim()].filter(Boolean);
}

/**
 * Compute match score between a company requirements object and a driver profile.
 * Returns { score, breakdown } or null if disqualified.
 */
function computeScore(co, dr) {
    // Hard filter: truck required but driver doesn't have one
    if (co.req_truck && !dr.has_truck) return null;

    const breakdown = { operation: 0, license: 0, experience: 0, availability: 0 };

    // Operation Types (40%)
    const reqOps = toArray(co.req_operation_types).map(s => s.toLowerCase());
    const drOps = toArray(dr.operation_types).map(s => s.toLowerCase());
    if (reqOps.length === 0 || drOps.length === 0) {
        breakdown.operation = 1.0;
    } else {
        const matchCount = reqOps.filter(r => drOps.includes(r)).length;
        breakdown.operation = matchCount / reqOps.length;
    }

    // Licenses (25%)
    const reqLics = toArray(co.req_license_types).map(s => s.toLowerCase());
    const drLics = toArray(dr.license_types).map(s => s.toLowerCase());
    if (reqLics.length === 0 || drLics.length === 0) {
        breakdown.license = 1.0;
    } else {
        const matchCount = reqLics.filter(r => drLics.includes(r)).length;
        breakdown.license = matchCount / reqLics.length;
    }

    // Experience (20%)
    if (!co.req_experience_years) {
        breakdown.experience = 1.0;
    } else {
        const reqExp = parseInt(co.req_experience_years) || 0;
        const drExp = parseInt(dr.experience_years) || 0;
        if (reqExp <= 0) breakdown.experience = 1.0;
        else if (drExp >= reqExp) breakdown.experience = 1.0;
        else breakdown.experience = drExp / reqExp;
    }

    // Availability (15%)
    if (!co.availability || !dr.availability) {
        breakdown.availability = 1.0;
    } else {
        breakdown.availability = String(co.availability).toLowerCase().trim() === String(dr.availability).toLowerCase().trim() ? 1.0 : 0.5;
    }

    const score = Math.min(Math.max(
        (breakdown.operation * 0.40) +
        (breakdown.license * 0.25) +
        (breakdown.experience * 0.20) +
        (breakdown.availability * 0.15)
        , 0), 1);

    if (score < MIN_SCORE) return null;

    return { score, breakdown };
}

/**
 * Generate matches for a specific driver (on-demand).
 * Called when a driver opens /matches/opportunities.
 */
async function generateMatchesForDriver(driverId) {
    console.log(`[LazyMatch] Generating matches for driver #${driverId}`);

    const driver = await db.get(`
        SELECT id, nombre, has_cdl, license_types, endorsements, experience_years,
               operation_types, job_preferences, has_truck, payment_methods,
               work_relationships, availability
        FROM drivers WHERE id = ?
    `, driverId);

    if (!driver) {
        console.log(`[LazyMatch] Driver #${driverId} not found`);
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
    let count = 0;
    const scored = [];

    for (const co of companies) {
        const result = computeScore(co, driver);
        if (result) scored.push({ company: co, ...result });
    }

    // Sort by score descending and limit
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MATCH_LIMIT);

    for (const { company, score, breakdown } of top) {
        try {
            await db.run(
                `INSERT INTO potential_matches (company_id, driver_id, match_score, score_breakdown, status, created_at)
                 VALUES (?, ?, ?, ?, 'NEW', ?)
                 ON CONFLICT (company_id, driver_id)
                 DO UPDATE SET
                    match_score = EXCLUDED.match_score,
                    score_breakdown = EXCLUDED.score_breakdown`,
                company.id, driverId, score, JSON.stringify(breakdown), nowStr
            );
            count++;
        } catch (e) {
            console.error(`[LazyMatch] Insert error (company=${company.id}, driver=${driverId}):`, e.message);
        }
    }

    console.log(`[LazyMatch] Generated ${count} matches for driver #${driverId}`);
    return count;
}

/**
 * Generate matches for a specific company (on-demand).
 * Called when a company opens /matches/candidates.
 */
async function generateMatchesForCompany(companyId) {
    console.log(`[LazyMatch] Generating matches for company #${companyId}`);

    const company = await db.get(`
        SELECT e.id, e.nombre,
               cr.req_license_types, cr.req_endorsements, cr.req_experience_years,
               cr.req_operation_types, cr.req_modalities, cr.req_truck,
               cr.offered_payment_methods, cr.req_relationships, cr.availability
        FROM empresas e
        LEFT JOIN company_requirements cr ON e.id = cr.company_id
        WHERE e.id = ?
    `, companyId);

    if (!company) {
        console.log(`[LazyMatch] Company #${companyId} not found`);
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
    let count = 0;
    const scored = [];

    for (const dr of drivers) {
        const result = computeScore(company, dr);
        if (result) scored.push({ driver: dr, ...result });
    }

    // Sort by score descending and limit
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MATCH_LIMIT);

    for (const { driver, score, breakdown } of top) {
        try {
            await db.run(
                `INSERT INTO potential_matches (company_id, driver_id, match_score, score_breakdown, status, created_at)
                 VALUES (?, ?, ?, ?, 'NEW', ?)
                 ON CONFLICT (company_id, driver_id)
                 DO UPDATE SET
                    match_score = EXCLUDED.match_score,
                    score_breakdown = EXCLUDED.score_breakdown`,
                companyId, driver.id, score, JSON.stringify(breakdown), nowStr
            );
            count++;
        } catch (e) {
            console.error(`[LazyMatch] Insert error (company=${companyId}, driver=${driver.id}):`, e.message);
        }
    }

    console.log(`[LazyMatch] Generated ${count} matches for company #${companyId}`);
    return count;
}

module.exports = { generateMatchesForDriver, generateMatchesForCompany, computeScore, toArray };
