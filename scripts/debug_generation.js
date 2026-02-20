const https = require('https');

const API_URL = "https://driverflow-backend.onrender.com";
const ADMIN_SECRET = process.argv[2];

if (!ADMIN_SECRET) {
    console.error("Usage: node scripts/debug_generation.js <ADMIN_SECRET>");
    process.exit(1);
}

function request(method, path, body = null) {
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
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    console.log(`\n🕵️  Debugging Invoice Generation on: ${API_URL}\n`);

    // 1. Check current Job Queue Status via debug endpoint
    // This allows us to see if the worker is even picking things up
    console.log("1. Checking Worker Queue Status...");
    try {
        const debugRes = await request('GET', '/sys/debug/email-status'); // This endpoint returns { jobs: [...] }
        if (debugRes.status === 200) {
            console.log("   Latest Jobs in Queue:");
            if (debugRes.body.jobs && debugRes.body.jobs.length > 0) {
                debugRes.body.jobs.forEach(j => {
                    console.log(`   - [${j.id}] ${j.job_type}: ${j.status} (Attempts: ${j.attempts}) LastErr: ${j.last_error || 'none'}`);
                });
            } else {
                console.log("   (Queue is Empty)");
            }
        } else {
            console.log("   ⚠️  Creating debug info failed or endpoint missing.");
        }
    } catch (e) {
        console.log("   ❌ Error checking debug status:", e.message);
    }

    // 2. Trigger Generation
    console.log("\n2. Triggering Invoice Generation (POST /admin/invoices/generate)...");
    const genRes = await request('POST', '/admin/invoices/generate', {});
    console.log("   Response:", genRes.status, genRes.body);

    if (genRes.status !== 200) {
        console.error("   ❌ Failed to trigger generation.");
        return;
    }

    console.log("\n3. Waiting 10 seconds for worker to process...");
    await sleep(10000);

    // 4. Check Invoices Again
    console.log("4. Checking for generated invoices...");
    const invRes = await request('GET', '/admin/invoices');
    if (invRes.status === 200) {
        const count = Array.isArray(invRes.body) ? invRes.body.length : 0;
        console.log(`   found ${count} invoices.`);
        if (count > 0) {
            console.log("   ✅ SUCCESS! Invoices were generated.");
            console.log("   Sample:", JSON.stringify(invRes.body[0], null, 2));
        } else {
            console.log("   ❌ STILL EMPTY. Worker might be down or failing.");

            // 5. Check Queue again to see if they are 'failed' or 'pending'
            console.log("\n5. Checking Queue again...");
            const debugRes2 = await request('GET', '/sys/debug/email-status');
            if (debugRes2.status === 200 && debugRes2.body.jobs) {
                const genJobs = debugRes2.body.jobs.filter(j => j.job_type === 'generate_weekly_invoices');
                genJobs.forEach(j => {
                    console.log(`   - Job ${j.id}: ${j.status} (Err: ${j.last_error})`);
                });
            }
        }
    } else {
        console.error("   ❌ Error fetching invoices:", invRes.status);
    }
}

run();
