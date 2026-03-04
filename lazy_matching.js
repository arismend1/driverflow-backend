/**
 * lazy_matching.js — Scalable match generation with SQL-level overlap filtering
 *
 * Architecture (100k+ scale):
 *   Phase 1: SQL hard filters + overlap (&&) → candidate pool (max CANDIDATE_POOL_SIZE)
 *   Phase 2: Full scoring on reduced pool    → weighted algorithm (40/25/20/15)
 *   Phase 3: Dynamic pool scaling            → expand to 400 if not enough scored
 *   Phase 4: Top N insert/update             → potential_matches (ON CONFLICT)
 *
 * The overlap is now done in Postgres using && (array overlap) on text columns
 * converted via regexp_split_to_array + REPLACE to strip JSON brackets/quotes.
 *
 * Infrastructure (cooldown, locks, freshness) is handled by server.js helpers.
 */

const db = require('./db_adapter');

const MATCH_MAX_GENERATE = parseInt(process.env.MATCH_MAX_GENERATE) || 20;
const MATCH_MIN_ACTIVE = parseInt(process.env.MATCH_MIN_ACTIVE) || 5;
const CANDIDATE_POOL_SIZE = parseInt(process.env.CANDIDATE_POOL_SIZE) || 200;
const CANDIDATE_POOL_EXPAND = parseInt(process.env.CANDIDATE_POOL_EXPAND) || 400;
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

/**
 * SQL expression that converts a TEXT column (JSON array or CSV) to text[]
 * Strips [ ] " then splits by comma with optional whitespace
 * Used in WHERE ... && ?::text[] for overlap checks
 */
const TEXT_TO_ARRAY = (col) =>
    `regexp_split_to_array(LOWER(TRIM(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),'\"',''),'[',''),']',''))), '\\s*,\\s*')`;

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

// ─── Candidate pool: Driver → Companies ─────────────────────────────────────

async function fetchCompanyCandidates(driver, limit, excludeIds) {
    const drOps = toArray(driver.operation_types).map(s => s.toLowerCase().trim()).filter(Boolean);
    const drLics = toArray(driver.license_types).map(s => s.toLowerCase().trim()).filter(Boolean);
    const driverHasTruck = driver.has_truck ? 1 : 0;

    // Build dynamic WHERE clauses for overlap filters
    let opFilter = '';
    let licFilter = '';
    let excludeFilter = '';
    const params = [driverHasTruck];

    // Operation types overlap (SQL-level)
    if (drOps.length > 0) {
        opFilter = `AND (cr.req_operation_types IS NULL OR cr.req_operation_types = '' OR ${TEXT_TO_ARRAY('cr.req_operation_types')} && ?::text[])`;
        params.push(drOps);
    }

    // License types overlap (SQL-level)
    if (drLics.length > 0) {
        licFilter = `AND (cr.req_license_types IS NULL OR cr.req_license_types = '' OR ${TEXT_TO_ARRAY('cr.req_license_types')} && ?::text[])`;
        params.push(drLics);
    }

    // Exclude already-evaluated IDs
    if (excludeIds && excludeIds.length > 0) {
        excludeFilter = `AND e.id NOT IN (${excludeIds.map(() => '?').join(',')})`;
        params.push(...excludeIds);
    }

    params.push(limit);

    const query = `
        SELECT e.id, e.nombre,
               cr.req_license_types, cr.req_endorsements, cr.req_experience_years,
               cr.req_operation_types, cr.req_modalities, cr.req_truck,
               cr.offered_payment_methods, cr.req_relationships, cr.availability
        FROM empresas e
        LEFT JOIN company_requirements cr ON e.id = cr.company_id
        WHERE e.search_status = 'ON'
          AND (cr.req_truck IS NULL OR cr.req_truck = false OR ? = 1)
          ${opFilter}
          ${licFilter}
          ${excludeFilter}
        ORDER BY e.updated_at DESC NULLS LAST
        LIMIT ?
    `;

    return db.all(query, ...params);
}

// ─── Candidate pool: Company → Drivers ──────────────────────────────────────

async function fetchDriverCandidates(company, limit, excludeIds) {
    const reqOps = toArray(company.req_operation_types).map(s => s.toLowerCase().trim()).filter(Boolean);
    const reqLics = toArray(company.req_license_types).map(s => s.toLowerCase().trim()).filter(Boolean);
    const reqTruck = company.req_truck ? 1 : 0;

    let opFilter = '';
    let licFilter = '';
    let excludeFilter = '';
    const params = [reqTruck];

    if (reqOps.length > 0) {
        opFilter = `AND (d.operation_types IS NULL OR d.operation_types = '' OR ${TEXT_TO_ARRAY('d.operation_types')} && ?::text[])`;
        params.push(reqOps);
    }

    if (reqLics.length > 0) {
        licFilter = `AND (d.license_types IS NULL OR d.license_types = '' OR ${TEXT_TO_ARRAY('d.license_types')} && ?::text[])`;
        params.push(reqLics);
    }

    if (excludeIds && excludeIds.length > 0) {
        excludeFilter = `AND d.id NOT IN (${excludeIds.map(() => '?').join(',')})`;
        params.push(...excludeIds);
    }

    params.push(limit);

    const query = `
        SELECT d.id, d.nombre, d.has_cdl, d.license_types, d.endorsements, d.experience_years,
               d.operation_types, d.job_preferences, d.has_truck, d.payment_methods,
               d.work_relationships, d.availability
        FROM drivers d
        WHERE d.search_status = 'ON'
          AND (? = 0 OR d.has_truck = true)
          ${opFilter}
          ${licFilter}
          ${excludeFilter}
        ORDER BY d.updated_at DESC NULLS LAST
        LIMIT ?
    `;

    return db.all(query, ...params);
}

