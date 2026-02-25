const db = require('./db_adapter');

console.log(`[AUTH MIGRATION] Starting Migration (Async/Adapter Mode)`);

let migrationError = false;

async function checkTableExists(table) {
    try {
        if (db.IS_POSTGRES) {
            // Postgres check
            const res = await db.get(`SELECT to_regclass('public.${table}') as exists`);
            return !!(res && res.exists);
        } else {
            // SQLite check
            const res = await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table);
            return !!res;
        }
    } catch (e) {
        console.error(`[AUTH MIGRATION] Error checking table ${table}:`, e.message);
        return false;
    }
}

async function addColumn(table, col, type, defaultVal) {
    try {
        let sql = `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`;
        if (defaultVal !== undefined) sql += ` DEFAULT ${defaultVal}`;

        try {
            await db.run(sql);
            console.log(`✅ Added ${table}.${col}`);
        } catch (e) {
            const msg = e.message.toLowerCase();
            if (msg.includes('duplicate column') || msg.includes('exists')) {
                console.log(`ℹ️  ${table}.${col} already exists`);
            } else {
                console.error(`❌ Error adding ${table}.${col}:`, e.message);
                migrationError = true;
            }
        }
    } catch (e) {
        console.error(`❌ Unexpected error for ${table}.${col}:`, e.message);
        migrationError = true;
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
    try {
        console.log(`[AUTH MIGRATION] Verifying required tables...`);
        const tablesRequired = ['drivers', 'empresas'];
        for (const table of tablesRequired) {
            const exists = await checkTableExists(table);
            if (!exists) {
                console.error(`[AUTH MIGRATION] FATAL: Required table '${table}' does not exist.`);
                process.exit(1);
            }
            console.log(`[AUTH MIGRATION] Table '${table}' detected.`);
        }

        // 2. Add Columns
        for (const item of schema) {
            await addColumn(item.table, item.col, item.type, item.def);
        }

        if (migrationError) {
            console.error('[AUTH MIGRATION] Completed with ERRORS.');
            process.exit(1);
        } else {
            console.log('[AUTH MIGRATION] Completed Successfully.');
            db.close();
            process.exit(0);
        }
    } catch (err) {
        console.error('[AUTH MIGRATION] FATAL ERROR:', err.message);
        process.exit(1);
    }
})();

