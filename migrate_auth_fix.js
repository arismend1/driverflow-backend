const db = require('./db_adapter');
// const Database = require('better-sqlite3'); // REMOVED
// const dbPath = process.env.DB_PATH || 'driverflow.db';
// const db = new Database(dbPath);

console.log(`[AUTH MIGRATION] Starting Migration (Async/Adapter Mode)`);

async function addColumn(table, col, type, defaultVal) {
    try {
        // PRAGMA table_info is SQLite specific. 
        // For Postgres compatibility without complex introspection, we try to add and ignore error
        // OR we just use a generic "ADD COLUMN IF NOT EXISTS" pattern which is engine specific.
        // EASIEST HYBRID: Try ADD COLUMN, catch "duplicate column" error.

        let sql = `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`;
        if (defaultVal !== undefined) sql += ` DEFAULT ${defaultVal}`;

        try {
            await db.run(sql);
            console.log(`✅ Added ${table}.${col}`);
        } catch (e) {
            if (e.message.includes('duplicate column') || e.message.includes('exists')) {
                console.log(`ℹ️  ${table}.${col} exists`);
            } else {
                throw e;
            }
        }

        /*  
         // OLD SQLITE INTROSPECTION
         const cols = db.prepare(`PRAGMA table_info(${table})`).all();
         if (!cols.find(c => c.name === col)) {
             // ...
         } 
        */
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
    { table: 'drivers', col: 'created_at', type: 'TEXT' },

    // EMPRESAS
    { table: 'empresas', col: 'verified', type: 'INTEGER', def: 0 },
    { table: 'empresas', col: 'verification_token', type: 'TEXT' },
    { table: 'empresas', col: 'verification_expires', type: 'TEXT' },
    { table: 'empresas', col: 'reset_token', type: 'TEXT' },
    { table: 'empresas', col: 'reset_expires', type: 'TEXT' },
    { table: 'empresas', col: 'search_status', type: 'TEXT', def: "'ON'" },
    { table: 'empresas', col: 'created_at', type: 'TEXT' },
    { table: 'empresas', col: 'legal_name', type: 'TEXT' },
    { table: 'empresas', col: 'address_line1', type: 'TEXT' },
    { table: 'empresas', col: 'city', type: 'TEXT' },
    { table: 'empresas', col: 'failed_attempts', type: 'INTEGER', def: 0 },
    { table: 'empresas', col: 'lockout_until', type: 'TEXT' },

    // DRIVERS (Append missing lockout cols)
    { table: 'drivers', col: 'failed_attempts', type: 'INTEGER', def: 0 },
    { table: 'drivers', col: 'lockout_until', type: 'TEXT' },

    // OUTBOX
    { table: 'events_outbox', col: 'ticket_id', type: 'INTEGER' }
];

(async () => {
    // 1. Ensure Tables Exist (Base Schema) - Using explicit CREATE IF NOT EXISTS which works in both usually
    // Note: AUTOINCREMENT is SQLite. SERIAL is PG. 
    // This script assumes tables exist via init_postgres_db.js for PG.
    // We only focus on ADDING COLUMNS here to fix schema drift.

    // 2. Add Columns
    for (const item of schema) {
        await addColumn(item.table, item.col, item.type, item.def);
    }

    console.log('[AUTH MIGRATION] Completed Successfully.');
    process.exit(0);
})();
