const Database = require('better-sqlite3');

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
const companyId = process.argv[2];

if (!companyId) {
    console.error('Usage: node scripts/tickets_by_week.js <companyId>');
    process.exit(1);
}

// 4. Execute
try {
    const db = new Database(dbPath, { readonly: true });

    const sql = `
        SELECT billing_week, COUNT(*) AS tickets
        FROM tickets
        WHERE company_id = ?
        GROUP BY billing_week
        ORDER BY billing_week;
    `;

    const rows = db.prepare(sql).all(companyId);

    console.log(JSON.stringify(rows, null, 2));
    if (rows.length > 0) {
        console.table(rows);
    } else {
        console.log("No tickets found for company " + companyId);
    }

} catch (err) {
    console.error("SQL_ERROR:", err.message);
    process.exit(1);
}
