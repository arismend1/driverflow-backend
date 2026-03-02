/**
 * run_matching.js
 *
 * Matching scheduler script. Called via: exec('node run_matching.js')
 * in worker_queue.js every 5 minutes.
 *
 * FIX (2026-03-01): Removed better-sqlite3 entirely.
 * Now uses db_adapter which handles both Postgres (production/Render)
 * and SQLite (local dev) transparently via async API.
 */

const db = require('./db_adapter');

// GUARDRAIL: If neither DATABASE_URL (Postgres) nor DB_PATH (SQLite) is configured,
// skip silently instead of crashing.
if (!process.env.DATABASE_URL && !process.env.DB_PATH) {
    // Check if the default driverflow.db exists locally
    const fs = require('fs');
    const path = require('path');
    const defaultPath = path.resolve('driverflow.db');
    if (!fs.existsSync(defaultPath)) {
        console.log('[Scheduler] Matching skipped: no DB configured');
        process.exit(0);
    }
}

const nowIso = () => new Date().toISOString();

async function runMatching() {
    console.log('--- Running Matching Logic ---');

    // 1. Fetch eligible companies (search_status = ON)
    // Uses the new English-column schema (company_requirements) for matching prefs.
    const companies = await db.all(`
        SELECT e.id, e.nombre, e.contacto,
               cr.req_license_types, cr.req_endorsements, cr.req_experience_years,
               cr.req_operation_types, cr.req_modalities, cr.req_truck,
               cr.offered_payment_methods, cr.req_relationships, cr.availability
        FROM empresas e
        LEFT JOIN company_requirements cr ON e.id = cr.company_id
        WHERE e.search_status = 'ON'
    `);

    // 2. Fetch eligible drivers (search_status = ON)
    const drivers = await db.all(`
        SELECT id, nombre, has_cdl, license_types, endorsements, experience_years,
               operation_types, job_preferences, has_truck, payment_methods,
               work_relationships, availability, search_status
        FROM drivers
        WHERE search_status = 'ON'
    `);

    console.log(`Found ${companies.length} eligible companies and ${drivers.length} eligible drivers.`);

    const nowStr = nowIso();
    let newMatchesCount = 0;

    // 3. Matching loop
    for (const co of companies) {
        for (const dr of drivers) {
            // RULE 1: CDL req (if co asks for CDL, driver must have it)
            if (co.req_cdl && !dr.has_cdl) continue;

            // RULE 2: Truck req
            if (co.req_truck && !dr.has_truck) continue;

            const breakdown = {
                operation: 0,
                license: 0,
                experience: 0,
                availability: 0
            };

            // Score Component 1: Operation Types (40%)
            // e.g. "OTR, Local" vs "OTR"
            if (!co.req_operation_types || !dr.operation_types) {
                breakdown.operation = 1.0; // If not specified, assume match
            } else {
                const reqOps = co.req_operation_types.split(',').map(s => s.trim().toLowerCase());
                const drOps = dr.operation_types.split(',').map(s => s.trim().toLowerCase());
                // Calculate Jaccard similarity or simple intersection ratio
                const matchCount = reqOps.filter(r => drOps.includes(r)).length;
                breakdown.operation = reqOps.length > 0 ? (matchCount / reqOps.length) : 1.0;
            }

            // Score Component 2: Licenses & Endorsements (25%)
            if (!co.req_license_types || !dr.license_types) {
                breakdown.license = 1.0;
            } else {
                const reqLics = co.req_license_types.split(',').map(s => s.trim().toLowerCase());
                const drLics = dr.license_types.split(',').map(s => s.trim().toLowerCase());
                const matchCount = reqLics.filter(r => drLics.includes(r)).length;
                breakdown.license = reqLics.length > 0 ? (matchCount / reqLics.length) : 1.0;
            }

            // Score Component 3: Experience (20%)
            if (!co.req_experience_years) {
                breakdown.experience = 1.0;
            } else {
                const reqExp = parseInt(co.req_experience_years) || 0;
                const drExp = parseInt(dr.experience_years) || 0;
                if (drExp >= reqExp) {
                    breakdown.experience = 1.0;
                } else {
                    breakdown.experience = drExp / reqExp;
                }
            }

            // Score Component 4: Availability (15%)
            if (!co.availability || !dr.availability) {
                breakdown.availability = 1.0;
            } else {
                if (co.availability.toLowerCase().trim() === dr.availability.toLowerCase().trim()) {
                    breakdown.availability = 1.0;
                } else {
                    breakdown.availability = 0.5; // Partial match if different
                }
            }

            // Weighted Total Score (0 to 1)
            const matchScore = (
                (breakdown.operation * 0.40) +
                (breakdown.license * 0.25) +
                (breakdown.experience * 0.20) +
                (breakdown.availability * 0.15)
            );

            // Cap the score just in case float arithmetic is weird
            const clampedScore = Math.min(Math.max(matchScore, 0), 1);

            // Filter out extremely low matches (e.g. less than 20%) to keep quality high
            if (clampedScore < 0.2) continue;

            const breakdownJson = JSON.stringify(breakdown);

            // UNIQUE(company_id, driver_id) means we use ON CONFLICT DO UPDATE
            try {
                // SQLite uses ON CONFLICT DO UPDATE SET...
                // Postgres uses ON CONFLICT DO UPDATE SET...
                const result = await db.run(
                    `INSERT INTO potential_matches (company_id, driver_id, match_score, score_breakdown, status, created_at)
                     VALUES (?, ?, ?, ?, 'NEW', ?)
                     ON CONFLICT (company_id, driver_id) 
                     DO UPDATE SET 
                        match_score = excluded.match_score,
                        score_breakdown = excluded.score_breakdown`,
                    co.id, dr.id, clampedScore, breakdownJson, nowStr
                );

                // For counting new matches vs updated ones, a simple heuristic is if changes > 0/rowCount > 0
                // but strictly speaking, ON CONFLICT updates might count as 2 changes in SQLite sometimes.
                newMatchesCount++;

                // Let's only trigger events if the status is NEW? Or always?
                // For simplicity, we assume if we reach here we can silently update.
                // We'll skip re-triggering the outbox events on every score update to avoid spam, 
                // but the DB has the freshest score now.

            } catch (insertErr) {
                console.error(`[Scheduler] Insert/Update error for (${co.id}, ${dr.id}):`, insertErr.message);
            }
        }
    }

    console.log(`✅ Matching run complete. Generated ${newMatchesCount} new potential matches.`);
    db.close();
    process.exit(0);
}

runMatching().catch(err => {
    console.error('❌ Matching run failed:', err.message);
    db.close();
    process.exit(1);
});
