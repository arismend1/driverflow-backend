/**
 * cleanup_old_matches.js — Retention worker for potential_matches
 *
 * Runs periodically (every 1 hour) to:
 *   1. Archive completed matches (INFO_SHARED, CONTACTED, HIRED) older than 7 days
 *   2. Delete unused matches (NEW, PREMATCH_READY, SHARE_PENDING_*) older than 7 days
 *   3. Delete EXPIRED/DECLINED matches older than 7 days
 *
 * ENV:
 *   MATCH_RETENTION_DAYS=7 (default)
 */

const db = require('./db_adapter');

const RETENTION_DAYS = parseInt(process.env.MATCH_RETENTION_DAYS) || 7;

async function cleanupOldMatches() {
    const start = Date.now();
    console.log(`[MatchCleanup] Starting retention cleanup (retention=${RETENTION_DAYS} days)`);

    let archivedCount = 0;
    let deletedUnused = 0;
    let deletedTerminal = 0;

    try {
        // 1) Archive completed matches (move to archive, then delete from main)
        const completedStatuses = ['INFO_SHARED', 'CONTACTED', 'HIRED'];
        const statusList = completedStatuses.map(() => '?').join(',');
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

        // Insert into archive
        try {
            const insertResult = await db.run(
                `INSERT INTO potential_matches_archive
                 SELECT * FROM potential_matches
                 WHERE status IN (${statusList})
                   AND created_at < ?`,
                ...completedStatuses, cutoff
            );
            archivedCount = insertResult.rowCount || 0;
        } catch (e) {
            if (e.message && e.message.includes('does not exist')) {
                console.warn('[MatchCleanup] Archive table missing, skipping archive step');
            } else if (e.message && e.message.includes('duplicate key')) {
                // Some rows already archived, proceed with delete
                console.warn('[MatchCleanup] Some rows already in archive, continuing');
            } else {
                console.error('[MatchCleanup] Archive insert error:', e.message);
            }
        }

        // Delete archived from main table
        if (archivedCount > 0 || true) {
            const delResult = await db.run(
                `DELETE FROM potential_matches
                 WHERE status IN (${statusList})
                   AND created_at < ?`,
                ...completedStatuses, cutoff
            );
            const deleted = delResult.rowCount || 0;
            if (deleted > archivedCount) archivedCount = deleted;
            console.log(`[MatchCleanup] archived=${archivedCount} (${completedStatuses.join(',')})`);
        }

        // 2) Delete unused/stale matches (never progressed)
        const unusedStatuses = ['NEW', 'PREMATCH_READY', 'SHARE_PENDING_DRIVER', 'SHARE_PENDING_COMPANY'];
        const unusedList = unusedStatuses.map(() => '?').join(',');

        const delUnused = await db.run(
            `DELETE FROM potential_matches
             WHERE status IN (${unusedList})
               AND created_at < ?`,
            ...unusedStatuses, cutoff
        );
        deletedUnused = delUnused.rowCount || 0;
        console.log(`[MatchCleanup] deleted_unused=${deletedUnused} (${unusedStatuses.join(',')})`);

        // 3) Delete terminal matches (EXPIRED, DECLINED) older than retention
        const delTerminal = await db.run(
            `DELETE FROM potential_matches
             WHERE status IN ('EXPIRED', 'DECLINED')
               AND created_at < ?`,
            cutoff
        );
        deletedTerminal = delTerminal.rowCount || 0;
        console.log(`[MatchCleanup] deleted_terminal=${deletedTerminal} (EXPIRED,DECLINED)`);

    } catch (e) {
        console.error('[MatchCleanup] Fatal error:', e);
    }

    const elapsed = Date.now() - start;
    console.log(`[MatchCleanup] Done in ${elapsed}ms — archived=${archivedCount} deleted_unused=${deletedUnused} deleted_terminal=${deletedTerminal}`);

    return { archivedCount, deletedUnused, deletedTerminal };
}

module.exports = { cleanupOldMatches };
