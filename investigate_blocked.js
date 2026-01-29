const Database = require('better-sqlite3');
const db = new Database('driverflow_sim_1yr.db');

const KNOWN_BAD = [2028, 2029, 2035];

console.log("--- FORENSIC ANALYSIS: UNEXPECTED BLOCKS ---");

// 1. Find ALL blocked companies
const unexpected = db.prepare(`
    SELECT id, nombre, is_blocked, blocked_reason 
    FROM empresas 
    WHERE is_blocked=1
`).all();

console.log(`Found ${unexpected.length} unexpected blocked companies.`);

for (const co of unexpected) {
    console.log(`\n🔍 INVESTIGATING COMPANY ID: ${co.id} (${co.nombre})`);
    console.log(`   Status: is_blocked=${co.is_blocked}, status=${co.status}, account_status=${co.account_status}`);
    console.log(`   Reason: ${co.blocked_reason}`);

    // 2. Look at their invoices
    const invoices = db.prepare("SELECT * FROM invoices WHERE company_id=? ORDER BY created_at").all(co.id);
    console.log(`   📜 Invoice History (${invoices.length} invoices):`);

    if (invoices.length === 0) {
        console.log("      (No invoices found - weird, how are they blocked?)");
    }

    for (const inv of invoices) {
        console.log(`      - ID ${inv.id} | Week: ${inv.billing_week} | Status: ${inv.status} | Due: ${inv.due_date} | Created: ${inv.created_at} | PaidAt: ${inv.paid_at}`);
    }
}
