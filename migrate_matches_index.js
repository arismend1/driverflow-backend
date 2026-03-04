const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: Index on potential_matches(status, created_at) ---');

    try {
        await db.run(`
            CREATE INDEX IF NOT EXISTS idx_matches_status_created
            ON potential_matches(status, created_at)
        `);
        console.log('✅ Index idx_matches_status_created created');
    } catch (e) {
        console.log('⚠️ Index creation:', e.message);
    }

    console.log('✅ Migration complete');
    process.exit(0);
})();
