const Database = require('better-sqlite3');
const path = require('path');

// 1. Get DB Path from Env
const dbPath = process.env.DB_PATH;

if (!dbPath) {
    console.error("ERROR: DB_PATH env var is missing.");
    process.exit(1);
}

// 2. Production Safety Guard
if (dbPath.includes('driverflow_prod.db') ||
    dbPath.includes('\\DriverFlow\\data\\') ||
    dbPath.includes('/DriverFlow/data/')) {
    console.error(`ABORT: DB_PATH points to PRODUCTION or DATA folder. Path: ${dbPath}`);
    console.error("Please use a simulation or test database.");
    process.exit(1);
}

// 3. Parse Args
const sql = process.argv[2];
const jsonMode = process.argv.includes('--json');

if (!sql) {
    console.error('Usage: node scripts/sql_query.js "<SQL>" [--json]');
    process.exit(1);
}

// 4. Execute
try {
    const db = new Database(dbPath, { readonly: true });

    // Check if it's a SELECT/READ or WRITE
    // Simple heuristic: if it starts with SELECT/WITH/PRAGMA it's probably read-like.
    // better-sqlite3 .all() is for SELECT-like queries that return multiple rows.
    // .run() is for INSERT/UPDATE/DELETE.

    const stmt = db.prepare(sql);

    let result;
    if (stmt.reader) {
        result = stmt.all();
        if (jsonMode) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            if (result.length > 0) {
                console.table(result);
            } else {
                console.log("No data returned.");
            }
        }
    } else {
        result = stmt.run();
        console.log(JSON.stringify(result, null, 2));
    }

} catch (err) {
    console.error("SQL_ERROR:", err.message);
    process.exit(1);
}
