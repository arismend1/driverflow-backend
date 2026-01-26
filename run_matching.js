const Database = require('better-sqlite3');
const path = require('path');

// 1. Resolve DB Path
const dbPathRaw = process.env.DB_PATH || 'driverflow.db';
const dbPath = path.resolve(dbPathRaw);

// 2. SAFETY GUARD: Prevent Accidental Production Usage
const normalizedPath = dbPath.toLowerCase().replace(/\//g, '\\');
const isProdPath = normalizedPath.includes('\\driverflow\\data\\') || normalizedPath.endsWith('\\driverflow_prod.db');
const env = (process.env.NODE_ENV || 'development').trim().toLowerCase();
const isProdEnv = env === 'production' || env === 'prod';

if (isProdPath && !isProdEnv) {
    console.error(`
❌ FATAL: SAFETY GUARD TRIGGERED
---------------------------------------------------
You are attempting to modify a PRODUCTION database:
  ${dbPath}
But NODE_ENV is NOT set to 'production' (Current: '${env}').

ABORTING to prevent accidental data corruption.
To bypass, set NODE_ENV="production".
---------------------------------------------------
    `);
    process.exit(1);
}

const db = new Database(dbPath);

const nowIso = () => new Date().toISOString();

console.log(`--- Running Matching Logic [DB: ${dbPath}] ---`);

try {
    // 1. Fetch Eligible Companies (ON + Unblocked)
    // We also need their match prefs
    // Note: account_state is not strictly filtered by user req, but 'is_blocked=0' is mandatory.
    // 'search_status' must be 'ON'.
    const companies = db.prepare(`
        SELECT e.id, e.nombre, e.contacto,
               mp.req_license, mp.req_experience, mp.req_team_driving, mp.req_start, mp.req_restrictions
        FROM empresas e
        JOIN company_match_prefs mp ON e.id = mp.company_id
        WHERE e.search_status = 'ON' 
          AND e.is_blocked = 0
    `).all();

    // 2. Fetch Eligible Drivers (ON + Available)
    // 'estado'='DISPONIBLE' and 'search_status'='ON'
    const drivers = db.prepare(`
        SELECT id, nombre, tipo_licencia, experience_level, team_driving, available_start, restrictions 
        FROM drivers
        WHERE search_status = 'ON' 
          AND estado = 'DISPONIBLE'
    `).all();

    console.log(`Found ${companies.length} eligible companies and ${drivers.length} eligible drivers.`);

    let newMatchesCount = 0;

    // 3. Matching Loop
    const insertMatch = db.prepare(`
        INSERT OR IGNORE INTO potential_matches (company_id, driver_id, match_score, status, created_at)
        VALUES (?, ?, ?, 'NEW', ?)
    `);

    const insertEvent = db.prepare(`
        INSERT INTO events_outbox (event_name, created_at, company_id, driver_id, request_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
        for (const co of companies) {
            for (const dr of drivers) {
                // RULE 1: License (Strict)
                if (co.req_license !== 'Any' && co.req_license !== dr.tipo_licencia) continue;

                // RULE 2: Experience (Strict)
                if (co.req_experience !== 'Any' && co.req_experience !== dr.experience_level) continue;

                // RULE 3: Team Driving
                if (co.req_team_driving === 'Team' && dr.team_driving !== 'YES') continue;
                if (co.req_team_driving === 'Solo' && dr.team_driving !== 'NO') continue;

                // RULE 4: Start
                if (co.req_start === 'Now' && dr.available_start !== 'NOW') continue;

                // RULE 5: Restrictions
                if (co.req_restrictions === 'Yes' && dr.restrictions !== 'YES') continue;

                // MATCH FOUND -> Score = 1
                const matchScore = 1;
                const nowStr = nowIso();

                // 1. Insert Match
                const info = insertMatch.run(co.id, dr.id, matchScore, nowStr);

                if (info.changes > 0) {
                    newMatchesCount++;

                    // 2. Emit Events (CRITICAL: request_id = NULL)
                    // For Company
                    insertEvent.run(
                        'potential_match_company',
                        nowStr,
                        co.id,
                        null,      // driver_id (optional here, schema has it, good to link)
                        null,      // request_id (EXPLICIT NULL)
                        JSON.stringify({ driver_id: dr.id, summary: `Lic: ${dr.tipo_licencia}, Exp: ${dr.experience_level}` })
                    );

                    // For Driver
                    insertEvent.run(
                        'potential_match_driver',
                        nowStr,
                        null,      // company_id (optional here)
                        dr.id,
                        null,      // request_id (EXPLICIT NULL)
                        JSON.stringify({ company_id: co.id, summary: `Company searching for ${co.req_license} drivers` })
                    );
                }
            }
        }
    })();

    console.log(`✅ Matching run complete. Generated ${newMatchesCount} new potential matches.`);

} catch (e) {
    console.error('❌ Matching run failed:', e);
    process.exit(1);
}
