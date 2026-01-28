const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase Prod: Adding Operational Flags ---');

const addColumn = (table, colDef) => {
    try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colDef}`).run();
        console.log(`✅ Added column to ${table}: ${colDef.split(' ')[0]}`);
    } catch (e) {
        if (e.message.includes('duplicate column name')) {
            console.log(`⚠️ Column already exists in ${table}: ${colDef.split(' ')[0]}`);
        } else {
            console.error(`❌ Failed to add column to ${table}: ${colDef}`, e.message);
        }
    }
};

try {
    // 1. Company Flags
    // SEARCH_ON / SEARCH_OFF / MATCHED
    addColumn('empresas', "search_status TEXT DEFAULT 'ON' CHECK(search_status IN ('ON', 'OFF', 'MATCHED'))");

    // 2. Driver Flags
    // AVAILABLE / NOT_AVAILABLE / MATCHED
    addColumn('drivers', "search_status TEXT DEFAULT 'ON' CHECK(search_status IN ('ON', 'OFF', 'MATCHED'))");

    // 3. Webhook Events Table (System)
    db.prepare(`
        CREATE TABLE IF NOT EXISTS webhook_events (
            id TEXT PRIMARY KEY,
            provider TEXT,
            received_at DATETIME DEFAULT (datetime('now')),
            CONSTRAINT unique_event_id UNIQUE (id)
        )
    `).run();
    console.log('✅ Created webhook_events table.');

    console.log('✅ Migration Phase Prod complete.');

} catch (error) {
    console.error('❌ Migration failed:', error.message);
} finally {
    db.close();
}
