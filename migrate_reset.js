const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || 'driverflow.db';
const db = new Database(dbPath);

console.log(`--- Migrating Password Reset columns for ${dbPath} ---`);

function addColumn(table, col, def) {
    try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
        console.log(`✅ Added ${col} to ${table}`);
    } catch (err) {
        if (err.message.includes('duplicate column')) {
            console.log(`⚠️ Column ${col} already exists in ${table}`);
        } else {
            console.error(`❌ Error adding ${col} to ${table}:`, err.message);
        }
    }
}

const tables = ['drivers', 'empresas'];

tables.forEach(table => {
    addColumn(table, 'reset_token', 'TEXT');
    addColumn(table, 'reset_expires', 'TEXT');
});

console.log('--- Migration Complete ---');
