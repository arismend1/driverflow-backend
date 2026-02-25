const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase: Company Requirements ---');

try {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS company_requirements (
            company_id INTEGER PRIMARY KEY,
            req_cdl INTEGER DEFAULT 0,
            req_license_types TEXT DEFAULT '[]',
            req_endorsements TEXT DEFAULT '[]',
            req_operation_types TEXT DEFAULT '[]',
            req_modalities TEXT DEFAULT '[]',
            req_truck INTEGER DEFAULT 0,
            offered_payment_methods TEXT DEFAULT '[]',
            req_relationships TEXT DEFAULT '[]',
            availability TEXT DEFAULT 'Inmediata',
            req_experience_years INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES empresas(id)
        )
    `).run();
    console.log('✅ Created company_requirements table.');
} catch (error) {
    console.error('❌ Migration failed:', error.message);
} finally {
    db.close();
}
