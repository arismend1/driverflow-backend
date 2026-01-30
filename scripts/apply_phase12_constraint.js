const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

if (!process.env.DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL is missing or empty.');
    console.error('The script cannot connect to Production DB because the environment variable is not set.');
    console.error('Please rerun the command prepending the variable (PowerShell example):');
    console.error('    $env:DATABASE_URL="postgresql://user:pass@host/db"; node scripts/apply_phase12_constraint.js');
    process.exit(1);
}

const db = require('../db_adapter');

async function run() {
    console.log('🔄 Applying Phase 12 Unique Constraint...');

    if (process.env.DATABASE_URL) {
        console.log('✅ DATABASE_URL is set (Targeting Production/Postgres).');
    } else {
        console.warn('⚠️ WARNING: DATABASE_URL is NOT set. This might run against local SQLite.');
    }

    try {
        const sql = `
            CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_invoices_unique_company_week 
            ON weekly_invoices(company_id, week_start);
        `;

        // Using exec() as it is designed for DDL scripts in db_adapter
        // Note: db_adapter.exec() handles both Postgres and SQLite
        await db.exec(sql);

        console.log('✅ Success: Unique index created/verified on weekly_invoices.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error applying constraint:', error);
        process.exit(1);
    }
}

run();