// ─── Score a pool of candidates ─────────────────────────────────────────────

function scorePool(candidates, scorer) {
    const scored = [];
    for (const c of candidates) {
        const result = scorer(c);
        if (result) scored.push({ candidate: c, ...result });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
}

// ─── Generate matches for driver ────────────────────────────────────────────

async function generateMatchesForDriver(driverId) {
    console.log(`[LazyMatch] driver #${driverId}: starting SQL-filtered candidate pool`);

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

    // Phase 1: SQL candidate pool (hard filters + overlap in SQL)
    let pool = await fetchCompanyCandidates(driver, CANDIDATE_POOL_SIZE, []);
    console.log(`[LazyMatch] driver #${driverId}: pool=${pool.length}/${CANDIDATE_POOL_SIZE} (SQL overlap filter)`);

    // Phase 2: Score the pool
    const scorer = (co) => computeScore(co, driver);
    let scored = scorePool(pool, scorer);
    console.log(`[LazyMatch] driver #${driverId}: scored=${scored.length} (min_score >= ${MIN_SCORE})`);

    // Phase 3: Dynamic pool scaling — expand if not enough matches
    if (scored.length < MATCH_MIN_ACTIVE && pool.length >= CANDIDATE_POOL_SIZE) {
        const evaluatedIds = pool.map(c => c.id);
        console.log(`[LazyMatch] driver #${driverId}: expanding pool to ${CANDIDATE_POOL_EXPAND} (scored ${scored.length} < min ${MATCH_MIN_ACTIVE})`);
        const extraPool = await fetchCompanyCandidates(driver, CANDIDATE_POOL_EXPAND, evaluatedIds);
        console.log(`[LazyMatch] driver #${driverId}: extra_pool=${extraPool.length}`);
        const extraScored = scorePool(extraPool, scorer);
        scored = scored.concat(extraScored);
        scored.sort((a, b) => b.score - a.score);
        pool = pool.concat(extraPool);
    }

    // Phase 4: Take top N and insert/update
    const top = scored.slice(0, MATCH_MAX_GENERATE);
    const nowStr = nowIso();
    let inserted = 0, updated = 0;
    for (const { candidate, score, breakdown } of top) {
        const result = await upsertMatch(candidate.id, driverId, score, breakdown, nowStr);
        if (result === 'inserted') inserted++;
        if (result === 'updated' || result === 'conflict') updated++;
    }

    console.log(`[LazyMatch] driver #${driverId}: generated=${inserted} updated=${updated} scored=${scored.length} pool=${pool.length}`);
    return inserted + updated;
}

// ─── Generate matches for company ───────────────────────────────────────────

async function generateMatchesForCompany(companyId) {
    console.log(`[LazyMatch] company #${companyId}: starting SQL-filtered candidate pool`);

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

    // Phase 1: SQL candidate pool
    let pool = await fetchDriverCandidates(company, CANDIDATE_POOL_SIZE, []);
    console.log(`[LazyMatch] company #${companyId}: pool=${pool.length}/${CANDIDATE_POOL_SIZE} (SQL overlap filter)`);

    // Phase 2: Score the pool
    const scorer = (dr) => computeScore(company, dr);
    let scored = scorePool(pool, scorer);
    console.log(`[LazyMatch] company #${companyId}: scored=${scored.length} (min_score >= ${MIN_SCORE})`);

    // Phase 3: Dynamic pool scaling
    if (scored.length < MATCH_MIN_ACTIVE && pool.length >= CANDIDATE_POOL_SIZE) {
        const evaluatedIds = pool.map(d => d.id);
        console.log(`[LazyMatch] company #${companyId}: expanding pool to ${CANDIDATE_POOL_EXPAND} (scored ${scored.length} < min ${MATCH_MIN_ACTIVE})`);
        const extraPool = await fetchDriverCandidates(company, CANDIDATE_POOL_EXPAND, evaluatedIds);
        console.log(`[LazyMatch] company #${companyId}: extra_pool=${extraPool.length}`);
        const extraScored = scorePool(extraPool, scorer);
        scored = scored.concat(extraScored);
        scored.sort((a, b) => b.score - a.score);
        pool = pool.concat(extraPool);
    }

    // Phase 4: Take top N and insert/update
    const top = scored.slice(0, MATCH_MAX_GENERATE);
    const nowStr = nowIso();
    let inserted = 0, updated = 0;
    for (const { candidate, score, breakdown } of top) {
        const result = await upsertMatch(companyId, candidate.id, score, breakdown, nowStr);
        if (result === 'inserted') inserted++;
        if (result === 'updated' || result === 'conflict') updated++;
    }

    console.log(`[LazyMatch] company #${companyId}: generated=${inserted} updated=${updated} scored=${scored.length} pool=${pool.length}`);
    return inserted + updated;
}

module.exports = { generateMatchesForDriver, generateMatchesForCompany, computeScore, toArray };
