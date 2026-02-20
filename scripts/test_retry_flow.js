const https = require('https');

const API_URL = "https://driverflow-backend.onrender.com";
const ADMIN_SECRET = process.argv[2];
const TARGET_ID = process.argv[3];

if (!ADMIN_SECRET) {
    console.error("\n❌ Error: Falta el Admin Secret.");
    console.error("Uso: node scripts/test_retry_flow.js <TU_ADMIN_SECRET> [INVOICE_ID]\n");
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

async function run() {
    console.log(`\n🧪 Testing Retry Endpoint on: ${API_URL}\n`);

    let invoiceId = TARGET_ID;

    // 1. If no ID provided, find a suitable invoice
    if (!invoiceId) {
        console.log("🔍 Looking for a suitable invoice to retry...");
        const res = await request('GET', '/admin/invoices');
        if (res.status !== 200 || !Array.isArray(res.body) || res.body.length === 0) {
            console.error("❌ Could not fetch invoices to select one.");
            process.exit(1);
        }

        // Find one that is NOT paid (pending, failed, charging)
        // Actually, retry is allowed for 'failed' (and 'pending' technically resets it)
        // logic says: if status == 'paid' || 'charging' -> 400.
        const candidate = res.body.find(inv => inv.status !== 'paid' && inv.status !== 'charging');

        if (!candidate) {
            console.log("⚠️ No retryable invoices found (all are PAID or CHARGING).");
            // FORCE retry on a PAID one to test error? No, user wants to test success likely.
            // But if all are paid, we can't test success.
            // Try pending?
            const pending = res.body.find(inv => inv.status === 'pending');
            if (pending) {
                invoiceId = pending.id;
                console.log(`👉 Selected 'pending' invoice ID: ${invoiceId} (reseting pending is allowed)`);
            } else {
                console.error("❌ No suitable invoice found.");
                process.exit(1);
            }
        } else {
            invoiceId = candidate.id;
            console.log(`👉 Selected invoice ID: ${invoiceId} (Status: ${candidate.status})`);
        }
    }

    // 2. Perform Retry
    console.log(`\n🚀 Sending Retry Request for ID: ${invoiceId}...`);
    const retryRes = await request('POST', `/admin/invoices/${invoiceId}/retry`, {});

    if (retryRes.status === 200) {
        console.log("✅ Retry Request SUCCESS!");
        console.log("Response:", retryRes.body);
        console.log("\nExpected behavior: Status should be 'pending' and job enqueued.");
    } else {
        console.log(`❌ Retry Request FAILED. Status: ${retryRes.status}`);
        console.log("Response:", retryRes.body);
    }
}

run();
