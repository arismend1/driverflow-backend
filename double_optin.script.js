const { spawn } = require('child_process');
const http = require('http');

console.log("--- TEST: Double Opt-in Integration ---");

const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '3003', DB_PATH: 'driverflow_test_optin.db', NODE_ENV: 'test' },
    stdio: 'inherit'
});

server.on('error', (err) => console.error('Server process error:', err));

const request = (path, method, body, token) => {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3003,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
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
        const db = require('better-sqlite3')('driverflow_test_optin.db');
        // Setup Users
        db.prepare("INSERT OR REPLACE INTO drivers (id, nombre, contacto, password_hash, tipo_licencia, estado) VALUES (1, 'D1', 'd1', '$2a$10$X', 'A', 'DISPONIBLE')").run();
        db.prepare("INSERT OR REPLACE INTO empresas (id, nombre, contacto, password_hash, ciudad) VALUES (10, 'C1', 'c1', '$2a$10$X', 'City')").run();

        // Login Tokens (Mocked for speed if secret matches, but let's use real login or just fake generation if we knew secret. 
        // Better: Use LOGIN endpoint)
        // Actually, let's just generate tokens using jwt if we can, or just do login.
        // Let's do Login to be safe.
        // Wait, hashing in setup is messy without bcrypt. 
        // I will just mock the JWT generation in this script since I know the secret 'driverflow_secret_key_mvp'

        const jwt = require('jsonwebtoken');
        const secret = 'driverflow_secret_key_mvp';
        const driverToken = jwt.sign({ id: 1, type: 'driver', licencia: 'A' }, secret);
        const companyToken = jwt.sign({ id: 10, type: 'empresa' }, secret);

        // Cleanup
        db.prepare('DELETE FROM solicitudes WHERE empresa_id = 10').run();
        db.prepare('DELETE FROM tickets WHERE company_id = 10').run();

        // 1. Create Request
        console.log("\n1. Creating Request...");
        const resCreate = await request('/create_request', 'POST', {
            licencia_req: 'A',
            ubicacion: 'Loc',
            tiempo_estimado: 60
        }, companyToken);
        console.log("Create:", resCreate.body);
        const reqId = resCreate.body.id;

        // 2. List Requests (Driver)
        console.log("\n2. Listing Requests...");
        const resList = await request('/list_available_requests', 'GET', null, driverToken);
        console.log("List Count:", resList.body.length);
        if (resList.body.length === 0) throw new Error("Request not visible");

        // 3. Apply (Driver)
        console.log("\n3. Applying...");
        const resApply = await request('/apply_for_request', 'POST', { request_id: reqId }, driverToken);
        console.log("Apply:", resApply.body);

        // Verify Status EN_REVISION
        const status1 = db.prepare('SELECT estado FROM solicitudes WHERE id = ?').get(reqId);
        console.log("Status after Apply:", status1.estado);
        if (status1.estado !== 'EN_REVISION') throw new Error("Status mismatch");

        // 4. Approve (Company)
        console.log("\n4. Approving...");
        const resApprove = await request('/approve_driver', 'POST', { request_id: reqId }, companyToken);
        console.log("Approve:", resApprove.body);

        // Verify Status ACEPTADA and Ticket
        const status2 = db.prepare('SELECT estado FROM solicitudes WHERE id = ?').get(reqId);
        const ticket = db.prepare('SELECT * FROM tickets WHERE request_id = ?').get(reqId);

        console.log("Status after Approve:", status2.estado);
        if (status2.estado !== 'ACEPTADA') throw new Error("Status not ACEPTADA");

        console.log("Ticket Created:", !!ticket);
        if (!ticket) throw new Error("Ticket not created");

        console.log("✅ SUCCESS: Double Opt-in Flow Verified");
        server.kill();
        process.exit(0);

    } catch (e) {
        console.error("Test Error:", e);
        server.kill();
        process.exit(1);
    }
}, 3000);
