/**
 * Migration: Add indexes for candidate pool filtering (scalable matching)
 *
 * These indexes support the SQL hard filters in lazy_matching.js:
 *   - empresas.search_status for filtering active companies
 *   - drivers.search_status for filtering active drivers
 *   - drivers.has_truck for truck requirement filter
 *   - company_requirements.company_id for JOIN performance
 */

const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: Candidate pool indexes ---');

    const indexes = [
        // Company-side filters
        'CREATE INDEX IF NOT EXISTS idx_empresas_search_status ON empresas(search_status)',
        'CREATE INDEX IF NOT EXISTS idx_cr_company_id ON company_requirements(company_id)',

        // Driver-side filters
        'CREATE INDEX IF NOT EXISTS idx_drivers_search_status ON drivers(search_status)',
        'CREATE INDEX IF NOT EXISTS idx_drivers_has_truck ON drivers(has_truck) WHERE has_truck = true',

        // Cooldown unique constraint (if missing)
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_match_gen_unique ON user_match_generation_log(user_type, user_id)'
    ];

    for (const sql of indexes) {
        try {
            await db.run(sql);
            const name = sql.match(/idx_\w+/)?.[0] || 'unknown';
            console.log(`✅ Index ${name} OK`);
        } catch (e) {
            if (e.message && e.message.includes('already exists')) {
                const name = sql.match(/idx_\w+/)?.[0] || 'unknown';
                console.log(`⚠️ Index ${name} already exists`);
            } else {
                console.error(`❌ Index error: ${e.message}`);
            }
        }
    }

    console.log('✅ Candidate pool indexes migration complete');
    process.exit(0);
})();
