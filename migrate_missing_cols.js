const db = require('./database');

try {
    console.log('--- Migrating: Adding missing block columns ---');

    // Helper
    const addCol = (table, col, def) => {
        const info = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!info.some(c => c.name === col)) {
            try {
                db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
                console.log(`✅ Added ${col} to ${table}`);
            } catch (e) { console.log(`⚠️ Skip ${col} on ${table}: ${e.message}`); }
        }
    };

    ['empresas', 'drivers'].forEach(table => {
        addCol(table, 'is_blocked', 'INTEGER DEFAULT 0');
        addCol(table, 'blocked_reason', 'TEXT');
        addCol(table, 'blocked_at', 'TEXT');
        addCol(table, 'failed_attempts', 'INTEGER DEFAULT 0');
        addCol(table, 'lockout_until', 'TEXT');
    });

} catch (error) {
    console.error('❌ Error in migration:', error.message);
}
