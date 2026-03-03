const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: Double Consent & Consent Columns ---');

    async function addColumn(table, col, typeDef) {
        try {
            await db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${typeDef}`);
            console.log(`✅ Added ${table}.${col}`);
        } catch (e) {
            if (e.message.includes('already exists') || e.message.includes('duplicate column')) {
                console.log(`⚠️ Column ${table}.${col} already exists, skipping.`);
            } else {
                console.error(`❌ Error adding ${table}.${col}:`, e.message);
            }
        }
    }

    try {
        // 1. Add columns to potential_matches
        await addColumn('potential_matches', 'driver_step1_accepted_at', 'TEXT');
        await addColumn('potential_matches', 'company_step1_accepted_at', 'TEXT');
        await addColumn('potential_matches', 'driver_share_consent_at', 'TEXT');
        await addColumn('potential_matches', 'company_share_consent_at', 'TEXT');
        await addColumn('potential_matches', 'info_shared_at', 'TEXT');
        await addColumn('potential_matches', 'ticket_id', 'INTEGER');
        await addColumn('potential_matches', 'fee_cents', 'INTEGER DEFAULT 0');
        await addColumn('potential_matches', 'fee_currency', "TEXT DEFAULT 'USD'");
        await addColumn('potential_matches', 'updated_at', 'TEXT');

        // 2. Relax tickets constraint for request_id (NULL allowed)
        if (!db.IS_POSTGRES) {
            console.log('[SQLite] Relaxing tickets.request_id constraint via table recreation...');
            await db.run("PRAGMA foreign_keys=off");
            try {
                await db.run("BEGIN TRANSACTION");
                await db.run("DROP TABLE IF EXISTS tickets_new");
                await db.run(`
                    CREATE TABLE tickets_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        company_id INTEGER NOT NULL,
                        driver_id INTEGER NOT NULL,
                        request_id INTEGER, 
                        price_cents INTEGER NOT NULL,
                        currency TEXT NOT NULL DEFAULT 'USD',
                        billing_status TEXT NOT NULL DEFAULT 'pending' CHECK(billing_status IN ('pending', 'unbilled', 'billed', 'void')), 
                        created_at TEXT DEFAULT (datetime('now')),
                        updated_at TEXT,
                        billing_week TEXT, 
                        amount_cents INTEGER DEFAULT 0, 
                        paid_at TEXT, 
                        payment_ref TEXT, 
                        billing_notes TEXT, 
                        stripe_checkout_session_id TEXT, 
                        stripe_payment_intent_id TEXT, 
                        stripe_customer_id TEXT,
                        FOREIGN KEY (company_id) REFERENCES empresas(id),
                        FOREIGN KEY(driver_id) REFERENCES drivers(id),
                        FOREIGN KEY(request_id) REFERENCES solicitudes(id)
                    )
                `);
                await db.run(`
                    INSERT INTO tickets_new (id, company_id, driver_id, request_id, price_cents, currency, billing_status, created_at, updated_at, billing_week, amount_cents, paid_at, payment_ref, billing_notes, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id)
                    SELECT id, company_id, driver_id, request_id, price_cents, currency, billing_status, created_at, updated_at, billing_week, amount_cents, paid_at, payment_ref, billing_notes, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id FROM tickets
                `);
                await db.run("DROP TABLE tickets");
                await db.run("ALTER TABLE tickets_new RENAME TO tickets");
                await db.run("COMMIT");
                console.log('✅ SQLite tickets table recreated.');
            } catch (err) {
                await db.run("ROLLBACK");
                console.error('❌ SQLite recreation failed:', err.message);
            } finally {
                await db.run("PRAGMA foreign_keys=on");
            }
        } else {
            console.log('[Postgres] Relaxing tickets.request_id constraint...');
            try {
                await db.run('ALTER TABLE tickets ALTER COLUMN request_id DROP NOT NULL');
                try {
                    await db.run('ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_request_id_key');
                } catch (e) {
                    console.log('⚠️ Could not drop unique constraint:', e.message);
                }
                console.log('✅ Postgres tickets.request_id relaxed.');
            } catch (e) {
                console.log('⚠️ Postgres relaxation skipped/failed:', e.message);
            }
        }

        console.log('✅ Migration Matches Consent Complete');
        process.exit(0);
    } catch (e) {
        console.error('❌ Migration fatal error:', e);
        process.exit(1);
    }
})();
