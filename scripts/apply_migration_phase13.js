const fs = require('fs');
const path = require('path');
const db = require('../db_adapter');

const MIGRATION_FILE = path.join(__dirname, 'manual_migration_phase13_hardening.sql');

async function main() {
    console.log(`🔌 Connecting to DB (${db.IS_POSTGRES ? 'Postgres' : 'SQLite'})...`);
    console.log(`📄 Reading Migration File: ${MIGRATION_FILE}`);

    if (!fs.existsSync(MIGRATION_FILE)) {
        console.error('❌ Migration file not found!');
        process.exit(1);
    }

    const sql = fs.readFileSync(MIGRATION_FILE, 'utf-8');

    console.log('🚀 Executing Migration...');
    try {
        await db.exec(sql);
        console.log('✅ Migration Applied Successfully!');
        process.exit(0);
    } catch (e) {
        console.error('❌ Migration Failed:', e.message);
        console.error('Stack:', e.stack);
        process.exit(1);
    }
}

main();
