const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase Reputation: Ratings & Suspension ---');

db.transaction(() => {
    // 1. Ratings Table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            company_id INTEGER NOT NULL,
            driver_id INTEGER NOT NULL,
            rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
            comment TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(request_id)
        )
    `).run();
    console.log('✅ Created ratings table.');

    // 2. Add suspension columns to drivers if not exist
    try {
        db.prepare("ALTER TABLE drivers ADD COLUMN rating_avg REAL DEFAULT 5.0").run();
        console.log('✅ Added rating_avg to drivers.');
    } catch (e) {
        if (!e.message.includes('duplicate column')) console.log(e.message);
    }

    try {
        db.prepare("ALTER TABLE drivers ADD COLUMN suspension_reason TEXT").run();
        console.log('✅ Added suspension_reason to drivers.');
    } catch (e) {
        if (!e.message.includes('duplicate column')) console.log(e.message);
    }
})();

console.log('✅ Migration Phase Reputation complete.');
