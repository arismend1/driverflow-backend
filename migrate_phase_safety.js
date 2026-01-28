const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase Safety: Audit & Webhook Idempotency ---');

try {
    db.exec(`
        -- 1. Webhook Idempotency
        CREATE TABLE IF NOT EXISTS webhook_events (
            id TEXT PRIMARY KEY,
            provider TEXT,
            created_at DATETIME DEFAULT (datetime('now'))
        );

        -- 2. Audit Logs (Voiding/Admin Actions)
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            admin_user TEXT,
            target_id TEXT,
            reason TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT (datetime('now'))
        );
        
        -- 3. Credits (for Voiding Paid Invoices)
        CREATE TABLE IF NOT EXISTS credit_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            amount_cents INTEGER,
            reason TEXT,
            created_at DATETIME DEFAULT (datetime('now')),
            used_at DATETIME
        );
    `);
    console.log('✅ Safety tables created.');
} catch (e) {
    console.error('Migration Error:', e.message);
}
