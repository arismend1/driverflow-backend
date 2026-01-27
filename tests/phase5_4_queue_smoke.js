const API_URL = 'http://localhost:3000';
const ADMIN_SECRET = 'dev_admin_secret_123';
const DB_PATH = 'repro_phase4.db';

// Helpers
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function fetchJson(url, options = {}) {
    try {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            method: options.method || 'GET',
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        const text = await res.text();
        try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
        catch (e) { return { ok: res.ok, status: res.status, text }; }
    } catch (e) { return { ok: false, error: e.message }; }
}

async function main() {
    console.log('--- TEST PHASE 5.4: SCALABILITY QUEUE ---');

    const db = require('better-sqlite3')(DB_PATH);

    // 1. Trigger Event (Register)
    const email = `queue_test_${Date.now()}@test.com`;
    console.log(`> Registering user ${email}...`);

    await fetchJson(`${API_URL}/register`, {
        method: 'POST',
        body: { type: 'driver', nombre: 'Queue Driver', contacto: email, password: 'Password123!', tipo_licencia: 'C' }
    });

    // 2. Poll output
    console.log('> Waiting for Job processing...');

    let jobFound = false;
    let jobDone = false;

    for (let i = 0; i < 10; i++) {
        await sleep(1000);

        // Check Outbox status
        const outbox = db.prepare("SELECT process_status FROM events_outbox WHERE metadata LIKE ?").get(`%${email}%`);
        if (outbox && outbox.process_status === 'bridged') {
            process.stdout.write('B'); // Bridged
        }

        // Check Queue
        const job = db.prepare("SELECT * FROM jobs_queue WHERE payload_json LIKE ?").get(`%${email}%`);
        if (job) {
            jobFound = true;
            if (job.status === 'done') {
                jobDone = true;
                console.log(`\n✅ Job ${job.id} DONE (Type: ${job.job_type})`);
                break;
            } else {
                process.stdout.write(`(${job.status})`);
            }
        } else {
            process.stdout.write('.');
        }
    }
    console.log('');

    if (!jobFound) throw new Error('Job never enqueued via bridge');
    if (!jobDone) throw new Error('Job enqueued but not DONE (stuck or failed)');

    // 3. Stats Check
    console.log('> Checking Admin Stats...');
    const statsRes = await fetchJson(`${API_URL}/queue/stats`, { headers: { 'x-admin-secret': ADMIN_SECRET } });
    if (!statsRes.ok) throw new Error('Stats failed');

    const doneCount = statsRes.data.stats.find(s => s.status === 'done');
    if (!doneCount || doneCount.count < 1) throw new Error('Stats count mismatch');

    console.log('✅ Stats OK:', JSON.stringify(statsRes.data.stats));
    console.log('✅ TEST PASSED');
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
