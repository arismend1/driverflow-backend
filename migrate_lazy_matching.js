const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: Lazy matching infrastructure ---');

    // 1. Cooldown table
    try {
        await db.run(`
            CREATE TABLE IF NOT EXISTS user_match_generation_log (
                user_id INTEGER NOT NULL,
                user_type TEXT NOT NULL,
                last_generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, user_type)
            )
        `);
        console.log('✅ Table user_match_generation_log created');
    } catch (e) {
        if (e.message.includes('already exists')) {
            console.log('⚠️ user_match_generation_log already exists');
        } else {
            console.error('❌ user_match_generation_log:', e.message);
        }
    }

    // 2. Performance indexes
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_pm_company_status_created ON potential_matches(company_id, status, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_pm_driver_status_created ON potential_matches(driver_id, status, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_cr_company_id ON company_requirements(company_id)',
        'CREATE INDEX IF NOT EXISTS idx_drivers_search_status ON drivers(search_status)',
        'CREATE INDEX IF NOT EXISTS idx_empresas_search_status ON empresas(search_status)'
    ];

    for (const sql of indexes) {
        try {
            await db.run(sql);
            const name = sql.match(/idx_\w+/)?.[0] || 'unknown';
            console.log(`✅ Index ${name} created`);
        } catch (e) {
            console.log(`⚠️ Index: ${e.message}`);
        }
    }

    // 3. Verify UNIQUE constraint on (company_id, driver_id)
    if (db.IS_POSTGRES) {
        const unique = await db.all(
            "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='potential_matches' AND indexdef ILIKE '%UNIQUE%'"
        );
        console.log('📋 UNIQUE indexes on potential_matches:', JSON.stringify(unique, null, 2));
    }

    console.log('✅ Migration complete');
    process.exit(0);
})();
