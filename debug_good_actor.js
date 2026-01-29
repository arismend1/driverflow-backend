const Database = require('better-sqlite3');
const db = new Database('driverflow_sim_1yr.db');

const BAD_ACTORS = [2028, 2029, 2035];

// Find a blocked good actor
const blocked = db.prepare("SELECT * FROM empresas WHERE (is_blocked=1 OR status='BLOCKED') AND id NOT IN (2028,2029,2035)").get();

if (blocked) {
    console.log("BLOCKED GOOD ACTOR:", blocked);
    console.log("INVOICES:");
    const invs = db.prepare("SELECT * FROM invoices WHERE company_id=?").all(blocked.id);
    console.log(JSON.stringify(invs, null, 2));
} else {
    console.log("No blocked good actors found (yay?)");
}
