const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase Delinquency ---');

const addColumn = (table, colDef) => {
    try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colDef}`).run();
        console.log(`✅ Added column to ${table}: ${colDef.split(' ')[0]}`);
    } catch (e) {
        if (e.message.includes('duplicate column name')) {
            console.log(`⚠️ Column already exists in ${table}: ${colDef.split(' ')[0]}`);
        } else {
            console.error(`❌ Failed to add column to ${table}: ${colDef}`, e.message);
        }
    }
};

try {
    // invoices table
    // due_date TEXT, paid_at TEXT, paid_method TEXT
    addColumn('invoices', 'due_date TEXT');
    addColumn('invoices', 'paid_at TEXT');
    addColumn('invoices', 'paid_method TEXT');

    // empresas table
    // is_blocked INTEGER DEFAULT 0, blocked_reason TEXT, blocked_at TEXT
    addColumn('empresas', "is_blocked INTEGER NOT NULL DEFAULT 0");
    addColumn('empresas', "blocked_reason TEXT");
    addColumn('empresas', "blocked_at TEXT");

    console.log('✅ Migration Phase Delinquency complete.');

} catch (error) {
    console.error('❌ Migration failed:', error.message);
} finally {
    db.close();
}
