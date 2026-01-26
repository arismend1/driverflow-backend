const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || 'driverflow.db';
const db = new Database(dbPath);
console.log(`Using DB: ${dbPath}`);

console.log('--- Migrating for Email Verification ---');

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
    // verified: 0 (false), 1 (true) - Default 1 for existing users to avoid blocking them, 0 for new?
    // Plan said: "I will default existing users to verified=1"
    addColumn(table, 'verified', 'INTEGER DEFAULT 1');
    addColumn(table, 'verification_token', 'TEXT');
    addColumn(table, 'verification_expires', 'TEXT');
});

console.log('--- Migration Complete ---');
