const db = require('../db_adapter');
const time = require('../time_contract');

async function fix() {
    try {
        const now = time.nowIso();
        console.log(`[Fix] Setting status='pending' and run_at=${now} for NULL jobs...`);

        const res = await db.run(
            "UPDATE jobs_queue SET status = 'pending', run_at = ? WHERE status IS NULL",
            now
        );

        console.log(`[Fix] Updated ${res.changes} jobs (Set to Pending).`);

        // Also fix any pending jobs with proper status but null run_at (just in case)
        const res2 = await db.run(
            "UPDATE jobs_queue SET run_at = ? WHERE status = 'pending' AND run_at IS NULL",
            now
        );
        console.log(`[Fix] Updated ${res2.changes} jobs (Set Run At).`);

    } catch (e) {
        console.error("Error:", e);
    }
}

fix();
