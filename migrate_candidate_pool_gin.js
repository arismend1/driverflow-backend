/**
 * Migration: GIN indexes for SQL-level overlap filtering
 *
 * These indexes support the && (array overlap) operator used in
 * lazy_matching.js candidate pool queries. The expression matches
 * exactly what the WHERE clause uses: strip JSON brackets/quotes,
 * lowercase, split by comma.
 */

const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: GIN indexes for candidate pool overlap ---');

    const indexes = [
        // GIN indexes for array overlap on TEXT columns (company_requirements)
        {
            name: 'idx_cr_req_op_types_gin',
            sql: `CREATE INDEX IF NOT EXISTS idx_cr_req_op_types_gin
                  ON company_requirements USING gin (
                      regexp_split_to_array(LOWER(TRIM(REPLACE(REPLACE(REPLACE(COALESCE(req_operation_types,''),'"',''),'[',''),']',''))), '\\s*,\\s*')
                  )`
        },
        {
            name: 'idx_cr_req_licenses_gin',
            sql: `CREATE INDEX IF NOT EXISTS idx_cr_req_licenses_gin
                  ON company_requirements USING gin (
                      regexp_split_to_array(LOWER(TRIM(REPLACE(REPLACE(REPLACE(COALESCE(req_license_types,''),'"',''),'[',''),']',''))), '\\s*,\\s*')
                  )`
        },

        // GIN indexes for array overlap on TEXT columns (drivers)
        {
            name: 'idx_drivers_op_types_gin',
            sql: `CREATE INDEX IF NOT EXISTS idx_drivers_op_types_gin
                  ON drivers USING gin (
                      regexp_split_to_array(LOWER(TRIM(REPLACE(REPLACE(REPLACE(COALESCE(operation_types,''),'"',''),'[',''),']',''))), '\\s*,\\s*')
                  )`
        },
        {
            name: 'idx_drivers_licenses_gin',
            sql: `CREATE INDEX IF NOT EXISTS idx_drivers_licenses_gin
                  ON drivers USING gin (
                      regexp_split_to_array(LOWER(TRIM(REPLACE(REPLACE(REPLACE(COALESCE(license_types,''),'"',''),'[',''),']',''))), '\\s*,\\s*')
                  )`
        },

        // B-tree indexes for search_status filters
        {
            name: 'idx_empresas_search_status',
            sql: 'CREATE INDEX IF NOT EXISTS idx_empresas_search_status ON empresas(search_status)'
        },
        {
            name: 'idx_drivers_search_status',
            sql: 'CREATE INDEX IF NOT EXISTS idx_drivers_search_status ON drivers(search_status)'
        }
    ];

    for (const { name, sql } of indexes) {
        try {
            await db.run(sql);
            console.log(`✅ Index ${name} OK`);
        } catch (e) {
            if (e.message && e.message.includes('already exists')) {
                console.log(`⚠️ Index ${name} already exists`);
            } else {
                console.error(`❌ Index ${name} error: ${e.message}`);
            }
        }
    }

    console.log('✅ GIN index migration complete');
    process.exit(0);
})();
