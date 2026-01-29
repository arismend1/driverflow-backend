const db = require('../db_adapter');

(async () => {
    try {
        console.log("--- Inspecting Events Outbox ---");
        const pending = await db.all("SELECT id, event_name, process_status, queue_status, send_attempts, last_error FROM events_outbox WHERE process_status != 'sent' OR queue_status != 'done' LIMIT 20");
        console.table(pending);

        console.log("\n--- Inspecting Jobs Queue ---");
        const jobs = await db.all("SELECT id, job_type, status, attempts, last_error, locked_by, locked_at FROM jobs_queue ORDER BY id DESC LIMIT 20");
        console.table(jobs);

        console.log("\n--- Worker Heartbeat ---");
        const hb = await db.all("SELECT * FROM worker_heartbeat");
        console.table(hb);

    } catch (e) {
        console.error(e);
    }
})();
