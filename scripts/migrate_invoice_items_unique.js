const db = require('../db_adapter');

(async () => {
    try {
        console.log('--- Starting Migration: Unique Ticket ID in Invoice Items ---');
        
        // 1. Detección y limpieza de duplicados históricos (Agnóstico a BD)
        console.log('1. Cleaning up duplicate tickets (if any exist)...');
        await db.run(`
            DELETE FROM invoice_items 
            WHERE id NOT IN (
                SELECT MAX(id) FROM invoice_items GROUP BY ticket_id
            )
        `);
        console.log('   Cleanup complete.');

        // 2. Creación Idempotente del Constraint Único
        console.log('2. Applying UNIQUE constraint on ticket_id...');
        if (db.IS_POSTGRES) {
            // Verificación estructural dura contra el catálogo nativo (no confía en nombres, valida la columna física)
            const check = await db.get(`
                SELECT i.relname AS index_name
                FROM pg_class t
                JOIN pg_index ix ON t.oid = ix.indrelid
                JOIN pg_class i ON i.oid = ix.indexrelid
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
                WHERE t.relname = 'invoice_items'
                  AND a.attname = 'ticket_id'
                  AND ix.indisunique = true limit 1;
            `);

            if (!check) {
                await db.run(`ALTER TABLE invoice_items ADD CONSTRAINT uniq_inv_item_ticket UNIQUE(ticket_id)`);
                console.log('   [Postgres] Constraint uniq_inv_item_ticket created.');
            } else {
                console.log(`   [Postgres] Unique structural constraint already exists (${check.index_name}). Skipping.`);
            }
        } else {
            // SQLite IF NOT EXISTS es estructuralmente idempotente a nivel de motor.
            await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_items_ticket_uniq ON invoice_items(ticket_id)`);
            console.log('   [SQLite] Unique index verified/applied.');
        }

        console.log('✅ Migration strictly complete. Worker can safely use ON CONFLICT(ticket_id).');
        process.exit(0);
    } catch (e) {
        console.error('❌ Migration failed:', e);
        process.exit(1);
    }
})();
