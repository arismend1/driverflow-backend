const db = require('./db_adapter');

(async () => {
    console.log('--- Migrating: Strict ticket.match_id (NOT NULL + UNIQUE) ---');

    try {
        // 1. Ensure match_id column exists
        try {
            await db.run('ALTER TABLE tickets ADD COLUMN match_id INTEGER');
            console.log('✅ Added tickets.match_id column');
        } catch (e) {
            if (e.message.includes('already exists') || e.message.includes('duplicate column')) {
                console.log('⚠️ tickets.match_id already exists');
            } else {
                console.error('❌ Error adding column:', e.message);
            }
        }

        // 2. Drop the old partial index
        try {
            await db.run('DROP INDEX IF EXISTS uniq_tickets_match_id');
            console.log('✅ Dropped partial index uniq_tickets_match_id');
        } catch (e) {
            console.log('⚠️ Drop index skipped:', e.message);
        }

        // 3. Delete orphan tickets (match_id = NULL)
        const deleted = await db.run('DELETE FROM tickets WHERE match_id IS NULL');
        console.log('✅ Deleted orphan tickets with match_id = NULL');

        // 4. Set NOT NULL + UNIQUE (PostgreSQL)
        if (db.IS_POSTGRES) {
            // Drop old constraint if exists
            try {
                await db.run('ALTER TABLE tickets DROP CONSTRAINT IF EXISTS unique_match_ticket');
            } catch (e) { /* ignore */ }
            try {
                await db.run('ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_match_id_unique');
            } catch (e) { /* ignore */ }

            // SET NOT NULL
            await db.run('ALTER TABLE tickets ALTER COLUMN match_id SET NOT NULL');
            console.log('✅ tickets.match_id SET NOT NULL');

            // ADD UNIQUE constraint
            await db.run('ALTER TABLE tickets ADD CONSTRAINT tickets_match_id_unique UNIQUE (match_id)');
            console.log('✅ Added UNIQUE constraint tickets_match_id_unique');
        } else {
            // SQLite: Create a regular unique index (SQLite doesn't support ALTER COLUMN SET NOT NULL)
            try {
                await db.run('CREATE UNIQUE INDEX IF NOT EXISTS tickets_match_id_unique ON tickets(match_id)');
                console.log('✅ Created UNIQUE index on tickets.match_id (SQLite)');
            } catch (e) {
                console.log('⚠️ SQLite unique index:', e.message);
            }
        }

        // 5. Verify
        const count = await db.get('SELECT COUNT(*) as cnt FROM tickets WHERE match_id IS NULL');
        console.log(`ℹ️ Tickets with NULL match_id: ${count ? count.cnt : 0}`);

        const total = await db.get('SELECT COUNT(*) as cnt FROM tickets');
        console.log(`ℹ️ Total tickets: ${total ? total.cnt : 0}`);

        console.log('✅ Migration complete');
        process.exit(0);
    } catch (e) {
        console.error('❌ Migration error:', e);
        process.exit(1);
    }
})();
