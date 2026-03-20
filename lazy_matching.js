/**
 * lazy_matching.js — Scalable match generation with normalized bridge tables
 *
 * Architecture (100k+ scale):
 *   Phase 1: SQL hard filters + EXISTS/JOIN on bridge tables → candidate pool
 *   Phase 2: Full scoring on reduced pool → weighted algorithm (40/25/20/15 + OTR bonus)
 *   Phase 3: Dynamic pool scaling → expand to 400 if not enough scored
 *   Phase 4: Top N insert/update → potential_matches (ON CONFLICT)
 *
 * Overlap is done via normalized bridge tables (driver_operation_types, etc.)
 * using EXISTS subqueries with B-tree indexes. No more regexp_split_to_array.
 *
 * Infrastructure (cooldown, locks, freshness) is handled by server.js helpers.
 */

const db = require('./db_adapter');
const { trackLeadFunnelEvent } = require('./analytics');

const MATCH_MAX_GENERATE = parseInt(process.env.MATCH_MAX_GENERATE) || 20;
const MATCH_MIN_ACTIVE = parseInt(process.env.MATCH_MIN_ACTIVE) || 5;
const MATCH_FRESH_HOURS = parseInt(process.env.MATCH_FRESH_HOURS) || 24;
const CANDIDATE_POOL_SIZE = parseInt(process.env.CANDIDATE_POOL_SIZE) || 200;
const CANDIDATE_POOL_EXPAND = parseInt(process.env.CANDIDATE_POOL_EXPAND) || 400;
const MIN_SCORE = 0.2;

// OTR eligibility config
const OTR_POOL_REQUIRE_TRAVEL = (process.env.OTR_POOL_REQUIRE_TRAVEL || 'true') === 'true';
const OTR_IMMEDIATE_DAYS = parseInt(process.env.OTR_IMMEDIATE_DAYS) || 7;

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

// ─── Scoring (40/25/20/15 + OTR bonuses) ────────────────────────────────────

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

    let baseScore = (breakdown.operation * 0.40) + (breakdown.license * 0.25) +
        (breakdown.experience * 0.20) + (breakdown.availability * 0.15);

    // OTR bonuses (additive, capped at 1.0)
    let bonus = 0;
    if (dr.willing_to_travel === true) bonus += 0.05;
    if (co.requires_immediate_start && dr.available_from_date) {
        const availDate = new Date(dr.available_from_date);
        const cutoff = new Date(Date.now() + OTR_IMMEDIATE_DAYS * 24 * 60 * 60 * 1000);
        if (availDate <= cutoff) bonus += 0.05;
    }

    const score = Math.min(Math.max(baseScore + bonus, 0), 1);
    breakdown.otr_bonus = bonus;

    // Phase 6: Interview Travel compatibility
    if (co.requires_travel_interview && !dr.willing_travel_interview) {
        // Significantly reduce score or prevent match
        return null; // Prevent match as it's a hard requirement for the company
    }

    return score >= MIN_SCORE ? { score, breakdown } : null;
}

// ─── Upsert helper ──────────────────────────────────────────────────────────

