const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase Matching: Driver Profiles & Potential Matches ---');

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
    // 1. Driver Profile Extensions
    addColumn('drivers', "experience_level TEXT DEFAULT '1yr'");
    addColumn('drivers', "team_driving TEXT DEFAULT 'NO'");
    addColumn('drivers', "available_start TEXT DEFAULT 'SOON'");
    addColumn('drivers', "restrictions TEXT DEFAULT 'NO'");
    addColumn('drivers', "search_status TEXT DEFAULT 'OFF'");

    // 2. Potential Matches Table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS potential_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            driver_id INTEGER NOT NULL,
            match_score INTEGER DEFAULT 1,
            status TEXT DEFAULT 'NEW',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES empresas(id),
            FOREIGN KEY(driver_id) REFERENCES drivers(id),
            UNIQUE(company_id, driver_id)
        )
    `).run();
    console.log('✅ Created potential_matches table.');

    console.log('✅ Migration Phase Matching complete.');

} catch (error) {
    console.error('❌ Migration failed:', error.message);
} finally {
    db.close();
}
