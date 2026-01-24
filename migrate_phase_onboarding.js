const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase Onboarding: Company Profile & Match Params ---');

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
    // 1. Company Extended Profile
    // "Legal company name"
    addColumn('empresas', "legal_name TEXT");
    // "Business address (city, state)" -> We have 'ciudad'. Add 'address_state' and 'address_line1'.
    addColumn('empresas', "address_line1 TEXT");
    addColumn('empresas', "address_state TEXT");
    // "Contact person name"
    addColumn('empresas', "contact_person TEXT");
    // "Contact phone"
    addColumn('empresas', "contact_phone TEXT");
    // "Account state"
    addColumn('empresas', "account_state TEXT DEFAULT 'REGISTERED' CHECK(account_state IN ('REGISTERED','ACTIVE','SUSPENDED'))");
    // "Created At" (Ensure it exists for server.js usage)
    addColumn('empresas', "created_at DATETIME DEFAULT 0");

    // Ensure search_status is OFF by default (It was set to 'ON' in previous debug, but schema def says DEFAULT 'ON'. We want new ones to be OFF? 
    // "Initial search_status = OFF"
    // We can't easily change DEFAULT on SQLite column without recreating. 
    // We will enforce this in the Application Layer (INSERT).

    // 2. Match Requirements Table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS company_match_prefs (
            company_id INTEGER PRIMARY KEY,
            req_license TEXT DEFAULT 'Any',
            req_experience TEXT DEFAULT 'Any',
            req_team_driving TEXT DEFAULT 'Either',
            req_start TEXT DEFAULT 'Flexible',
            req_restrictions TEXT DEFAULT 'No',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES empresas(id)
        )
    `).run();
    console.log('✅ Created company_match_prefs table.');

    console.log('✅ Migration Phase Onboarding complete.');

} catch (error) {
    console.error('❌ Migration failed:', error.message);
} finally {
    db.close();
}
