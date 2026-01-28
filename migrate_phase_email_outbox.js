const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase Emails: Updating events_outbox schema ---');

const addColumn = (colDef) => {
    try {
        db.prepare(`ALTER TABLE events_outbox ADD COLUMN ${colDef}`).run();
        console.log(`✅ Added column: ${colDef.split(' ')[0]}`);
    } catch (e) {
        if (e.message.includes('duplicate column name')) {
            console.log(`⚠️ Column already exists: ${colDef.split(' ')[0]}`);
        } else {
            console.error(`❌ Failed to add column ${colDef}:`, e.message);
        }
    }
};

try {
    // Add columns one by one as SQLite doesn't support multiple ADD COLUMN in one statement standardly in older versions, 
    // better-sqlite3 usually handles standard sqlite syntax.

    // processed_at TEXT NULL
    addColumn("processed_at TEXT");

    // process_status TEXT DEFAULT 'pending' CHECK IN ...
    // Note: SQLite ALTER TABLE ADD COLUMN does not support CHECK constraints easily in strict mode or some versions, 
    // but usually allowed. If it fails, we might need to skip the CHECK in the ALTER and rely on app logic 
    // or recreate table. Let's try simple text first, user asked for CHECK.
    // SQLite allows CHECK in ADD COLUMN.
    addColumn("process_status TEXT DEFAULT 'pending' CHECK(process_status IN ('pending', 'sent', 'failed'))");

    // last_error TEXT NULL
    addColumn("last_error TEXT");

    // send_attempts INTEGER DEFAULT 0
    addColumn("send_attempts INTEGER DEFAULT 0");

    console.log('✅ Migration Phase Emails complete.');

} catch (error) {
    console.error('❌ Migration failed:', error.message);
} finally {
    db.close();
}
