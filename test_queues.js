const axios = require('axios');

const API_URL = 'https://driverflow-backend.onrender.com';
const SECRET = 'surgical_evidence_123';

async function waitForRender() {
    process.stdout.write("Waiting for Render to boot new deployment...");
    while (true) {
        try {
            const res = await axios.post(`${API_URL}/api/debug/sql`, {
                secret: SECRET,
                get_queues: true
            });
            if (res.data && res.data.outbox) {
                console.log("\n✅ Render is UP with NEW code!\n");
                return res.data;
            }
        } catch (e) {
            // ignore
        }
        process.stdout.write(".");
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function run() {
    const data = await waitForRender();

    console.log("SELECT id,event_name,company_id,driver_id,queue_status,metadata,created_at FROM events_outbox ORDER BY id DESC LIMIT 10;");
    console.table(data.outbox);

    console.log("\nSELECT id,job_type,status,attempts,last_error,run_at FROM jobs_queue ORDER BY id DESC LIMIT 10;");
    console.table(data.jobs);
}
run();
