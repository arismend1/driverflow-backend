/**
 * Migration: driver_leads table for lead management + claim flow
 */

const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: driver_leads table ---');

    // 1) Create table
    try {
        await db.run(`
            CREATE TABLE IF NOT EXISTS driver_leads (
                id SERIAL PRIMARY KEY,
                company_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
                name TEXT NOT NULL DEFAULT '',
                phone TEXT NULL,
                email TEXT NULL,
                notes TEXT NULL,
                status TEXT NOT NULL DEFAULT 'NEW',
                claim_token TEXT NULL UNIQUE,
                claimed_driver_id INTEGER NULL REFERENCES drivers(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        console.log('✅ Table driver_leads created');
    } catch (e) {
        if (e.message && e.message.includes('already exists')) {
            console.log('⚠️ driver_leads already exists');
        } else {
            console.error('❌ driver_leads:', e.message);
        }
    }

    // 2) Indexes
    const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_driver_leads_company_status_created
         ON driver_leads(company_id, status, created_at DESC)`,

        `CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_leads_company_email
         ON driver_leads(company_id, LOWER(email))
         WHERE email IS NOT NULL AND email <> ''`,

        `CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_leads_company_phone
         ON driver_leads(company_id, phone)
         WHERE phone IS NOT NULL AND phone <> ''`,

        `CREATE INDEX IF NOT EXISTS idx_driver_leads_email_status
         ON driver_leads(LOWER(email), status)
         WHERE email IS NOT NULL AND email <> ''`,

        `CREATE INDEX IF NOT EXISTS idx_driver_leads_phone_status
         ON driver_leads(phone, status)
         WHERE phone IS NOT NULL AND phone <> ''`
    ];

    for (const sql of indexes) {
        try {
            await db.run(sql);
            const name = sql.match(/idx_\w+/)?.[0] || 'unknown';
            console.log(`✅ Index ${name} OK`);
        } catch (e) {
            if (e.message && e.message.includes('already exists')) {
                console.log(`⚠️ Index already exists`);
            } else {
                console.error(`❌ Index error: ${e.message}`);
            }
        }
    }

    console.log('✅ driver_leads migration complete');
    process.exit(0);
})();
