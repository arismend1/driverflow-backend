const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');

console.log('--- VERIFICATION: Automated Matching (Phase D) ---');

// 1. SETUP TEST ENV
const DB_PATH = 'driverflow_verify_matching.db';
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

// 2. MIGRATE (In-process to avoid spawn issues)
console.log('[SETUP] Running Migrations...');
try {
    process.env.DB_PATH = DB_PATH;

    // Clear require cache for migrations to ensure they run if verification is repeated in same process (unlikely but safe)
    const migrations = [
        './migrate_phase1.js',
        './migrate_phase2.js',
        './migrate_phase3.js',
        './migrate_phase_tickets.js',
        './migrate_phase_billing.js',
        './migrate_phase_events.js',
        './migrate_phase_delinquency.js',
        './migrate_phase_email_outbox.js',
        './migrate_phase_onboarding.js',
        './migrate_phase_matching.js',
        './migrate_phase_prod.js',
        './migrate_fix_search_status.js'
    ];

    for (const mig of migrations) {
        console.log(`\n=== Running ${mig} ===`);
        try {
            execSync(`node ${mig}`, {
                env: { ...process.env, DB_PATH },
                stdio: 'inherit'
            });
        } catch (e) {
            console.error(`Failed to run ${mig}`);
            process.exit(1);
        }
    }

} catch (e) {
    console.error('Migration failed:', e);
    process.exit(1);
}

// 3. SEED DATA
const db = new Database(DB_PATH);
const now = new Date().toISOString();

// Companies
// Co1: ON, Matches Driver 1
db.prepare("INSERT INTO empresas (nombre, contacto, password_hash, ciudad, search_status, is_blocked) VALUES (?, ?, ?, ?, 'ON', 0)").run('CoMatch', 'co1@test.com', 'hash', 'City');
const idCo1 = 1;
db.prepare("INSERT INTO company_match_prefs (company_id, req_license) VALUES (?, 'B')").run(idCo1);

// Co2: OFF (Should not match)
db.prepare("INSERT INTO empresas (nombre, contacto, password_hash, ciudad, search_status, is_blocked) VALUES (?, ?, ?, ?, 'OFF', 0)").run('CoOff', 'co2@test.com', 'hash', 'City');

// Co3: ON but Blocked (Should not match)
db.prepare("INSERT INTO empresas (nombre, contacto, password_hash, ciudad, search_status, is_blocked) VALUES (?, ?, ?, ?, 'ON', 1)").run('CoBlocked', 'co3@test.com', 'hash', 'City');

// Drivers
// Dr1: ON, License B (Match Co1)
db.prepare("INSERT INTO drivers (nombre, contacto, password_hash, tipo_licencia, search_status, estado) VALUES (?, ?, ?, 'B', 'ON', 'DISPONIBLE')").run('DrMatch', 'dr1@test.com', 'hash');

// Dr2: OFF (No Match)
db.prepare("INSERT INTO drivers (nombre, contacto, password_hash, tipo_licencia, search_status, estado) VALUES (?, ?, ?, 'B', 'OFF', 'DISPONIBLE')").run('DrOff', 'dr2@test.com', 'hash');

// Dr3: ON, License A (No Match Co1)
db.prepare("INSERT INTO drivers (nombre, contacto, password_hash, tipo_licencia, search_status, estado) VALUES (?, ?, ?, 'A', 'ON', 'DISPONIBLE')").run('DrDiff', 'dr3@test.com', 'hash');

db.close();

// 4. RUN MATCHING
console.log('\n--- EXECUTION: Running Matcher ---');
execSync('node run_matching.js', {
    env: { ...process.env, DB_PATH },
    stdio: 'inherit'
});

// 5. VERIFY
const dbCheck = new Database(DB_PATH, { readonly: true });

console.log('\n--- VERIFICATION: Results ---');

// Check Matches
const matches = dbCheck.prepare("SELECT * FROM potential_matches").all();
console.table(matches);

if (matches.length !== 1) console.error('FAIL: Expected exactly 1 match (Co1 + Dr1)');
else if (matches[0].company_id === 1 && matches[0].driver_id === 1) console.log('PASS: Match Co1-Dr1 created.');
else console.error('FAIL: Wrong match created.');

// Check Events
const events = dbCheck.prepare("SELECT event_name, company_id, driver_id FROM events_outbox WHERE event_name LIKE 'potential_match%'").all();
console.table(events);

if (events.length !== 2) console.error('FAIL: Expected 2 events (1 Co, 1 Dr)');
else console.log('PASS: Events emitted.');

console.log('\n--- VERIFICATION: API & Endpoints ---');
// Use server for these
const SERVER_ENV = {
    ...process.env,
    DB_PATH,
    PORT: '3337',
    JWT_SECRET: 'test_key',
    NODE_ENV: 'test',
    DRY_RUN: '1'
};

(async () => {
    const server = spawn('node', ['server.js'], { env: SERVER_ENV, stdio: 'ignore' });
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    await wait(2000);

    const request = (method, path, token) => {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1', port: 3337,
                path, method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
            }, (res) => {
                let data = ''; res.on('data', c => data += c);
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
            });
            req.end();
        });
    };

    // Auth Tokens
    const jwt = require('jsonwebtoken');
    const tokenCo1 = jwt.sign({ id: 1, type: 'empresa' }, 'test_key');
    const tokenDr1 = jwt.sign({ id: 1, type: 'driver' }, 'test_key');

    // 1. GET Potential Matches (Company)
    const resCo = await request('GET', '/company/potential_matches', tokenCo1);
    console.log(`GET /company/potential_matches: ${resCo.status} (Exp: 200) Count: ${resCo.body.length}`);
    if (resCo.body.length === 1 && resCo.body[0].match_score === 1) console.log('PASS: Company sees match with Score 1.');
    else console.error('FAIL: Company match missing or bad score');

    // 2. GET Potential Matches (Driver)
    const resDr = await request('GET', '/driver/potential_matches', tokenDr1);
    console.log(`GET /driver/potential_matches: ${resDr.status} (Exp: 200) Count: ${resDr.body.length}`);
    if (resDr.body.length === 1 && resDr.body[0].match_score === 1) console.log('PASS: Driver sees match with Score 1.');
    else console.error('FAIL: Driver match missing or bad score');

    // 3. CHECK PERSISTENCE (Status Update)
    const coStatus = dbCheck.prepare('SELECT search_status FROM empresas WHERE id = ?').get(1);
    const drStatus = dbCheck.prepare('SELECT search_status FROM drivers WHERE id = ?').get(1);

    if (coStatus.search_status === 'MATCHED') console.log('PASS: Company Status -> MATCHED');
    else console.error(`FAIL: Company Status is ${coStatus.search_status}`);

    if (drStatus.search_status === 'MATCHED') console.log('PASS: Driver Status -> MATCHED');
    else console.error(`FAIL: Driver Status is ${drStatus.search_status}`);

    server.kill();
    process.exit(0);
})();
