const Database = require('better-sqlite3');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || 'driverflow.db';
const db = new Database(DB_PATH);

console.log(`--- Migrating: Phase 5.2 Stripe Automation on ${DB_PATH} ---`);

try {
    const run = db.transaction(() => {
        // 1. Create stripe_webhook_events table (Idempotency)
        db.prepare(`
            CREATE TABLE IF NOT EXISTS stripe_webhook_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stripe_event_id TEXT UNIQUE NOT NULL,
                type TEXT NOT NULL,
                status TEXT DEFAULT 'processed',
                created_at TEXT NOT NULL,
                processed_at TEXT,
                last_error TEXT
            )
        `).run();
        console.log('✅ stripe_webhook_events table schema OK.');

        // 2. Add columns to tickets
        const tableInfo = db.prepare("PRAGMA table_info(tickets)").all();
        const cols = tableInfo.map(c => c.name);

        if (!cols.includes('stripe_checkout_session_id')) {
            db.prepare("ALTER TABLE tickets ADD COLUMN stripe_checkout_session_id TEXT").run();
            console.log('✅ Added stripe_checkout_session_id to tickets.');
        }

        if (!cols.includes('stripe_payment_intent_id')) {
            db.prepare("ALTER TABLE tickets ADD COLUMN stripe_payment_intent_id TEXT").run();
            console.log('✅ Added stripe_payment_intent_id to tickets.');
        }

        if (!cols.includes('stripe_customer_id')) {
            db.prepare("ALTER TABLE tickets ADD COLUMN stripe_customer_id TEXT").run();
            console.log('✅ Added stripe_customer_id to tickets.');
        }

        if (!cols.includes('paid_at')) {
            // It might exist from previous billing migrations, but safeguard
            db.prepare("ALTER TABLE tickets ADD COLUMN paid_at TEXT").run();
            console.log('✅ Added paid_at to tickets.');
        } else {
            console.log('ℹ️  paid_at exists in tickets.');
        }

        if (!cols.includes('payment_ref')) {
            // It might exist
            db.prepare("ALTER TABLE tickets ADD COLUMN payment_ref TEXT").run();
            console.log('✅ Added payment_ref to tickets.');
        } else {
            console.log('ℹ️  payment_ref exists in tickets.');
        }
    });

    run();
    console.log('✅ Phase 5.2 Stripe Migration Complete');

} catch (err) {
    console.error('❌ Migration Failed:', err.message);
    process.exit(1);
}
