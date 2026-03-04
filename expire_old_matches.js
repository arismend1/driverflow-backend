require('dotenv').config();
const db = require('./db_adapter');
const { nowIso } = require('./time_provider');

const STALE_HOURS = parseInt(process.env.EXPIRE_MATCH_HOURS) || 24;

async function expireOldMatches() {
    console.log(`[Expirer] Starting — looking for NEW matches older than ${STALE_HOURS}h`);

    let staleMatches;
    if (db.IS_POSTGRES) {
        staleMatches = await db.all(
            `SELECT id FROM potential_matches
             WHERE status = 'NEW'
               AND created_at < NOW() - INTERVAL '${STALE_HOURS} hours'`
        );
    } else {
        staleMatches = await db.all(
            `SELECT id FROM potential_matches
             WHERE status = 'NEW'
               AND created_at < datetime('now', '-${STALE_HOURS} hours')`
        );
    }

    let expiredCount = 0;

    for (const match of staleMatches) {
        try {
            await db.run(
                `UPDATE potential_matches SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status = 'NEW'`,
                nowIso(), match.id
            );
            expiredCount++;
        } catch (e) {
            console.error(`[Expirer] ❌ Match #${match.id} error:`, e.message);
        }
    }

    const summary = { checked_count: staleMatches.length, expired_count: expiredCount, timestamp: nowIso() };
    console.log(`[Expirer] Done:`, JSON.stringify(summary));
    return summary;
}

// --- Execution modes ---

// 1. Direct run: node expire_old_matches.js
if (require.main === module) {
    expireOldMatches()
        .then(r => {
            console.log('[Expirer] Exit:', JSON.stringify(r));
            process.exit(0);
        })
        .catch(e => {
            console.error('[Expirer] Fatal:', e);
            process.exit(1);
        });
}

// 2. Import for use in worker_queue.js
module.exports = { expireOldMatches };
