const db = require('../db_adapter');

async function migrate() {
    try {
        console.log('Beginning Phase 11 Migration: Weekly Billing (Sequential)...');

        console.log('Creating weekly_invoices table...');
        await db.exec(`
            CREATE TABLE IF NOT EXISTS weekly_invoices (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES companies(id),
                week_start DATE NOT NULL,
                week_end DATE NOT NULL,
                total_requests INTEGER DEFAULT 0,
                active_drivers INTEGER DEFAULT 0,
                amount_cents INTEGER DEFAULT 0,
                currency VARCHAR(3) DEFAULT 'mxn',
                status VARCHAR(20) DEFAULT 'pending', 
                stripe_invoice_id VARCHAR(100),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(company_id, week_start)
            );
        `);
        console.log('Table created.');

        console.log('Creating index on status...');
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_weekly_invoices_status ON weekly_invoices(status);`);

        console.log('Creating index on company_id...');
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_weekly_invoices_company ON weekly_invoices(company_id);`);

        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (e) {
        console.error('Migration failed:', e);
        process.exit(1);
    }
}

migrate();