async function upsertMatch(companyId, driverId, score, breakdown, nowStr) {
    try {
        const existing = await db.get(
            'SELECT id, status, resolution_company, resolution_driver, ticket_id, info_shared_at FROM potential_matches WHERE company_id = ? AND driver_id = ?',
            companyId, driverId
        );

        if (existing && ['DECLINED', 'EXPIRED'].includes(existing.status)) {
            console.log('[Funnel] skipped because match is terminal (DECLINED/EXPIRED)');
            return 'skipped';
        }

        // 1. Safety Rule: Do not revive if there was a manual rejection, if a historical ticket already exists, 
        // or if the pair already reached INFO_SHARED (permanent block for audit/billing integrity).
        if (existing && (
            (existing.status === 'CLOSED' && (existing.resolution_company || existing.resolution_driver)) ||
            existing.ticket_id != null ||
            existing.info_shared_at != null
        )) {
            console.log('[Funnel] skipped because match was manually rejected, has ticket history, or reached INFO_SHARED');
            return 'skipped';
        }

        if (existing) {
            const isProactivelyClosed = (existing.status === 'CLOSED');
            const wasHiredElsewhere = (existing.status === 'HIRED_ELSEWHERE');

            // BugFix: Also identify matches in an active state but older than the visibility window
            const isStaleActive = ['NEW', 'VIEWED', 'CONTACTED', 'ACCEPTED'].includes(existing.status) &&
                (new Date() - new Date(existing.created_at) > MATCH_FRESH_HOURS * 3600 * 1000);

            // 2. Freedom Check Rule: Do not interfere with active processes
            // Exclusivity window: 72 hours base + dynamic extensions
            const EXCLUSIVE_HOURS = 72;
            const hoursElapsedSQL = db.IS_POSTGRES
                ? "EXTRACT(EPOCH FROM (NOW() - info_shared_at::timestamp)) / 3600"
                : "CAST(strftime('%s', 'now') - strftime('%s', info_shared_at) AS INTEGER) / 3600";

            const freedomCheck = await db.get(`
                SELECT id FROM potential_matches 
                WHERE driver_id = ? 
                  AND (
                    status IN ('SHARE_PENDING_COMPANY', 'SHARE_PENDING_DRIVER', 'HIRED')
                    OR (status = 'INFO_SHARED' AND (${hoursElapsedSQL} < (${EXCLUSIVE_HOURS} + COALESCE(exclusivity_extension_hours, 0))))
                  )
                LIMIT 1
            `, driverId);

            if (isProactivelyClosed || wasHiredElsewhere || isStaleActive) {
                if (freedomCheck) {
                    console.log(`[Funnel] match revival skipped: driver #${driverId} is busy`);
                    return 'skipped';
                }

                // 3. Driver Availability Rule: search_status must be ON
                const driver = await db.get('SELECT search_status FROM drivers WHERE id = ?', driverId);

                if (driver && driver.search_status === 'ON') {
                    if (isStaleActive) {
                        console.log(`[Funnel] refreshing stale active match ${existing.id}`);
                        await db.run(
                            `UPDATE potential_matches 
                             SET match_score = ?, score_breakdown = ?, created_at = ?, updated_at = ?
                             WHERE id = ?`,
                            score, JSON.stringify(breakdown), nowStr, nowStr, existing.id
                        );
                        return 'updated';
                    } else {
                        console.log(`[Funnel] reviving match ${existing.id} to NEW`);
                        await db.run(
                            `UPDATE potential_matches 
                             SET status = 'NEW', match_score = ?, score_breakdown = ?, created_at = ?, updated_at = ?,
                                 driver_step1_accepted_at = NULL, company_step1_accepted_at = NULL,
                                 driver_share_consent_at = NULL, company_share_consent_at = NULL,
                                 resolution_company = NULL, resolution_driver = NULL,
                                 exclusivity_extension_hours = 0
                             WHERE id = ?`,
                            score, JSON.stringify(breakdown), nowStr, nowStr, existing.id
                        );
                        return 'inserted';
                    }
                }
            }

            console.log('[Funnel] updating score for existing match');
            await db.run(
                'UPDATE potential_matches SET match_score = ?, score_breakdown = ?, updated_at = ? WHERE id = ?',
                score, JSON.stringify(breakdown), nowStr, existing.id
            );
            return 'updated';
        } else {
            // New match insertion path also requires Freedom Check
            const EXCLUSIVE_HOURS = 72;
            const hoursElapsedSQL = db.IS_POSTGRES
                ? "EXTRACT(EPOCH FROM (NOW() - info_shared_at::timestamp)) / 3600"
                : "CAST(strftime('%s', 'now') - strftime('%s', info_shared_at) AS INTEGER) / 3600";

            const freedomCheck = await db.get(`
                SELECT id FROM potential_matches 
                WHERE driver_id = ? 
                  AND (
                    status IN ('SHARE_PENDING_COMPANY', 'SHARE_PENDING_DRIVER', 'HIRED')
                    OR (status = 'INFO_SHARED' AND (${hoursElapsedSQL} < (${EXCLUSIVE_HOURS} + COALESCE(exclusivity_extension_hours, 0))))
                  )
                LIMIT 1
            `, driverId);

            if (freedomCheck) {
                console.log(`[Funnel] match insertion skipped: driver #${driverId} is busy`);
                return 'skipped';
            }

            console.log('[Funnel] attempting match_generated');
            await db.run(
                `INSERT INTO potential_matches (company_id, driver_id, match_score, score_breakdown, status, created_at)
                 VALUES (?, ?, ?, ?, 'NEW', ?)`,
                companyId, driverId, score, JSON.stringify(breakdown), nowStr
            );

            // --- PUSH: Notify driver of new match ---
            try {
                const { sendPush } = require('./notifications_service');
                await sendPush(driverId, 'driver', "¡Nuevo Match!", "Tienes una nueva oportunidad de trabajo. Revisa tus matches.");
            } catch (pushErr) {
                console.error("[LazyMatch] Push fail:", pushErr.message);
            }

            try {
                // Fire and forget, do not await to prevent blocking
                trackLeadFunnelEvent('match_generated', { company_id: companyId, driver_id: driverId, metadata: { match_source: "lazy_matching" } })
                    .then(() => console.log('[Funnel] match_generated success'))
                    .catch(err => console.log('[Funnel] match_generated error: ' + err.message));
                console.log('[Funnel] match_generated start');
            } catch (err) {
                console.log('[Funnel] match_generated synchronous error: ' + err.message);
            }
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

// ─── Candidate pool: Driver → Companies (using bridge tables) ───────────────

async function fetchCompanyCandidates(driver, limit, excludeIds) {
    const driverHasTruck = driver.has_truck ? 1 : 0;

    let excludeFilter = '';
    const params = [driverHasTruck, driver.id, driver.id];

    if (excludeIds && excludeIds.length > 0) {
        excludeFilter = `AND e.id NOT IN (${excludeIds.map(() => '?').join(',')})`;
        params.push(...excludeIds);
    }

    params.push(limit);

    const query = `
        SELECT e.id, e.nombre,
               COALESCE(cr.req_license_types, '[]') AS req_license_types,
               COALESCE(cr.req_endorsements, '[]') AS req_endorsements,
               COALESCE(cr.req_experience_years, 0) AS req_experience_years,
               COALESCE(cr.req_operation_types, '[]') AS req_operation_types,
               COALESCE(cr.req_modalities, '[]') AS req_modalities,
               COALESCE(cr.req_truck, false) AS req_truck,
               COALESCE(cr.offered_payment_methods, '[]') AS offered_payment_methods,
               COALESCE(cr.req_relationships, '[]') AS req_relationships,
               COALESCE(cr.availability, '') AS availability,
               COALESCE(cr.requires_immediate_start, false) AS requires_immediate_start,
               COALESCE(cr.requires_travel_interview, false) AS requires_travel_interview
        FROM empresas e
        LEFT JOIN company_requirements cr ON e.id = cr.company_id
        WHERE e.search_status = 'ON'
          AND (e.search_expires_at IS NULL OR e.search_expires_at > NOW())
          AND (cr.req_truck IS NULL OR cr.req_truck = false OR ? = 1)
          AND (
              NOT EXISTS (SELECT 1 FROM company_req_operation_types WHERE company_id = e.id)
              OR EXISTS (
                  SELECT 1
                  FROM company_req_operation_types crot
                  JOIN driver_operation_types dot ON dot.value = crot.value
                  WHERE crot.company_id = e.id AND dot.driver_id = ?
              )
          )
          AND (
              NOT EXISTS (SELECT 1 FROM company_req_license_types WHERE company_id = e.id)
              OR EXISTS (
                  SELECT 1
                  FROM company_req_license_types crlt
                  JOIN driver_license_types dlt ON dlt.value = crlt.value
                  WHERE crlt.company_id = e.id AND dlt.driver_id = ?
              )
          )
          ${excludeFilter}
        ORDER BY e.created_at DESC NULLS LAST
        LIMIT ?
    `;

    return db.all(query, ...params);
}

// ─── Candidate pool: Company → Drivers (using bridge tables) ────────────────

async function fetchDriverCandidates(company, limit, excludeIds) {
    const reqTruck = company.req_truck ? 1 : 0;
    const requireTravel = OTR_POOL_REQUIRE_TRAVEL ? 1 : 0;
    const requiresImmediate = company.requires_immediate_start ? 1 : 0;

    let excludeFilter = '';
    const params = [reqTruck, requireTravel, requiresImmediate, OTR_IMMEDIATE_DAYS,
        company.id, company.id, company.id, company.id];

    if (excludeIds && excludeIds.length > 0) {
        excludeFilter = `AND d.id NOT IN (${excludeIds.map(() => '?').join(',')})`;
        params.push(...excludeIds);
    }

    params.push(limit);

    const query = `
        SELECT d.id, COALESCE(d.nombre, '') AS nombre, 
               COALESCE(d.has_cdl, false) AS has_cdl, 
               COALESCE(d.license_types, '[]') AS license_types, 
               COALESCE(d.endorsements, '[]') AS endorsements, 
               COALESCE(d.experience_years, 0) AS experience_years,
               COALESCE(d.operation_types, '[]') AS operation_types, 
               COALESCE(d.job_preferences, '[]') AS job_preferences, 
               COALESCE(d.has_truck, false) AS has_truck, 
               COALESCE(d.payment_methods, '[]') AS payment_methods,
               COALESCE(d.work_relationships, '[]') AS work_relationships, 
               COALESCE(d.availability, '') AS availability,
               COALESCE(d.willing_to_travel, false) AS willing_to_travel, 
               COALESCE(d.willing_travel_interview, false) AS willing_travel_interview,
               d.available_from_date, 
               COALESCE(d.home_time_weeks, 0) AS home_time_weeks
        FROM drivers d
        WHERE d.search_status = 'ON'
          AND (d.search_expires_at IS NULL OR d.search_expires_at > NOW())
          AND (? = 0 OR d.has_truck = true)
          AND (? = 0 OR d.willing_to_travel = true)
          AND (
              ? = 0
              OR d.available_from_date IS NULL
              OR d.available_from_date <= CURRENT_DATE + (? * INTERVAL '1 day')
          )
          AND (
              NOT EXISTS (SELECT 1 FROM company_req_operation_types WHERE company_id = ?)
              OR EXISTS (
                  SELECT 1
                  FROM driver_operation_types dot
                  JOIN company_req_operation_types crot ON crot.value = dot.value
                  WHERE dot.driver_id = d.id AND crot.company_id = ?
              )
          )
          AND (
              NOT EXISTS (SELECT 1 FROM company_req_license_types WHERE company_id = ?)
              OR EXISTS (
                  SELECT 1
                  FROM driver_license_types dlt
                  JOIN company_req_license_types crlt ON crlt.value = dlt.value
                  WHERE dlt.driver_id = d.id AND crlt.company_id = ?
              )
          )
          ${excludeFilter}
        ORDER BY d.created_at DESC NULLS LAST
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
    console.log(`[LazyMatch] driver #${driverId}: starting normalized candidate pool`);

    const driver = await db.get(`
        SELECT id, nombre, has_cdl, license_types, endorsements, experience_years,
               operation_types, job_preferences, has_truck, payment_methods,
               work_relationships, availability, willing_travel_interview
        FROM drivers WHERE id = ? AND search_status = 'ON'
               AND (search_expires_at IS NULL OR search_expires_at > NOW())
    `, driverId);

    if (!driver) {
        console.log(`[LazyMatch] driver #${driverId}: not found or search_status != ON`);
        return 0;
    }

    // Phase 1: SQL candidate pool (bridge table EXISTS/JOIN)
    let pool = await fetchCompanyCandidates(driver, CANDIDATE_POOL_SIZE, []);
    console.log(`[LazyMatch] driver #${driverId}: pool=${pool.length}/${CANDIDATE_POOL_SIZE} (bridge table filter)`);

    // Phase 2: Score the pool
    const scorer = (co) => computeScore(co, driver);
    let scored = scorePool(pool, scorer);
    console.log(`[LazyMatch] driver #${driverId}: scored=${scored.length} (min_score >= ${MIN_SCORE})`);

    // Phase 3: Dynamic pool scaling
    if (scored.length < MATCH_MIN_ACTIVE && pool.length >= CANDIDATE_POOL_SIZE) {
        const evaluatedIds = pool.map(c => c.id);
        console.log(`[LazyMatch] driver #${driverId}: expanding pool to ${CANDIDATE_POOL_EXPAND}`);
        const extraPool = await fetchCompanyCandidates(driver, CANDIDATE_POOL_EXPAND, evaluatedIds);
        console.log(`[LazyMatch] driver #${driverId}: extra_pool=${extraPool.length}`);
        const extraScored = scorePool(extraPool, scorer);
        scored = scored.concat(extraScored);
        scored.sort((a, b) => b.score - a.score);
        pool = pool.concat(extraPool);
    }

    // Phase 4: Top N insert/update
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
    console.log(`[LazyMatch] company #${companyId}: starting normalized candidate pool`);

    const company = await db.get(`
        SELECT e.id, e.nombre,
               cr.req_license_types, cr.req_endorsements, cr.req_experience_years,
               cr.req_operation_types, cr.req_modalities, cr.req_truck,
               cr.offered_payment_methods, cr.req_relationships, cr.availability,
               cr.requires_immediate_start, cr.requires_travel_interview
        FROM empresas e
        LEFT JOIN company_requirements cr ON e.id = cr.company_id
        WHERE e.id = ? AND e.search_status = 'ON'
          AND (e.search_expires_at IS NULL OR e.search_expires_at > NOW())
    `, companyId);

    if (!company) {
        console.log(`[LazyMatch] company #${companyId}: not found or search_status != ON`);
        return 0;
    }

    // Phase 1: SQL candidate pool
    let pool = await fetchDriverCandidates(company, CANDIDATE_POOL_SIZE, []);
    console.log(`[LazyMatch] company #${companyId}: pool=${pool.length}/${CANDIDATE_POOL_SIZE} (bridge table filter)`);

    // Phase 2: Score the pool
    const scorer = (dr) => computeScore(company, dr);
    let scored = scorePool(pool, scorer);
    console.log(`[LazyMatch] company #${companyId}: scored=${scored.length} (min_score >= ${MIN_SCORE})`);

    // Phase 3: Dynamic pool scaling
    if (scored.length < MATCH_MIN_ACTIVE && pool.length >= CANDIDATE_POOL_SIZE) {
        const evaluatedIds = pool.map(d => d.id);
        console.log(`[LazyMatch] company #${companyId}: expanding pool to ${CANDIDATE_POOL_EXPAND}`);
        const extraPool = await fetchDriverCandidates(company, CANDIDATE_POOL_EXPAND, evaluatedIds);
        console.log(`[LazyMatch] company #${companyId}: extra_pool=${extraPool.length}`);
        const extraScored = scorePool(extraPool, scorer);
        scored = scored.concat(extraScored);
        scored.sort((a, b) => b.score - a.score);
        pool = pool.concat(extraPool);
    }

    // Phase 4: Top N insert/update
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
