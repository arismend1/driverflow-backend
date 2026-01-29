const db = require('./db_adapter');

console.log('--- [PROD MIGRATION] CONSSOLIDATED SCHEMA FIX ---');

(async () => {
    try {
        // --- PHASE 3: OBSERVABILITY ---
        console.log('Migrating: Observability...');
        // metrics_snapshot
        await db.run(`
            CREATE TABLE IF NOT EXISTS metrics_snapshot (
                id SERIAL PRIMARY KEY, -- Postgres SERIAL
                timestamp TEXT NOT NULL,
                name TEXT NOT NULL,
                value REAL,
                tags TEXT
            )
        `);

        // --- PHASE 4: BILLING ---
        console.log('Migrating: Billing...');
        // tickets
        await db.run(`
            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                request_id INTEGER,
                company_id INTEGER,
                driver_id INTEGER,
                price_cents INTEGER,
                amount_cents INTEGER, -- Fallback
                currency TEXT DEFAULT 'usd',
                billing_status TEXT DEFAULT 'pending', -- pending, paid, void, failed
                created_at TEXT,
                paid_at TEXT,
                payment_ref TEXT,
                billing_notes TEXT,
                stripe_checkout_session_id TEXT,
                stripe_payment_intent_id TEXT,
                stripe_customer_id TEXT,
                updated_at TEXT
            )
        `);

        // invoices
        await db.run(`
             CREATE TABLE IF NOT EXISTS invoices (
                id SERIAL PRIMARY KEY,
                company_id INTEGER,
                status TEXT DEFAULT 'draft', -- draft, open, paid, void, uncollectible
                total_cents INTEGER DEFAULT 0,
                currency TEXT DEFAULT 'usd',
                issue_date TEXT,
                due_date TEXT,
                paid_at TEXT,
                paid_method TEXT,
                external_id TEXT, -- Stripe Invoice ID
                pdf_url TEXT,
                created_at TEXT
            )
        `);

        // invoice_items
        await db.run(`
            CREATE TABLE IF NOT EXISTS invoice_items (
                id SERIAL PRIMARY KEY,
                invoice_id INTEGER,
                ticket_id INTEGER,
                description TEXT,
                amount_cents INTEGER,
                currency TEXT
            )
        `);

        // credit_notes
        await db.run(`
            CREATE TABLE IF NOT EXISTS credit_notes (
                id SERIAL PRIMARY KEY,
                company_id INTEGER,
                invoice_id INTEGER,
                amount_cents INTEGER,
                reason TEXT,
                created_at TEXT
            )
        `);

        // --- PHASE 5: STRIPE, RATINGS, QUEUE, ADMIN ---
        console.log('Migrating: Stripe & Ratings...');

        // stripe_webhook_events
        await db.run(`
            CREATE TABLE IF NOT EXISTS stripe_webhook_events (
                id SERIAL PRIMARY KEY,
                stripe_event_id TEXT UNIQUE,
                type TEXT,
                created_at TEXT,
                processed_at TEXT,
                status TEXT DEFAULT 'pending',
                last_error TEXT
            )
        `);

        // ratings
        await db.run(`
            CREATE TABLE IF NOT EXISTS ratings (
                id SERIAL PRIMARY KEY,
                request_id INTEGER,
                ticket_id INTEGER,
                from_type TEXT, -- empresa, driver
                from_id INTEGER,
                to_type TEXT,
                to_id INTEGER,
                score INTEGER,
                comment TEXT,
                created_at TEXT
            )
        `);

        // jobs_queue
        await db.run(`
            CREATE TABLE IF NOT EXISTS jobs_queue (
                id SERIAL PRIMARY KEY,
                job_type TEXT NOT NULL,
                payload TEXT,
                status TEXT DEFAULT 'pending',
                created_at TEXT,
                updated_at TEXT,
                attempts INTEGER DEFAULT 0,
                last_error TEXT,
                run_after TEXT
            )
        `);

        // worker_heartbeat
        await db.run(`
             CREATE TABLE IF NOT EXISTS worker_heartbeat (
                worker_name TEXT PRIMARY KEY,
                last_seen TEXT,
                status TEXT
            )
        `);

        // admin_users
        await db.run(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'admin',
                created_at TEXT NOT NULL
            )
        `);

        // admin_audit_log
        await db.run(`
             CREATE TABLE IF NOT EXISTS admin_audit_log (
                id SERIAL PRIMARY KEY,
                admin_id INTEGER,
                action TEXT NOT NULL,
                target_resource TEXT,
                target_id TEXT,
                ip_address TEXT,
                timestamp TEXT NOT NULL
            )
        `);

        // request_visibility (Phase 4/7)
        await db.run(`
             CREATE TABLE IF NOT EXISTS request_visibility (
                id SERIAL PRIMARY KEY,
                request_id INTEGER,
                driver_id INTEGER,
                ronda INTEGER,
                created_at TEXT
            )
        `);

        console.log('✅ [PROD MIGRATION] Schema Verification Complete');
        process.exit(0);

    } catch (e) {
        console.error('❌ [PROD MIGRATION] Failed:', e);
        process.exit(1);
    }
})();
