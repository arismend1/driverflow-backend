const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.resolve('driverflow.db');
const db = new Database(dbPath);

console.log("Checking driver_banner table...");
try {
    const rows = db.prepare('SELECT * FROM driver_banner ORDER BY updated_at DESC').all();
    console.log(JSON.stringify(rows, null, 2));
} catch (e) {
    console.error("Error querying DB:", e.message);
} finally {
    db.close();
}
