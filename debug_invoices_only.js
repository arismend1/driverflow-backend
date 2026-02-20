const db = require('./db_adapter');

async function checkInvoices() {
    try {
        console.log("--- Checking Recent Invoices ---");
        // Simple query
        const invoices = await db.all("SELECT id, company_id, amount_cents, status, created_at, attempt_count FROM weekly_invoices ORDER BY id DESC LIMIT 10");
        console.log("Invoices Found:", invoices.length);
        console.log(JSON.stringify(invoices, null, 2));

    } catch (e) {
        console.error("DB Error:", e.message);
    }
}

checkInvoices();
