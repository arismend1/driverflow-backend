const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: lead_funnel_events ---');

    // 1) Create table compatible with SQLite/Postgres
    try {
        if (db.IS_POSTGRES) {
            await db.run(`
                CREATE TABLE IF NOT EXISTS lead_funnel_events (
                    id SERIAL PRIMARY KEY,
                    lead_id INTEGER NULL,
                    driver_id INTEGER NULL,
                    company_id INTEGER NULL,
                    event_type TEXT NOT NULL,
                    metadata JSONB NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
        } else {
            await db.run(`
                CREATE TABLE IF NOT EXISTS lead_funnel_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    lead_id INTEGER NULL,
                    driver_id INTEGER NULL,
                    company_id INTEGER NULL,
                    event_type TEXT NOT NULL,
                    metadata TEXT NULL,
                    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
                )
            `);
        }
        console.log('✅ Table lead_funnel_events created');
    } catch (e) {
        console.error('❌ Error creating lead_funnel_events table:', e.message);
    }

    // 2) Create indexes
    const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_lfe_event_type_created_at ON lead_funnel_events(event_type, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_lfe_lead_id ON lead_funnel_events(lead_id) WHERE lead_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_lfe_driver_id ON lead_funnel_events(driver_id) WHERE driver_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_lfe_company_id ON lead_funnel_events(company_id) WHERE company_id IS NOT NULL`
    ];

    // For SQLite, standard indexes without WHERE might be safer if version is old, but 'WHERE' is supported in modern sqlite3
    for (let sql of indexes) {
        try {
            if (!db.IS_POSTGRES && sql.includes('WHERE')) {
                // Fallback: simplified index for SQLite just in case partial indexes cause issues
                sql = sql.split(' WHERE ')[0];
            }
            await db.run(sql);
            console.log(`✅ Index OK: ${sql.split(' ')[4]}`);
        } catch (e) {
            console.error(`❌ Index Error: ${e.message}`);
        }
    }

    console.log('✅ lead_funnel_events migration complete');
    process.exit(0);
})();
