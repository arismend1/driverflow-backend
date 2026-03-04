/**
 * Migration: Archive table + partial unique index for potential_matches retention
 */

const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: Match retention infrastructure ---');

    // 1) Archive table (same structure as potential_matches, no data)
    try {
        await db.run(`
            CREATE TABLE IF NOT EXISTS potential_matches_archive (LIKE potential_matches INCLUDING ALL)
        `);
        console.log('✅ Table potential_matches_archive created');
    } catch (e) {
        if (e.message && e.message.includes('already exists')) {
            console.log('⚠️ potential_matches_archive already exists');
        } else {
            // Fallback: CREATE TABLE AS SELECT ... WHERE false
            try {
                await db.run(`
                    CREATE TABLE IF NOT EXISTS potential_matches_archive AS
                    SELECT * FROM potential_matches WHERE false
                `);
                console.log('✅ Table potential_matches_archive created (fallback)');
            } catch (e2) {
                if (e2.message && e2.message.includes('already exists')) {
                    console.log('⚠️ potential_matches_archive already exists');
                } else {
                    console.error('❌ potential_matches_archive:', e2.message);
                }
            }
        }
    }

    // 2) Partial unique index: only one active match per (driver, company) pair
    try {
        await db.run(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_match
            ON potential_matches(driver_id, company_id)
            WHERE status NOT IN ('DECLINED','EXPIRED')
        `);
        console.log('✅ Index idx_unique_active_match created');
    } catch (e) {
        if (e.message && e.message.includes('already exists')) {
            console.log('⚠️ idx_unique_active_match already exists');
        } else {
            console.error('❌ idx_unique_active_match:', e.message);
        }
    }

    // 3) Index on archive table for querying
    try {
        await db.run(`
            CREATE INDEX IF NOT EXISTS idx_archive_driver_company
            ON potential_matches_archive(driver_id, company_id)
        `);
        console.log('✅ Index idx_archive_driver_company created');
    } catch (e) {
        console.log('⚠️ Archive index:', e.message);
    }

    console.log('✅ Match retention migration complete');
    process.exit(0);
})();
