require('dotenv').config();
const Database = require('better-sqlite3');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// --- CONFIG ---
const SQLITE_PATH = process.env.DB_PATH || 'driverflow.db';
const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
    console.error("❌ ERROR: DATABASE_URL is missing in .env");
    process.exit(1);
}

const sqlite = new Database(SQLITE_PATH);
const pg = new Client({ connectionString: PG_URL, ssl: { rejectUnauthorized: false } });

// --- SCHEMA DEFINITION (Postgres Compatible) ---
const SCHEMA = [
    // 1. Core Users (No Dependencies)
    `CREATE TABLE IF NOT EXISTS empresas (
        id SERIAL PRIMARY KEY,
        nombre TEXT,
        email TEXT UNIQUE,
        password_hash TEXT,
        contact_name TEXT,
        contact_phone TEXT,
        city TEXT,
        state TEXT,
        tier TEXT,
        creditos INTEGER DEFAULT 0,
        is_blocked BOOLEAN DEFAULT FALSE,
        blocked_reason TEXT,
        blocked_at TIMESTAMPTZ,
        search_status TEXT,
        legal_name TEXT,
        address_line1 TEXT,
        address_state TEXT,
        contact_person TEXT,
        account_state TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        verified BOOLEAN DEFAULT FALSE,
        verification_token TEXT,
        verification_expires TIMESTAMPTZ,
        reset_token TEXT,
        reset_expires TIMESTAMPTZ,
        failed_attempts INTEGER DEFAULT 0,
        lockout_until TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS driver_profiles (
        driver_id INTEGER PRIMARY KEY, -- Will handle FK later or separate
        has_cdl BOOLEAN DEFAULT FALSE,
        license_types TEXT,
        endorsements TEXT,
        operation_types TEXT,
        experience_years INTEGER,
        experience_range TEXT,
        job_preferences TEXT,
        has_truck BOOLEAN DEFAULT FALSE,
        payment_methods TEXT,
        work_relationships TEXT,
        updated_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS drivers (
        id SERIAL PRIMARY KEY,
        nombre TEXT,
        email TEXT UNIQUE,
        password_hash TEXT,
        city TEXT,
        state TEXT,
        phone TEXT,
        status TEXT,
        push_token TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        verified BOOLEAN DEFAULT FALSE,
        verification_token TEXT,
        verification_expires TIMESTAMPTZ,
        reset_token TEXT,
        reset_expires TIMESTAMPTZ,
        failed_attempts INTEGER DEFAULT 0,
        lockout_until TIMESTAMPTZ,
        
        -- Legacy/Optional columns being migrated
        company_id INTEGER -- References empresas(id) conceptually
    )`,
    // 2. Core Business Entities (Depend on Users)
    `CREATE TABLE IF NOT EXISTS solicitudes (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER REFERENCES empresas(id),
        driver_id INTEGER, -- Nullable
        licencia_req TEXT,
        ubicacion TEXT,
        tiempo_estimado INTEGER,
        estado TEXT,
        fecha_creacion TIMESTAMPTZ,
        fecha_expiracion TIMESTAMPTZ,
        fecha_cierre TIMESTAMPTZ,
        cancelado_por TEXT,
        ronda_actual INTEGER DEFAULT 0,
        fecha_inicio_ronda TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES empresas(id),
        driver_id INTEGER REFERENCES drivers(id),
        status TEXT,
        score INTEGER,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES empresas(id),
        driver_id INTEGER REFERENCES drivers(id),
        request_id INTEGER REFERENCES solicitudes(id),
        price_cents INTEGER,
        currency TEXT,
        billing_status TEXT,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        billing_week TEXT,
        amount_cents INTEGER, -- Legacy duplicate?
        paid_at TIMESTAMPTZ,
        payment_ref TEXT,
        billing_notes TEXT,
        stripe_checkout_session_id TEXT,
        stripe_payment_intent_id TEXT,
        stripe_customer_id TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES empresas(id),
        billing_week TEXT,
        issue_date TIMESTAMPTZ,
        status TEXT,
        currency TEXT,
        subtotal_cents INTEGER,
        total_cents INTEGER,
        created_at TIMESTAMPTZ,
        due_date TIMESTAMPTZ,
        paid_at TIMESTAMPTZ,
        paid_method TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS invoice_items (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER REFERENCES invoices(id),
        ticket_id INTEGER REFERENCES tickets(id),
        price_cents INTEGER,
        created_at TIMESTAMPTZ
    )`,
    // 3. System/Infrastructure
    `CREATE TABLE IF NOT EXISTS events_outbox (
        id SERIAL PRIMARY KEY,
        event_name TEXT,
        created_at TIMESTAMPTZ,
        company_id INTEGER,
        driver_id INTEGER,
        request_id INTEGER,
        ticket_id INTEGER,
        metadata TEXT,
        processed BOOLEAN DEFAULT FALSE,
        processed_at TIMESTAMPTZ,
        process_status TEXT,
        last_error TEXT,
        send_attempts INTEGER DEFAULT 0,
        audience_type TEXT,
        audience_id TEXT,
        event_key TEXT,
        realtime_sent_at TIMESTAMPTZ,
        queue_status TEXT,
        queued_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS jobs_queue (
        id SERIAL PRIMARY KEY,
        job_type TEXT,
        payload_json TEXT,
        status TEXT,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 5,
        run_at TIMESTAMPTZ,
        locked_by TEXT,
        locked_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        idempotency_key TEXT,
        source_event_id INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS company_match_prefs (
        company_id INTEGER PRIMARY KEY REFERENCES empresas(id),
        req_license TEXT,
        req_experience TEXT,
        req_team_driving TEXT,
        req_start TEXT,
        req_restrictions TEXT,
        updated_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS worker_heartbeat (
        worker_name TEXT PRIMARY KEY,
        last_seen TIMESTAMPTZ,
        status TEXT,
        metadata TEXT
    )`
];

