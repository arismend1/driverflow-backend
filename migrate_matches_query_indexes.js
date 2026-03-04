const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: Match query indexes ---');

    const indexes = [
        {
            name: 'idx_pm_company_status_created',
            sql: 'CREATE INDEX IF NOT EXISTS idx_pm_company_status_created ON potential_matches(company_id, status, created_at DESC)'
        },
        {
            name: 'idx_pm_driver_status_created',
            sql: 'CREATE INDEX IF NOT EXISTS idx_pm_driver_status_created ON potential_matches(driver_id, status, created_at DESC)'
        }
    ];

    for (const idx of indexes) {
        try {
            await db.run(idx.sql);
            console.log(`✅ Index ${idx.name} created`);
        } catch (e) {
            console.log(`⚠️ ${idx.name}: ${e.message}`);
        }
    }

    console.log('✅ Migration complete');
    process.exit(0);
})();
