/**
 * Integrity Migration: Fix Duplicate Tickets & Enforce Uniqueness
 * 1. Identifies match_id duplicates in the tickets table.
 * 2. Keeps only the oldest record (min ID) per match.
 * 3. Deletes redundant duplicates.
 * 4. Adds a UNIQUE index to prevent future double-ticketing.
 */
const db = require('./db_adapter');

async function migrate() {
    console.log('[MIGRATION] Starting Integrity Check: Duplicate Tickets...');

    try {
        // 1. Detect and Clean Duplicates
        console.log('[MIGRATION] Auditing tickets for duplicates...');

        const duplicates = await db.all(`
            SELECT match_id, COUNT(*) as count 
            FROM tickets 
            WHERE match_id IS NOT NULL 
            GROUP BY match_id 
            HAVING COUNT(*) > 1
        `);

        if (duplicates.length > 0) {
            console.log(`[MIGRATION] Found ${duplicates.length} matches with duplicate tickets.`);
            for (const dup of duplicates) {
                const matchId = dup.match_id;

                // Get all tickets for this match ordered by ID
                const allTickets = await db.all(
                    'SELECT id FROM tickets WHERE match_id = ? ORDER BY id ASC',
                    matchId
                );

                const keptId = allTickets[0].id;
                const redundantIds = allTickets.slice(1).map(t => t.id);

                console.log(`[MIGRATION] Match ${matchId}: Keeping ticket ${keptId}, deleting ${redundantIds.join(', ')}`);

                // Delete redundant ones
                for (const rid of redundantIds) {
                    await db.run('DELETE FROM tickets WHERE id = ?', rid);
                }
            }
            console.log('[MIGRATION] Data cleanup complete.');
        } else {
            console.log('[MIGRATION] No duplicate tickets found. Cleanup skipped.');
        }

        // 2. Create UNIQUE INDEX
        console.log('[MIGRATION] Enforcing uniqueness on tickets(match_id)...');

        if (db.IS_POSTGRES) {
            await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_match_id ON tickets(match_id)');
        } else {
            // For SQLite, we try to create the index, catching if it already exists
            try {
                await db.run('CREATE UNIQUE INDEX idx_tickets_match_id ON tickets(match_id)');
            } catch (e) {
                if (e.message.includes('already exists')) {
                    console.log('[MIGRATION] Unique index already exists in SQLite.');
                } else {
                    throw e;
                }
            }
        }

        console.log('[MIGRATION] Integrity stabilization completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error('[MIGRATION] FATAL Error during integrity migration:', err.message);
        process.exit(1);
    }
}

migrate();
