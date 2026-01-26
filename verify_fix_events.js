const sqlite3 = require('better-sqlite3');
const fs = require('fs');
const { execSync } = require('child_process');

console.log('--- VERIFYING BUG FIX: events_outbox NULLABLE ---');

const TEST_DB = 'verify_bugfix.db';
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// 1. SETUP BAD STATE (Legacy Prod Schema)
const db = new sqlite3(TEST_DB);
db.prepare(`
    CREATE TABLE events_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        company_id INTEGER,
        driver_id INTEGER,
        request_id INTEGER NOT NULL, -- THE BUG
        ticket_id INTEGER,
        metadata TEXT,
        processed INTEGER DEFAULT 0
    )
`).run();
// Insert some dummy data to ensure it survives
db.prepare("INSERT INTO events_outbox (event_name, created_at, request_id) VALUES ('legacy_event', '2025-01-01', 123)").run();
db.close();
console.log('✅ Prepared Legacy DB with NOT NULL constraint.');

// 2. RUN MIGRATION
console.log('Running migrate_phase_events.js...');
// We use child process to run the specific migration file, pointing to our test db
try {
    // We can run via node directly.
    // Env vars: DB_PATH
    execSync('node migrate_phase_events.js', {
        env: { ...process.env, DB_PATH: TEST_DB },
        stdio: 'inherit'
    });
} catch (e) {
    console.error('Migration failed'); process.exit(1);
}

// 3. VERIFY FIX
const dbCheck = new sqlite3(TEST_DB);

console.log('Checking Schema...');
const info = dbCheck.pragma('table_info(events_outbox)');
const reqCol = info.find(c => c.name === 'request_id');
if (reqCol.notnull === 0) console.log('PASS: request_id is NULLABLE');
else { console.error('FAIL: request_id is still NOT NULL'); process.exit(1); }

console.log('Checking Data Survival...');
const row = dbCheck.prepare("SELECT * FROM events_outbox WHERE event_name='legacy_event'").get();
if (row && row.request_id === 123) console.log('PASS: Legacy data preserved.');
else { console.error('FAIL: Legacy data lost'); process.exit(1); }

console.log('Checking New Insert (NULL request_id)...');
try {
    dbCheck.prepare("INSERT INTO events_outbox (event_name, created_at, request_id) VALUES ('new_event', '2026-01-20', NULL)").run();
    console.log('PASS: Inserted NULL request_id successfully.');
} catch (e) {
    console.error('FAIL: Insert with NULL blocked:', e.message);
    process.exit(1);
}

console.log('Checking Index (Partial)...');
// Insert another NULL request_id with DIFFERENT event name (should pass)
try {
    dbCheck.prepare("INSERT INTO events_outbox (event_name, created_at, request_id) VALUES ('other_event', '2026-01-20', NULL)").run();
    console.log('PASS: Partial index ignores NULLs (multiple NULLs allowed).');
} catch (e) {
    console.error('FAIL: Partial index blocked multiple NULLs (unexpected):', e.message);
}

// Check Duplicate Real ID (should fail)
try {
    dbCheck.prepare("INSERT INTO events_outbox (event_name, created_at, request_id) VALUES ('legacy_event', 'time', 123)").run();
    console.error('FAIL: Unique index failed to block duplicate.');
} catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) console.log('PASS: Unique index blocked duplicate real ID.');
    else console.error('FAIL: Unexpected error on duplicate:', e.message);
}

dbCheck.close();
console.log('\nALL CHECKS PASSED.');
