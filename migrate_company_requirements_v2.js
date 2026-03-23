const db = require('./db_adapter');

async function migrate() {
    console.log('[MIGRATION] Adding home_time and offered_freight_types to company_requirements...');

    try {
        if (db.IS_POSTGRES) {
            await db.exec(`
                ALTER TABLE company_requirements ADD COLUMN IF NOT EXISTS home_time TEXT;
                ALTER TABLE company_requirements ADD COLUMN IF NOT EXISTS offered_freight_types TEXT;
            `);
        } else {
            // SQLite doesn't support ADD COLUMN IF NOT EXISTS easily in one go
            try { await db.exec("ALTER TABLE company_requirements ADD COLUMN home_time TEXT;"); } catch (e) { }
            try { await db.exec("ALTER TABLE company_requirements ADD COLUMN offered_freight_types TEXT;"); } catch (e) { }
        }
        console.log('[MIGRATION] Columns added successfully.');
        process.exit(0);
    } catch (err) {
        console.error('[MIGRATION] Error:', err.message);
        process.exit(1);
    }
}

migrate();
