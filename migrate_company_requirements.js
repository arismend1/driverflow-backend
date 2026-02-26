const db = require('./db_adapter');

async function migrate() {
    console.log('[MIGRATION] Checking company_requirements table...');
    const table = 'company_requirements';

    let createSql = '';
    if (db.IS_POSTGRES) {
        createSql = `
      CREATE TABLE IF NOT EXISTS ${table} (
        company_id INT PRIMARY KEY,
        req_cdl BOOLEAN,
        req_license_types JSONB,
        req_endorsements JSONB,
        req_operation_types JSONB,
        req_modalities JSONB,
        req_truck BOOLEAN,
        offered_payment_methods JSONB,
        req_relationships JSONB,
        availability TEXT,
        req_experience_years INT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    } else {
        createSql = `
      CREATE TABLE IF NOT EXISTS ${table} (
        company_id INTEGER PRIMARY KEY,
        req_cdl BOOLEAN,
        req_license_types TEXT,
        req_endorsements TEXT,
        req_operation_types TEXT,
        req_modalities TEXT,
        req_truck BOOLEAN,
        offered_payment_methods TEXT,
        req_relationships TEXT,
        availability TEXT,
        req_experience_years INTEGER,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    }

    try {
        await db.exec(createSql);
        console.log(`[MIGRATION] Table '${table}' ready.`);
        process.exit(0);
    } catch (err) {
        console.error(`[MIGRATION] FATAL: Error creating '${table}':`, err.message);
        process.exit(1);
    }
}

migrate();
