require('dotenv').config();
const { Pool } = require('pg');

console.log('DB URL Length:', process.env.DATABASE_URL ? process.env.DATABASE_URL.length : 'Missing');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // ssl: { rejectUnauthorized: false } // Disabled based on error
});

async function initDB() {
    try {
        console.log('Connecting to PostgreSQL...');
        const client = await pool.connect();
        console.log('Connected!');

        try {
            await client.query('BEGIN');

            // --- USERS ---
            await client.query(`
                CREATE TABLE IF NOT EXISTS drivers (
                    id SERIAL PRIMARY KEY,
                    nombre TEXT,
                    contacto TEXT UNIQUE,
                    password_hash TEXT,
                    tipo_licencia TEXT,
                    status TEXT DEFAULT 'active',
                    estado TEXT DEFAULT 'DISPONIBLE',
                    search_status TEXT DEFAULT 'ON',
                    rating_avg NUMERIC DEFAULT 0,
                    suspension_reason TEXT,
                    failed_attempts INTEGER DEFAULT 0,
                    lockout_until TEXT,
                    created_at TEXT,
                    verified INTEGER DEFAULT 0,
                    verification_token TEXT,
                    verification_expires TEXT,
                    reset_token TEXT,
                    reset_expires TEXT
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS empresas (
                    id SERIAL PRIMARY KEY,
                    nombre TEXT,
                    contacto TEXT UNIQUE,
                    password_hash TEXT,
                    legal_name TEXT,
                    address_line1 TEXT,
                    city TEXT,
                    ciudad TEXT,
                    search_status TEXT DEFAULT 'ON',
                    is_blocked INTEGER DEFAULT 0,
                    blocked_reason TEXT,
                    blocked_at TEXT,
                    failed_attempts INTEGER DEFAULT 0,
                    lockout_until TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    stripe_customer_id TEXT,
                    billing_suspended BOOLEAN DEFAULT FALSE,
                    verified INTEGER DEFAULT 0,
                    verification_token TEXT,
                    verification_expires TEXT,
                    reset_token TEXT,
                    reset_expires TEXT
                );
            `);

            // --- CORE LOGIC ---
            await client.query(`
                CREATE TABLE IF NOT EXISTS solicitudes (
                    id SERIAL PRIMARY KEY,
                    empresa_id INTEGER,
                    driver_id INTEGER,
                    estado TEXT DEFAULT 'PENDIENTE',
                    licencia_req TEXT,
                    ubicacion TEXT,
                    tiempo_estimado TEXT,
                    fecha_creacion TEXT,
                    fecha_expiracion TEXT,
                    fecha_cierre TEXT,
                    cancelado_por TEXT
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS tickets (
                    id SERIAL PRIMARY KEY,
                    request_id INTEGER,
                    company_id INTEGER,
                    driver_id INTEGER,
                    price_cents INTEGER,
                    currency TEXT DEFAULT 'USD',
                    billing_status TEXT DEFAULT 'unbilled',
                    created_at TEXT,
                    updated_at TEXT
                );
            `);

            // --- BILLING ---
            await client.query(`
                CREATE TABLE IF NOT EXISTS invoices (
                    id SERIAL PRIMARY KEY,
                    company_id INTEGER NOT NULL,
                    week_start DATE NOT NULL,
                    week_end DATE NOT NULL,
                    billing_week TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','charging','retrying','failed','suspended','charged')),
                    currency TEXT NOT NULL DEFAULT 'USD',
                    subtotal_cents INTEGER NOT NULL DEFAULT 0,
                    total_cents INTEGER NOT NULL DEFAULT 0,
                    issue_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    due_date TIMESTAMPTZ,
                    paid_at TIMESTAMPTZ,
                    paid_method TEXT,
                    failure_reason TEXT,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    last_attempt_at TIMESTAMPTZ,
                    next_retry_at TIMESTAMPTZ,
                    suspended_at TIMESTAMPTZ,
                    stripe_payment_intent_id TEXT,
                    stripe_charge_id TEXT,
                    receipt_url TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(company_id, week_start)
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS invoice_items (
                    id SERIAL PRIMARY KEY,
                    invoice_id INTEGER,
                    ticket_id INTEGER UNIQUE,
                    price_cents INTEGER,
                    description TEXT,
                    created_at TEXT
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS invoice_attempts (
                    id SERIAL PRIMARY KEY,
                    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
                    attempt_number INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    stripe_payment_intent_id TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS stripe_webhook_events (
                    stripe_event_id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    processed_at TIMESTAMPTZ,
                    last_error TEXT
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS credit_notes (
                    id SERIAL PRIMARY KEY,
                    company_id INTEGER,
                    price_cents INTEGER,
                    reason TEXT,
                    created_at TEXT
                );
            `);

            // --- EVENTS & QUEUE ---
            await client.query(`
                CREATE TABLE IF NOT EXISTS events_outbox (
                    id SERIAL PRIMARY KEY,
                    event_name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    company_id INTEGER,
                    driver_id INTEGER,
                    request_id INTEGER,
                    ticket_id INTEGER,
                    metadata TEXT,
                    queue_status TEXT DEFAULT 'pending',
                    queued_at TEXT,
                    audience_type TEXT,
                    audience_id TEXT,
                    event_key TEXT
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS jobs_queue (
                    id SERIAL PRIMARY KEY,
                    job_type TEXT,
                    payload_json TEXT,
                    status TEXT DEFAULT 'pending',
                    run_at TEXT,
                    max_attempts INTEGER DEFAULT 5,
                    attempts INTEGER DEFAULT 0,
                    last_error TEXT,
                    locked_by TEXT,
                    locked_at TEXT,
                    created_at TEXT,
                    updated_at TEXT,
                    idempotency_key TEXT,
                    source_event_id INTEGER
                );
            `);

            // --- EXTRAS ---
            await client.query(`
                CREATE TABLE IF NOT EXISTS ratings (
                    id SERIAL PRIMARY KEY,
                    request_id INTEGER UNIQUE,
                    company_id INTEGER,
                    driver_id INTEGER,
                    rating INTEGER,
                    comment TEXT,
                    created_at TEXT
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS webhook_events (
                    id TEXT PRIMARY KEY,
                    provider TEXT,
                    received_at TEXT
                );
            `);

            await client.query(`CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_invoices_next_retry ON invoices(next_retry_at);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_invoices_stripe_pi ON invoices(stripe_payment_intent_id);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_invoice_attempts_invoice_id ON invoice_attempts(invoice_id);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status ON stripe_webhook_events(status);`);

            await client.query(`
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id SERIAL PRIMARY KEY,
                    action TEXT,
                    admin_user TEXT,
                    target_id INTEGER,
                    reason TEXT,
                    metadata TEXT,
                    created_at TEXT
                );
            `);

            await client.query('COMMIT');
            console.log('Schema initialized successfully!');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error initializing DB:', err);
    } finally {
        await pool.end();
    }
}

initDB();
