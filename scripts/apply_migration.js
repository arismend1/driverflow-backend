const db = require('../db_adapter');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    try {
        const sqlPath = path.join(__dirname, 'manual_migration_phase13_hardening.sql');
        console.log(`[Migration] Leyendo archivo SQL: ${sqlPath}`);

        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log('[Migration] Ejecutando SQL en la base de datos...');
        await db.exec(sql);

        console.log('[Migration] ¡ÉXITO! La migración se ha aplicado correctamente.');
        process.exit(0);
    } catch (e) {
        console.error('[Migration] ERROR al aplicar la migración:', e);
        process.exit(1);
    }
}

runMigration();
