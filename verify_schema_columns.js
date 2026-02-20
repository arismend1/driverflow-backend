const db = require('./db_adapter');

async function checkColumns() {
    try {
        console.log("--- Checking Schema for weekly_invoices ---");
        const rows = await db.all(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'weekly_invoices'
        `);

        const cols = rows.map(r => r.column_name);
        console.log("Found columns:", cols.sort().join(', '));

        const required = ['stripe_payment_intent_id', 'paid_at', 'failure_reason', 'attempt_count', 'last_error'];
        const missing = required.filter(c => !cols.includes(c));

        if (missing.length === 0) {
            console.log("✅ All Phase 13 columns present.");
        } else {
            console.error("❌ Missing columns:", missing);
        }

    } catch (e) {
        console.error("Error checking schema:", e);
    }
}

checkColumns();
