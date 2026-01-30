const db = require('../db_adapter');

async function migrate() {
    try {
        console.log('Beginning Phase 13 Migration: Stripe Automation...');

        // 1. Add columns to weekly_invoices
        console.log('Adding Stripe columns to weekly_invoices...');

        // We use a block to handle "column exists" errors gracefully in Postgres without PL/pgSQL if possible, 
        // but since we are using the adapter, we can just run ALTER TABLE IF NOT EXISTS logic or catch errors.
        // Postgres 9.6+ supports IF NOT EXISTS for columns? No, only recent versions.
        // We'll try-catch each column add.

        const columns = [
            'ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(100)',
            'ADD COLUMN IF NOT EXISTS failure_reason TEXT',
            'ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP',
            'ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0',
            'ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMP'
        ];

        for (const col of columns) {
            try {
                await db.exec(`ALTER TABLE weekly_invoices ${col};`);
                console.log(`Executed: ${col}`);
            } catch (e) {
                // Ignore "already exists" errors specifically, but log others
                if (e.message.includes('exists') || e.message.includes('duplicate')) {
                    console.log(`Skipped (exists): ${col}`);
                } else {
                    console.warn(`Warning executing ${col}:`, e.message);
                }
            }
        }

        // 2. Check companies table for stripe_customer_id
        console.log('Checking keys on companies table...');
        try {
            await db.exec(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(100);`);
            console.log('Ensured stripe_customer_id column exists on companies.');
        } catch (e) {
            if (e.message.includes('exists') || e.message.includes('duplicate')) {
                console.log('stripe_customer_id already exists.');
            } else {
                console.error('Error adding stripe_customer_id:', e);
            }
        }

        // 3. Create Index on stripe_payment_intent_id for lookups
        console.log('Creating index on stripe_payment_intent_id...');
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_weekly_invoices_stripe_pi ON weekly_invoices(stripe_payment_intent_id);`);

        console.log('Phase 13 Migration completed successfully.');
        process.exit(0);
    } catch (e) {
        console.error('Migration failed:', e);
        process.exit(1);
    }
}

migrate();
