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
    { table: 'drivers', col: 'verified', type: 'INTEGER', def: 0 },
    { table: 'drivers', col: 'verification_token', type: 'TEXT' },
    { table: 'drivers', col: 'verification_expires', type: 'TEXT' },
    { table: 'drivers', col: 'reset_token', type: 'TEXT' },
    { table: 'drivers', col: 'reset_expires', type: 'TEXT' },

    { table: 'empresas', col: 'verified', type: 'INTEGER', def: 0 },
    { table: 'empresas', col: 'verification_token', type: 'TEXT' },
    { table: 'empresas', col: 'verification_expires', type: 'TEXT' },
    { table: 'empresas', col: 'reset_token', type: 'TEXT' },
    { table: 'empresas', col: 'reset_expires', type: 'TEXT' }
];

db.transaction(() => {
    for (const item of schema) {
        addColumn(item.table, item.col, item.type, item.def);
    }
})();

console.log('[AUTH MIGRATION] Completed Successfully.');
process.exit(0);
