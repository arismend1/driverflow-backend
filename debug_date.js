const Database = require('better-sqlite3');
const db = new Database('driverflow_sim_1yr.db');

// Companies with 1970-issue: 2087, 2080
const ids = [2087, 2080];

console.log("--- DEBUG DATE PARSING ---");

function parseDateLoose(val) {
    console.log(`   Input: "${val}" (${typeof val})`);
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number' || (typeof val === 'string' && val.trim() !== '' && !isNaN(val))) {
        const num = Number(val);
        const ms = num < 1e12 ? num * 1000 : num;
        const d = new Date(ms);
        console.log(`   -> Numeric/Epoch: ${d.toISOString()}`);
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(val);
    console.log(`   -> Date Parse: ${d.toISOString()}`);
    return isNaN(d.getTime()) ? null : d;
}

for (const id of ids) {
    console.log(`\nChecking ID ${id}`);
    const lastPayment = db.prepare("SELECT MAX(paid_at) as last_paid FROM invoices WHERE company_id = ? AND paid_at IS NOT NULL").get(id);
    console.log('Query Result:', lastPayment);
    if (lastPayment && lastPayment.last_paid) {
        parseDateLoose(lastPayment.last_paid);
    }
}
