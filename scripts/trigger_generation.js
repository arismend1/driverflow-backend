const https = require('https');

const API_URL = "https://driverflow-backend.onrender.com";
const ADMIN_SECRET = process.argv[2];

if (!ADMIN_SECRET) {
    console.error("\n❌ Error: Falta el Admin Secret.");
    console.error("Uso: node scripts/trigger_generation.js <TU_ADMIN_SECRET>\n");
    process.exit(1);
}

function request(method, path, body = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            method: method,
            headers: {
                'x-admin-secret': ADMIN_SECRET,
                'Content-Type': 'application/json'
            }
        };
        const req = https.request(`${API_URL}${path}`, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, body: json });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', (e) => reject(e));
        if (Object.keys(body).length > 0) req.write(JSON.stringify(body));
        req.end();
    });
}

function getNextMonday() {
    const d = new Date();
    d.setDate(d.getDate() + ((1 + 7 - d.getDay()) % 7 || 7));
    return d.toISOString();
}

async function run() {
    console.log(`\n🚀 Triggering Invoice Generation on: ${API_URL}\n`);

    // 1. Try Standard (Previous Week)
    console.log("👉 Attempt 1: Standard (Billing for completed week)...");
    let res = await request('POST', '/admin/invoices/generate', {});

    if (res.status === 200 && res.body.jobs_enqueued > 0) {
        console.log(`✅ Success! Enqueued ${res.body.jobs_enqueued} jobs for period ${res.body.period.week_start} to ${res.body.period.week_end}.`);
        console.log("⏳ Waiting 5 seconds for worker...");
        await new Promise(r => setTimeout(r, 5000));
        process.exit(0);
    } else {
        console.log(`ℹ️  Standard attempt yielded 0 jobs. (Maybe no data last week?)`);
    }

    // 2. Try Current Week (Simulate Next Monday)
    console.log("\n👉 Attempt 2: Current Week (Simulating next Monday)...");
    const nextMon = getNextMonday();
    res = await request('POST', '/admin/invoices/generate', { date: nextMon });

    if (res.status === 200 && res.body.jobs_enqueued > 0) {
        console.log(`✅ Success! Enqueued ${res.body.jobs_enqueued} jobs for period ${res.body.period.week_start} to ${res.body.period.week_end}.`);
        console.log("⏳ Waiting 5 seconds for worker...");
        await new Promise(r => setTimeout(r, 5000));
    } else {
        console.log(`❌ Failed to enqueue jobs. Is there any ticket data in the system?`);
        console.log("Response:", res.body);
    }
}

run();
