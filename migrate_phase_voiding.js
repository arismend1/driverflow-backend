const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase Voiding: Adding updated_at to tickets ---');

try {
    db.prepare("ALTER TABLE tickets ADD COLUMN updated_at TEXT").run();
    console.log('✅ Added updated_at to tickets.');
} catch (e) {
    if (!e.message.includes('duplicate column')) console.log(e.message);
}

console.log('✅ Migration Phase Voiding complete.');
