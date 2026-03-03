const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: tickets.match_id + Unique Partial Index ---');

    try {
        // 1. Add match_id column to tickets if it doesn't exist
        try {
            await db.run('ALTER TABLE tickets ADD COLUMN match_id INTEGER');
            console.log('✅ Added tickets.match_id');
        } catch (e) {
            if (e.message.includes('already exists') || e.message.includes('duplicate column')) {
                console.log('⚠️ tickets.match_id already exists, skipping.');
            } else {
                console.error('❌ Error adding tickets.match_id:', e.message);
            }
        }

        // 2. Drop old constraint if it exists (PostgreSQL only)
        if (db.IS_POSTGRES) {
            try {
                await db.run('ALTER TABLE tickets DROP CONSTRAINT IF EXISTS unique_match_ticket');
                console.log('✅ Dropped old constraint (if existed)');
            } catch (e) {
                console.log('⚠️ Old constraint drop skipped:', e.message);
            }
        }

        // 3. Create unique partial index (WHERE match_id IS NOT NULL)
        try {
            await db.run(`
                CREATE UNIQUE INDEX IF NOT EXISTS uniq_tickets_match_id
                ON tickets(match_id)
                WHERE match_id IS NOT NULL
            `);
            console.log('✅ Unique partial index uniq_tickets_match_id created');
        } catch (e) {
            console.log('⚠️ Index creation skipped:', e.message);
        }

        // 4. Report orphan tickets
        const orphans = await db.all("SELECT id, company_id, driver_id, amount_cents, match_id FROM tickets WHERE match_id IS NULL");
        console.log(`ℹ️ Orphan tickets (match_id=NULL): ${orphans.length}`);
        if (orphans.length > 0) {
            console.log(JSON.stringify(orphans));
        }

        console.log('✅ Migration ticket_match_unique Complete');
        process.exit(0);
    } catch (e) {
        console.error('❌ Migration fatal error:', e);
        process.exit(1);
    }
})();
