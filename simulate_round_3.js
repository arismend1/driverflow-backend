const sqlite3 = require('better-sqlite3');
const http = require('http');

// Helper for HTTP requests
function request(options, data) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, body });
                }
            });
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function run() {
    const db = sqlite3('driverflow.db');

    // 1. Register a NEW random driver (Observer 2) who is definitely NOT in the visibility list
    const obsEmail = `observer3_${Date.now()}@test.com`;
    console.log(`--- 1. Registering New Observer (${obsEmail}) ---`);

    await request({
        hostname: 'localhost', port: 3000, path: '/register', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'driver', nombre: 'Observer Round 3', contacto: obsEmail, password: 'pw', tipo_licencia: 'A' });

    // Login
    const loginRes = await request({
        hostname: 'localhost', port: 3000, path: '/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'driver', contacto: obsEmail, password: 'pw' });
    const token = loginRes.body.token;

    // 2. Trigger Round Advance via list
    console.log('\n--- 2. Asking for requests (Triggers Round Logic) ---');
    const listRes = await request({
        hostname: 'localhost', port: 3000, path: '/list_available_requests', method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    const requests = listRes.body;
    console.log(`Requests found by new observer: ${requests.length}`);
    if (requests.length > 0) {
        console.log('Sample Request:', JSON.stringify(requests[0], null, 2));
    }

    // 3. Verify DB State
    const req = db.prepare("SELECT * FROM solicitudes WHERE id = 1").get();
    console.log(`\n--- DB State ---`);
    console.log(`Ronda Actual: ${req.ronda_actual}`);

    if (req.ronda_actual === 3) {
        console.log('SUCCESS: Request is in Round 3 (Open Round).');
        if (requests.find(r => r.id === 1)) {
            console.log('SUCCESS: New driver can see the request (Open Visibility verified).');
        } else {
            console.log('FAILURE: Request is Round 3 but not visible to new driver.');
        }
    } else {
        console.log('FAILURE: Request did not advance to Round 3.');
    }
}

run().catch(console.error);
