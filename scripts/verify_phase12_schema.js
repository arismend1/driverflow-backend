const db = require('../db_adapter');

async function verify() {
    console.log('🔍 Verifying Phase 12 Schema Constraints...');

    try {
        // Query pg_indexes to find the specific unique index
        let query;

        if (process.env.DATABASE_URL) {
            console.log('🌍 Connection: PostgreSQL (Production/Remote)');
            query = `
                SELECT indexname, indexdef 
                FROM pg_indexes 
                WHERE tablename = 'invoices';
            `;
        } else {
            console.log('💻 Connection: SQLite (Local)');
            query = `
                SELECT name, sql 
                FROM sqlite_master 
                WHERE type = 'index' 
                AND tbl_name = 'invoices';
            `;
        }

        // Run without params to avoid binding issues
        const results = await db.all(query);

        const targetIndex = 'idx_invoices_unique_period';
        const found = results.find(r => (r.indexname || r.name) === targetIndex);

        if (found) {
            console.log('✅ PASS: Unique index matches found.');
            console.log('   Index Name:', found.indexname || found.name);
            console.log('   Definition:', found.indexdef || found.sql);
        } else {
            console.error(`❌ FAIL: Unique index "${targetIndex}" NOT found.`);
            console.log('   Available Indexes:', results.map(r => r.indexname || r.name).join(', ') || 'None');
            process.exit(1);
        }

        // Also verify the table structure generally
        console.log('\n🔍 Checking Table Structure...');
        const tableCheck = process.env.DATABASE_URL
            ? "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'invoices';"
            : "PRAGMA table_info(invoices);";

        const columns = await db.all(tableCheck);
        console.log(`✅ Table invoices has ${columns.length} columns.`);
        if (columns.length === 0) {
            console.error('❌ FAIL: Table invoices appears to be missing or empty (0 columns).');
            process.exit(1);
        }

        process.exit(0);

    } catch (err) {
        console.error('❌ Error during verification:', err);
        process.exit(1);
    }
}

verify();
