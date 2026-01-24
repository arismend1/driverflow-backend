const sqlite3 = require('better-sqlite3');
const db = sqlite3(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase Tickets: Adding tickets table ---');

try {
    // Disable FKs for drop
    db.pragma('foreign_keys = OFF');
    // Create tickets table
    db.prepare('DROP TABLE IF EXISTS tickets').run();
    db.pragma('foreign_keys = ON');
    db.prepare(`
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            driver_id INTEGER NOT NULL,
            request_id INTEGER NOT NULL UNIQUE,
            price_cents INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USD',
            billing_status TEXT NOT NULL DEFAULT 'unbilled' CHECK(billing_status IN ('unbilled', 'billed', 'void')),
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT,
            billing_week TEXT,
            FOREIGN KEY (company_id) REFERENCES empresas(id),
            FOREIGN KEY(driver_id) REFERENCES drivers(id),
            FOREIGN KEY(request_id) REFERENCES solicitudes(id)
        )
    `).run();

    console.log('✅ Created tickets table successfully.');

} catch (error) {
    console.error('❌ Migration failed:', error.message);
} finally {
    db.close();
}
