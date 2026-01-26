const sqlite3 = require('better-sqlite3');
const http = require('http');

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
    const uniqueId = Date.now();
    const contacto = `no_cred_${uniqueId}@test.com`;
    const password = 'password123';

    console.log(`--- 1. Registering Company (${contacto}) ---`);
    const regRes = await request({
        hostname: 'localhost', port: 3000, path: '/register', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, {
        type: 'empresa',
        nombre: `Empresa Sin Creditos ${uniqueId}`,
        contacto: contacto,
        password: password,
        ciudad: 'Test City'
    });

    if (regRes.status !== 201) return console.error('Reg failed', regRes.body);
    const empId = regRes.body.id;

    console.log('\n--- 2. Setting Credits to 0 (Manually) ---');
    // Ensure the company has 0 credits in DB to prove the check is gone
    db.prepare('UPDATE empresas SET creditos = 0 WHERE id = ?').run(empId);
    const check = db.prepare('SELECT creditos FROM empresas WHERE id = ?').get(empId);
    console.log(`Credits in DB: ${check.creditos}`);

    console.log('\n--- 3. Logging In ---');
    const loginRes = await request({
        hostname: 'localhost', port: 3000, path: '/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'empresa', contacto: contacto, password: password });
    const token = loginRes.body.token;

    console.log('\n--- 4. Creating Request (Expect 201 OK) ---');
    const reqRes = await request({
        hostname: 'localhost', port: 3000, path: '/create_request', method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    }, {
        licencia_req: 'B',
        ubicacion: 'Zero Credit Zone',
        tiempo_estimado: 45
    });

    console.log('Response:', reqRes.body);

    if (reqRes.status === 201) {
        console.log('SUCCESS: Request created despite having 0 credits.');
    } else {
        console.error('FAILURE: Request failed with status', reqRes.status);
    }

    console.log('\n--- 5. Minimal Manual Check: Listing Requests ---');
    // Login as driver
    const drvEmail = `checker_${uniqueId}@test.com`;
    await request({
        hostname: 'localhost', port: 3000, path: '/register', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'driver', nombre: 'Checker', contacto: drvEmail, password: 'pw', tipo_licencia: 'B' });
    const drvLogin = await request({
        hostname: 'localhost', port: 3000, path: '/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'driver', contacto: drvEmail, password: 'pw' });

    const listRes = await request({
        hostname: 'localhost', port: 3000, path: '/list_available_requests', method: 'GET',
        headers: { 'Authorization': `Bearer ${drvLogin.body.token}` }
    });

    // Note: Request ID might be > 2.
    // If we see any requests, or at least 200 OK [], it works.
    // Since we created one matching 'B', verifying logic depends on Round 1 visibility.
    // Standard -> R1 (N=3). I just registered 1 driver.
    // Random selection might not pick this exact driver if N_DRIVERS < Total Drivers.
    // But API call success confirms endpoint health.

    if (listRes.status === 200) {
        console.log(`SUCCESS: List API is healthy (Status 200). Items: ${listRes.body.length}`);
    } else {
        console.error('FAILURE: List API failed', listRes.status);
    }
}

run().catch(console.error);
