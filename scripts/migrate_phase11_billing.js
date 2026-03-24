const path = require('path');
const db = require('../db_adapter');

async function migrate() {
    try {
        console.log('Beginning Phase 11 Migration: Weekly Billing...');

        // Create invoices table
        console.log('Creating invoices table...');

        const sql = `
            BEGIN;

            CREATE TABLE IF NOT EXISTS invoices (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES companies(id),
                week_start DATE NOT NULL,
                week_end DATE NOT NULL,
                total_requests INTEGER DEFAULT 0,
                active_drivers INTEGER DEFAULT 0,
                total_cents INTEGER DEFAULT 0,
                currency VARCHAR(3) DEFAULT 'mxn',
                status VARCHAR(20) DEFAULT 'pending', -- pending, invoiced, paid, failed, void
                stripe_invoice_id VARCHAR(100),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(company_id, week_start)
            );

            CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
            CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);

            COMMIT;
        `;

        await db.exec(sql);
        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (e) {
        console.error('Migration failed:', e);
        process.exit(1);
    }
}

migrate();
