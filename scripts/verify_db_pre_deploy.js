const db = require('../db_adapter');

async function verifyPreDeploySchema() {
    console.log('--- PRE-DEPLOY SCHEMA VERIFICATION ---');
    try {
        // [1] Index on tickets
        const ticketsIdx = await db.all(`
            SELECT indexname FROM pg_indexes 
            WHERE tablename = 'tickets' AND indexname = 'idx_tickets_billing';
        `);
        console.log(`- Index idx_tickets_billing: ${ticketsIdx.length > 0 ? '✅ EXISTS' : '❌ MISSING (Needs creation)'}`);

        // [2] Unique(ticket_id) in invoice_items
        const itemsUnique = await db.all(`
            SELECT conname FROM pg_constraint 
            WHERE conrelid = 'invoice_items'::regclass AND contype = 'u' AND (
                SELECT array_agg(attname) FROM pg_attribute 
                WHERE attrelid = 'invoice_items'::regclass AND attnum = ANY(conkey)
            ) @> ARRAY['ticket_id']::name[];
        `);
        console.log(`- UNIQUE(ticket_id) on invoice_items: ${itemsUnique.length > 0 ? '✅ EXISTS' : '❌ MISSING'}`);

        // [3] Partial Index on jobs_queue
        const jobsIdx = await db.all(`
            SELECT indexname FROM pg_indexes 
            WHERE tablename = 'jobs_queue' AND indexname = 'uniq_job_idempotency';
        `);
        console.log(`- Partial Unique Index on jobs_queue: ${jobsIdx.length > 0 ? '✅ EXISTS' : '❌ MISSING'}`);

        // [4] updated_at in invoices
        const invCols = await db.all(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'invoices' AND column_name = 'updated_at';
        `);
        console.log(`- updated_at in invoices: ${invCols.length > 0 ? '✅ EXISTS' : '❌ MISSING'}`);

        console.log('\n--- VERDICT ---');
        if (ticketsIdx.length > 0 && itemsUnique.length > 0 && jobsIdx.length > 0 && invCols.length > 0) {
            console.log('🚀 DB READY FOR DEPLOY');
        } else {
            console.log('🛑 DB SCHEMA NOT READY');
        }

    } catch (e) {
        // Fallback for non-postgres or specific errors
        console.error('Audit Error:', e.message);
    } finally {
        db.close();
        process.exit(0);
    }
}

verifyPreDeploySchema();
