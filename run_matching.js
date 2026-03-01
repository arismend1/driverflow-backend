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
            // RULE 1: CDL required
            if (co.req_cdl && !dr.has_cdl) continue;

            // RULE 2: Truck required
            if (co.req_truck && !dr.has_truck) continue;

            // RULE 3: Experience
            if (co.req_experience_years > 0 && (dr.experience_years || 0) < co.req_experience_years) continue;

            // Passed all rules — calculate score
            const matchScore = 1;

            // INSERT OR IGNORE equivalent: catch unique constraint violation silently
            try {
                const result = await db.run(
                    `INSERT INTO potential_matches (company_id, driver_id, match_score, status, created_at)
                     VALUES (?, ?, ?, 'NEW', ?)
                     ON CONFLICT (company_id, driver_id) DO NOTHING`,
                    co.id, dr.id, matchScore, nowStr
                );

                // Emit outbox events only if the row was actually inserted
                // (rowCount > 0 in Postgres, changes > 0 in SQLite)
                const wasInserted = (result.rowCount > 0) || (result.changes > 0);

                if (wasInserted) {
                    newMatchesCount++;

                    // Company notification event
                    await db.run(
                        `INSERT INTO events_outbox (event_name, created_at, company_id, driver_id, request_id, metadata)
                         VALUES (?, ?, ?, ?, NULL, ?)`,
                        'potential_match_company',
                        nowStr,
                        co.id,
                        dr.id,
                        JSON.stringify({ driver_id: dr.id, summary: `Match found for company ${co.id}` })
                    );

                    // Driver notification event
                    await db.run(
                        `INSERT INTO events_outbox (event_name, created_at, company_id, driver_id, request_id, metadata)
                         VALUES (?, ?, ?, ?, NULL, ?)`,
                        'potential_match_driver',
                        nowStr,
                        co.id,
                        dr.id,
                        JSON.stringify({ company_id: co.id, summary: `Match found for driver ${dr.id}` })
                    );
                }
            } catch (insertErr) {
                // Log but don't abort: a single failed insert shouldn't kill the whole run
                console.error(`[Scheduler] Insert error for (${co.id}, ${dr.id}):`, insertErr.message);
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
