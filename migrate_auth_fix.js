const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || 'driverflow.db';
const db = new Database(dbPath);

console.log(`[AUTH MIGRATION] Starting on DB: ${dbPath}`);

function addColumn(table, col, type, defaultVal) {
    try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.find(c => c.name === col)) {
            let sql = `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`;
            if (defaultVal !== undefined) sql += ` DEFAULT ${defaultVal}`;
            db.prepare(sql).run();
            console.log(`✅ Added ${table}.${col}`);
        } else {
            console.log(`ℹ️  ${table}.${col} exists`);
        }
    } catch (e) {
        console.error(`❌ Error adding ${table}.${col}:`, e.message);
    }
}

const schema = [
    // DRIVERS
    { table: 'drivers', col: 'verified', type: 'INTEGER', def: 0 },
    { table: 'drivers', col: 'verification_token', type: 'TEXT' },
    { table: 'drivers', col: 'verification_expires', type: 'TEXT' },
    { table: 'drivers', col: 'reset_token', type: 'TEXT' },
    { table: 'drivers', col: 'reset_expires', type: 'TEXT' },
    { table: 'drivers', col: 'status', type: 'TEXT', def: "'active'" },
    { table: 'drivers', col: 'search_status', type: 'TEXT', def: "'ON'" },
    { table: 'drivers', col: 'estado', type: 'TEXT', def: "'DISPONIBLE'" },
    { table: 'drivers', col: 'created_at', type: 'TEXT' }, // Fix for legacy schema mismatch

    // EMPRESAS
    { table: 'empresas', col: 'verified', type: 'INTEGER', def: 0 },
    { table: 'empresas', col: 'verification_token', type: 'TEXT' },
    { table: 'empresas', col: 'verification_expires', type: 'TEXT' },
    { table: 'empresas', col: 'reset_token', type: 'TEXT' },
    { table: 'empresas', col: 'reset_expires', type: 'TEXT' },
    { table: 'empresas', col: 'search_status', type: 'TEXT', def: "'ON'" },
    { table: 'empresas', col: 'created_at', type: 'TEXT' }, // Fix for legacy schema mismatch
    { table: 'empresas', col: 'legal_name', type: 'TEXT' },
    { table: 'empresas', col: 'address_line1', type: 'TEXT' },
    { table: 'empresas', col: 'city', type: 'TEXT' },

    // OUTBOX
    { table: 'events_outbox', col: 'ticket_id', type: 'INTEGER' }
];

db.transaction(() => {
    // 1. Ensure Tables Exist (Base Schema)
    db.exec(`
        CREATE TABLE IF NOT EXISTS drivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT,
            contacto TEXT UNIQUE,
            password_hash TEXT,
            tipo_licencia TEXT,
            experience_level TEXT,
            status TEXT DEFAULT 'active',
            estado TEXT DEFAULT 'DISPONIBLE',
            search_status TEXT DEFAULT 'ON',
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS empresas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT,
            contacto TEXT UNIQUE,
            password_hash TEXT,
            legal_name TEXT,
            address_line1 TEXT,
            city TEXT,
            search_status TEXT DEFAULT 'ON',
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS events_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            company_id INTEGER,
            driver_id INTEGER,
            request_id INTEGER,
            ticket_id INTEGER,
            metadata TEXT,
            processed_at TEXT,
            process_status TEXT DEFAULT 'pending',
            last_error TEXT,
            send_attempts INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS tickets (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             company_id INTEGER,
             driver_id INTEGER,
             request_id INTEGER,
             price_cents INTEGER,
             currency TEXT,
             billing_status TEXT DEFAULT 'unbilled', 
             created_at TEXT,
             updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS solicitudes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER,
            driver_id INTEGER,
            licencia_req TEXT,
            ubicacion TEXT,
            tiempo_estimado TEXT,
            estado TEXT DEFAULT 'PENDIENTE',
            ronda_actual INTEGER DEFAULT 1,
            fecha_inicio_ronda TEXT,
            fecha_expiracion TEXT,
            fecha_cierre TEXT,
            cancelado_por TEXT
        );
         CREATE TABLE IF NOT EXISTS request_visibility (
            request_id INTEGER,
            driver_id INTEGER,
            ronda INTEGER
         );
    `);

    // 2. Add Columns
    for (const item of schema) {
        addColumn(item.table, item.col, item.type, item.def);
    }
})();

console.log('[AUTH MIGRATION] Completed Successfully.');
process.exit(0);
