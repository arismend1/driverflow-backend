require('dotenv').config();
const db = require('./db_adapter');
const { nowIso } = require('./time_provider');

const STALE_HOURS = parseInt(process.env.EXPIRE_MATCH_HOURS) || 48;

const EXPIRABLE_STATES = ['NEW', 'PREMATCH_READY', 'SHARE_PENDING_DRIVER', 'SHARE_PENDING_COMPANY'];

async function expireOldMatches() {
    console.log(`[Expirer] Starting — looking for stale matches (${EXPIRABLE_STATES.join(', ')}) older than ${STALE_HOURS}h`);

    const placeholders = EXPIRABLE_STATES.map(() => '?').join(',');
    let staleMatches;

    if (db.IS_POSTGRES) {
        staleMatches = await db.all(
            `SELECT id, status FROM potential_matches
             WHERE status IN (${placeholders})
               AND created_at < NOW() - INTERVAL '${STALE_HOURS} hours'`,
            ...EXPIRABLE_STATES
        );
    } else {
        staleMatches = await db.all(
            `SELECT id, status FROM potential_matches
             WHERE status IN (${placeholders})
               AND created_at < datetime('now', '-${STALE_HOURS} hours')`,
            ...EXPIRABLE_STATES
        );
    }

    let expiredCount = 0;

    for (const match of staleMatches) {
        try {
            await db.run(
                `UPDATE potential_matches SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
                nowIso(), match.id, ...EXPIRABLE_STATES
            );
            console.log(`[Expirer] ✅ Match #${match.id} (was ${match.status}) → EXPIRED`);
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
if (require.main === module) {
    expireOldMatches()
        .then(r => { console.log('[Expirer] Exit:', JSON.stringify(r)); process.exit(0); })
        .catch(e => { console.error('[Expirer] Fatal:', e); process.exit(1); });
}

module.exports = { expireOldMatches };
