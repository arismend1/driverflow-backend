const { spawn } = require('child_process');
const http = require('http');

console.log("--- TEST: Privacy & Hardening ---");

const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '3004', DB_PATH: 'driverflow_test_priv.db' },
    stdio: 'inherit'
});

server.on('error', (err) => console.error('Server process error:', err));

const request = (path, method, body, token) => {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3004,
            path: path,
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
};

setTimeout(async () => {
    try {
        const jwt = require('jsonwebtoken');
        const db = require('better-sqlite3')('driverflow_test_priv.db');
        const secret = 'driverflow_secret_key_mvp';

        // Setup
        db.prepare("INSERT OR REPLACE INTO drivers (id, nombre, contacto, password_hash, tipo_licencia, estado) VALUES (1, 'D1', 'd1_contact', 'pwm', 'A', 'DISPONIBLE')").run();
        db.prepare("INSERT OR REPLACE INTO empresas (id, nombre, contacto, password_hash, ciudad) VALUES (10, 'HiddenCo', 'c1_contact', 'pwm', 'City')").run();

        const driverToken = jwt.sign({ id: 1, type: 'driver', licencia: 'A' }, secret);
        const companyToken = jwt.sign({ id: 10, type: 'empresa' }, secret);

        // 1. Create Request
        const resCreate = await request('/create_request', 'POST', { licencia_req: 'A', ubicacion: 'Loc', tiempo_estimado: 60 }, companyToken);
        const reqId = resCreate.body.id;

        // 2. Check List Redaction
        console.log("\n1. Checking List Redaction...");
        const resList = await request('/list_available_requests', 'GET', null, driverToken);
        const item = resList.body.find(r => r.id === reqId);
        console.log("Empresa Name in List:", item.empresa);
        if (item.empresa !== 'Verified Company') throw new Error("Privacy Leak: Company Name visible");

        // 3. Check Contact Endpoint (Should be Forbidden)
        console.log("\n2. Checking Pre-Match Privacy...");
        const resContact1 = await request(`/request/${reqId}/contact`, 'GET', null, driverToken);
        console.log("Contact status (Pre-Apply):", resContact1.status);
        // Actually might be 403 Forbidden because not participant OR 403 Hidden. 
        // Wait, if not applied, driver_id is null on request. 
        // The endpoint checks `reqInfo.driver_id === userId`.
        // So generic driver gets 403 Forbidden (Not participant). Correct.

        // Apply
        await request('/apply_for_request', 'POST', { request_id: reqId }, driverToken);

        // Check Contact again (Applied but EN_REVISION)
        const resContact2 = await request(`/request/${reqId}/contact`, 'GET', null, driverToken);
        console.log("Contact status (En Revision):", resContact2.status);
        if (resContact2.status !== 403) throw new Error("Privacy Leak: Contact visible in Revision");

        // 4. Approve
        console.log("\n3. Approving & Checking Post-Match...");
        await request('/approve_driver', 'POST', { request_id: reqId }, companyToken);

        // Check Contact (Matched)
        const resContact3 = await request(`/request/${reqId}/contact`, 'GET', null, driverToken);
        console.log("Contact body (Matched):", resContact3.body);
        if (!resContact3.body.contacto || resContact3.body.contacto !== 'c1_contact') throw new Error("Contact info missing after match");

        console.log("✅ SUCCESS: Privacy Verified");
        server.kill();
        process.exit(0);

    } catch (e) {
        console.error("Test Error:", e);
        server.kill();
        process.exit(1);
    }
}, 3000);
