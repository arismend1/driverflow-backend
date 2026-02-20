const db = require('../db_adapter');
const time = require('../time_contract');

async function resetDead() {
    try {
        const now = time.nowIso();
        console.log("Resetting DEAD jobs to PENDING...");

        const res = await db.run(
            "UPDATE jobs_queue SET status='pending', attempts=0, last_error=NULL, run_at=? WHERE status='dead'",
            now
        );

        console.log(`Reset ${res.changes} jobs.`);
    } catch (e) {
        console.error(e);
    }
}

resetDead();
