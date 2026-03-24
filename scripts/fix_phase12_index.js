const db = require('../db_adapter');

async function fixIndex() {
    console.log('🔧 Fixing Phase 12 Index...');
    try {
        // Create the unique index if it doesn't exist
        await db.run(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_unique_period 
            ON invoices(company_id, week_start, week_end);
        `);
        console.log('✅ Index `idx_invoices_unique_period` created/verified.');
    } catch (e) {
        console.error('❌ Error creating index:', e);
        process.exit(1);
    }
}

if (require.main === module) {
    fixIndex();
}
