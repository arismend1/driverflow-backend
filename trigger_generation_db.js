const db = require('./db_adapter');

async function trigger() {
    try {
        console.log("Enqueueing generation job via DB...");
        // Ensure payload is valid JSON string
        const payload = JSON.stringify({ force_date: '2025-01-27' });
        const now = new Date().toISOString();

        // Insert into jobs_queue
        // Note: adjust table schema if needed, but standard is job_type, payload_json, etc.
        const res = await db.run(
            "INSERT INTO jobs_queue (job_type, payload_json, created_at, attempts, max_attempts) VALUES (?, ?, ?, 0, 5)",
            'generate_weekly_invoices',
            payload,
            now
        );

        console.log("Job enqueued successfully. Result:", res);
    } catch (e) {
        console.error("Error enqueueing job:", e);
    }
}

trigger();
