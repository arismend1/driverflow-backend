const db = require('../db_adapter');

(async () => {
    console.log('--- [MIGRATION] COMPANY VERIFICATION Phase 3 ---');
    try {
        const queries = [
            "ALTER TABLE empresas ADD COLUMN verification_status TEXT DEFAULT 'pending';",
            "ALTER TABLE empresas ADD COLUMN verified_at TEXT;",
            "ALTER TABLE empresas ADD COLUMN rejected_reason TEXT;"
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
        
        // Create idempotency registry if it doesn't exist
        await db.run(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
        `);

        const MIGRATION_ID = 'grandfather_phase3_verification';

        const tx = await db.beginTransaction();
        try {
            // Select marker INSIDE the real transaction
            const applied = await tx.get(`SELECT id FROM schema_migrations WHERE id = ?`, MIGRATION_ID);

            if (!applied) {
                console.log('--- Grandfathering Existing Companies (Idempotent Transactional Run) ---');
                // Approve all companies currently in 'pending' status ONLY at the exact time of first launch
                await tx.run(`UPDATE empresas SET verification_status = 'approved', verified_at = CURRENT_TIMESTAMP WHERE verification_status = 'pending'`);
                
                // Mark as applied permanently
                await tx.run(`INSERT INTO schema_migrations (id, applied_at) VALUES (?, CURRENT_TIMESTAMP)`, MIGRATION_ID);
                
                // Commit the atomic boundary
                await tx.commit();
                console.log(`✅ Grandfathering successfully applied and committed. Migration marker '${MIGRATION_ID}' saved.`);
            } else {
                await tx.rollback();
                console.log(`⏭️ Grandfathering skipped. Migration marker '${MIGRATION_ID}' already present from previous execution.`);
            }
        } catch (txError) {
            await tx.rollback();
            console.error('❌ Transaction boundary failed mid-execution. Rolling back any uncommitted changes.');
            throw txError;
        }
        
        console.log('✅ Company Anti-Fake verification migration applied successfully.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    }
})();