// --- HELPERS ---
function transformRow(table, row) {
    const newRow = { ...row };

    // Explicit transformations (Boolean, Date)
    const boolFields = [
        'is_blocked', 'verified', 'has_cdl', 'has_truck', 'processed',
        'tables_exist', 'worker_running'
    ];

    Object.keys(newRow).forEach(k => {
        // Boolean conversion (0/1 -> true/false)
        if (boolFields.includes(k) || (table === 'drivers' && k === 'verified') || (table === 'empresas' && k === 'verified')) {
            newRow[k] = !!newRow[k];
        }
        // Empty strings to NULL for dates? Postgres is picky with timestamps.
        // If empty string, set to null.
        if (typeof newRow[k] === 'string' && newRow[k] === '') {
            newRow[k] = null;
        }
    });

    return newRow;
}

async function migrate() {
    console.log("🚀 STARTING MIGRATION: SQLite -> Postgres");
    console.log(`📂 Source: ${SQLITE_PATH}`);
    console.log(`🐘 Target: ${PG_URL.split('@')[1]}`); // Hide creds

    await pg.connect();

    try {
        await pg.query('BEGIN');

        // 1. Create Schema
        console.log("🏗️  Building Schema...");
        // Drop all first to be clean?
        await pg.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

        for (const sql of SCHEMA) {
            await pg.query(sql);
        }

        // 2. Migrate Data
        // Order matters for FKs
        const TABLES = [
            'empresas', 'drivers', 'driver_profiles', 'company_match_prefs',
            'solicitudes', 'matches', 'tickets', 'invoices', 'invoice_items',
            'events_outbox', 'jobs_queue', 'worker_heartbeat'
        ];

        for (const table of TABLES) {
            console.log(`📦 Migrating ${table}...`);
            const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();

            if (rows.length === 0) continue;

            for (const row of rows) {
                const cleanRow = transformRow(table, row);
                const keys = Object.keys(cleanRow);
                const values = Object.values(cleanRow);

                const query = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`;
                try {
                    await pg.query(query, values);
                } catch (e) {
                    console.error(`❌ Failed to insert into ${table} (ID ${cleanRow.id}):`, e.message);
                    // console.error(cleanRow);
                    throw e;
                }
            }
            console.log(`   ✅ ${rows.length} rows migrated.`);

            // Reset Sequence if table has numeric ID
            if (['empresas', 'drivers', 'solicitudes', 'tickets', 'invoices', 'events_outbox', 'jobs_queue'].includes(table)) {
                await pg.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1)) FROM ${table}`);
            }
        }

        await pg.query('COMMIT');
        console.log("🎉 MIGRATION SUCCESSFUL!");

    } catch (e) {
        await pg.query('ROLLBACK');
        console.error("🔥 MIGRATION FAILED:", e);
    } finally {
        await pg.end();
        sqlite.close();
    }
}

migrate();
