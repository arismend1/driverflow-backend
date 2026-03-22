const db = require('./db_adapter');

(async () => {
    console.log('--- [MIGRATION] LEGAL CONSENT COLUMNS ---');
    try {
        const queries = [
            "ALTER TABLE drivers ADD COLUMN accepted_terms_at TEXT;",
            "ALTER TABLE drivers ADD COLUMN accepted_privacy_at TEXT;",
            "ALTER TABLE drivers ADD COLUMN legal_version TEXT;",
            "ALTER TABLE empresas ADD COLUMN accepted_terms_at TEXT;",
            "ALTER TABLE empresas ADD COLUMN accepted_privacy_at TEXT;",
            "ALTER TABLE empresas ADD COLUMN legal_version TEXT;"
        ];

        for (const sql of queries) {
            try {
                await db.run(sql);
                console.log(`✅ Success: ${sql}`);
            } catch (e) {
                if (e.message && (e.message.includes('duplicate column') || e.message.includes('already exists'))) {
                    console.log(`⏭️ Skipped (already exists): ${sql}`);
                } else {
                    console.error(`⚠️ Warning: ${sql} -> ${e.message}`);
                }
            }
        }
        
        console.log('✅ Legal compliance migration applied successfully.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    }
})();
