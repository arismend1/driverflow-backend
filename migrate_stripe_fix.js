const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || 'driverflow.db';
const db = new Database(DB_PATH);

console.log(`--- Migrating: Adding Stripe columns to invoices and tickets on ${DB_PATH} ---`);

try {
    const run = db.transaction(() => {
        // 1. stripe_webhook_events table
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
        console.log('✅ stripe_webhook_events table OK.');

        // 2. Add columns to invoices
        const invInfo = db.prepare("PRAGMA table_info(invoices)").all();
        const invCols = invInfo.map(c => c.name);

        if (!invCols.includes('stripe_checkout_session_id')) {
            db.prepare("ALTER TABLE invoices ADD COLUMN stripe_checkout_session_id TEXT").run();
            console.log('✅ Added stripe_checkout_session_id to invoices.');
        }
        if (!invCols.includes('stripe_payment_intent_id')) {
            db.prepare("ALTER TABLE invoices ADD COLUMN stripe_payment_intent_id TEXT").run();
            console.log('✅ Added stripe_payment_intent_id to invoices.');
        }

        // 3. Add columns to tickets
        const tickInfo = db.prepare("PRAGMA table_info(tickets)").all();
        const tickCols = tickInfo.map(c => c.name);

        if (!tickCols.includes('stripe_checkout_session_id')) {
            db.prepare("ALTER TABLE tickets ADD COLUMN stripe_checkout_session_id TEXT").run();
            console.log('✅ Added stripe_checkout_session_id to tickets.');
        }
    });

    run();
    console.log('✅ Stripe columns migration complete.');

} catch (err) {
    console.error('❌ Migration Failed:', err.message);
    process.exit(1);
} finally {
    db.close();
}
