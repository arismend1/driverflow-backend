const db = require('./db_adapter');
const time = require('./time_contract');

async function testCharge() {
    try {
        console.log("--- Setup Test Charge Invoice #5 ---");

        // 1. Set Amount to 100 (so it doesn't auto-close)
        await db.run("UPDATE weekly_invoices SET amount_cents = 100, status='pending' WHERE id = 5");
        console.log("Updated Invoice 5 amount to 100.");

        // 2. Enqueue Job
        const now = time.nowIso();
        await db.run(`
            INSERT INTO jobs_queue (job_type, payload_json, run_at, max_attempts, created_at, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
        `, 'charge_weekly_invoice', JSON.stringify({ invoice_id: 5 }), now, 5, now);

        console.log("Enqueued charge_weekly_invoice for ID 5.");

    } catch (e) {
        console.error("Error:", e);
    }
}

testCharge();
