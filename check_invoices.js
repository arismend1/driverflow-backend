require('dotenv').config();
const db = require('./db_adapter');

async function run() {
    try {
        console.log("--- INVOICE 4 ---");
        const inv = await db.get("SELECT id, created_at, week_start, total_cents FROM invoices WHERE id=4");
        console.log(inv);

        console.log("--- TICKETS CO 3 ---");
        const tickets = await db.all("SELECT id, company_id, created_at, billing_status FROM tickets WHERE company_id=3");
        console.log(tickets);
    } catch (e) {
        console.error("DB Error:", e);
    } finally {
        process.exit(0);
    }
}

run();
