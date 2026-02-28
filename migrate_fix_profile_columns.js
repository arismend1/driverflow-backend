const db = require('./db_adapter');

async function migrate() {
    console.log('[MIGRATION] Fixing driver profile column types (JSONB -> TEXT) in PostgreSQL...');

    if (db.IS_POSTGRES) {
        try {
            await db.run('ALTER TABLE drivers ALTER COLUMN updated_at TYPE TEXT USING updated_at::text');
            console.log('[MIGRATION] updated_at changed to TEXT successfully');
        } catch (e) {
            console.log(`[MIGRATION - SKIP] updated_at: ${e.message}`);
        }

        try {
            await db.run('ALTER TABLE drivers ALTER COLUMN experience_range TYPE TEXT USING experience_range::text');
            console.log('[MIGRATION] experience_range changed to TEXT successfully');
        } catch (e) {
            console.log(`[MIGRATION - SKIP] experience_range: ${e.message}`);
        }
    } else {
        console.log('[MIGRATION] SQLite used. Columns are already TEXT. Skipping...');
    }
}

if (require.main === module) {
    migrate().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = migrate;
