const sqlite3 = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || 'driverflow.db';
const db = new sqlite3(dbPath);

console.log(`--- Migrating Phase Billing: Adding invoices and invoice_items tables to ${dbPath} ---`);

try {
    // 1. invoices table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            billing_week TEXT NOT NULL, -- Format: YYYY-WW
            issue_date TEXT, -- ISO8601 timestamp
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'void')),
            currency TEXT NOT NULL DEFAULT 'USD',
            subtotal_cents INTEGER NOT NULL DEFAULT 0,
            total_cents INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(company_id, billing_week),
            FOREIGN KEY (company_id) REFERENCES empresas(id)
        )
    `).run();
    console.log('✅ Created invoices table successfully.');

    // 2. invoice_items table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            ticket_id INTEGER NOT NULL UNIQUE,
            price_cents INTEGER NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (invoice_id) REFERENCES invoices(id),
            FOREIGN KEY (ticket_id) REFERENCES tickets(id)
        )
    `).run();
    console.log('✅ Created invoice_items table successfully.');

} catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
} finally {
    db.close();
}
