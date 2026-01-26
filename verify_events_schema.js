const sqlite3 = require('better-sqlite3');
const path = require('path');

const dbPathRaw = process.env.DB_PATH || 'driverflow.db';
const dbPath = path.resolve(dbPathRaw);

console.log(`--- Verifying Schema: events_outbox ---`);
console.log(`DB Path: ${dbPath}`);

let db;
try {
    db = sqlite3(dbPath, { fileMustExist: true });
} catch (e) {
    console.error(`❌ DB not found at path: ${dbPath}`);
    process.exit(1);
}

try {
    const info = db.pragma('table_info(events_outbox)');
    const reqCol = info.find(c => c.name === 'request_id');

    if (!reqCol) {
        console.error('❌ FAIL: request_id column not found.');
        process.exit(1);
    }

    console.log(`Column 'request_id': type=${reqCol.type}, notnull=${reqCol.notnull}`);

    if (reqCol.notnull === 1) {
        console.error('❌ FAIL: request_id is NOT NULL.');
        process.exit(1);
    } else {
        console.log('✅ PASS: request_id is NULLABLE.');
        console.log('Schema OK: request_id nullable');
        process.exit(0);
    }

} catch (e) {
    console.error(`❌ Error reading DB: ${e.message}`);
    process.exit(1);
} finally {
    if (db) db.close();
}
