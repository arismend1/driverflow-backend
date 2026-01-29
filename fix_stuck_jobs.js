const db = require('./db_adapter');
const { startQueueWorker } = require('./worker_queue');

(async () => {
    try {
        console.log('--- REPAIRING NULL JOBS ---');
        // Fix Jobs
        const res = await db.run("UPDATE jobs_queue SET status='pending' WHERE status IS NULL");
        console.log(`Updated Jobs:`, res);

        // Fix Events (Just in case)
        const res2 = await db.run("UPDATE events_outbox SET queue_status='pending' WHERE queue_status IS NULL");
        console.log(`Updated Events:`, res2);

        console.log('--- DONE ---');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
