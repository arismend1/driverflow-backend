const http = require('http');

// Helper for requests
async function req(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
                } catch (e) { resolve({ status: res.statusCode, body: data }); }
            });
        });

        req.on('error', (e) => reject(e));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function run() {
    try {
        const ts = Date.now();
        const cEmail = `admin_${ts}@logistics.com`;
        const dEmail = `driver_${ts}@driver.com`;
        const pwd = 'SecurePass123!';

        console.log(`--- Using Company: ${cEmail} / Driver: ${dEmail} ---`);

        console.log('--- 1. Login/Register Company ---');
        // Register directly (faster)
        const regC = await req('POST', '/register', {
            type: 'empresa', nombre: 'Logistics Co', contacto: cEmail, password: pwd, legal_name: 'Logistics Inc'
        });
        console.log('Reg Company:', regC.status);

        // Verify manual
        const db = require('./database');
        db.prepare("UPDATE empresas SET verified=1, search_status='ON', is_blocked=0 WHERE contacto=?").run(cEmail);

        // Login
        const cLog = await req('POST', '/login', { type: 'empresa', contacto: cEmail, password: pwd });
        const cToken = cLog.body.token;
        console.log('Company Token:', cToken ? 'OK' : 'FAIL');

        console.log('\n--- 2. Create Request ---');
        const reqRes = await req('POST', '/requests', { licencia_req: 'B', ubicacion: 'Port 5', tiempo_estimado: 120 }, cToken);
        console.log('Create Response:', JSON.stringify(reqRes.body));
        const reqId = reqRes.body.request_id;

        console.log('\n--- 3. Login/Register Driver ---');
        const regD = await req('POST', '/register', {
            type: 'driver', nombre: 'Juan Perez', contacto: dEmail, password: pwd, tipo_licencia: 'B'
        });
        console.log('Reg Driver:', regD.status);

        db.prepare("UPDATE drivers SET verified=1, search_status='ON' WHERE contacto=?").run(dEmail);

        const dLog = await req('POST', '/login', { type: 'driver', contacto: dEmail, password: pwd });
        const dToken = dLog.body.token;
        console.log('Driver Token:', dToken ? 'OK' : 'FAIL');
        console.log('Driver Token:', dToken ? 'OK' : 'FAIL');

        console.log('\n--- 4. Get Available Requests ---');
        const avail = await req('GET', '/requests/available', null, dToken);
        console.log('Available:', JSON.stringify(avail.body).substring(0, 100) + '...');
        const found = avail.body.find(r => r.id === reqId);
        console.log('Newly created request found?', found ? 'YES' : 'NO');

        console.log('\n--- 5. Apply (Driver) ---');
        if (found) {
            const applyRes = await req('POST', `/requests/${reqId}/apply`, {}, dToken);
            console.log('Apply Response:', JSON.stringify(applyRes.body));
        }

        console.log('\n--- 6. Confirm (Company) ---');
        if (found) {
            const confirmRes = await req('POST', `/requests/${reqId}/confirm`, {}, cToken);
            console.log('Confirm Response:', JSON.stringify(confirmRes.body));
        }

        console.log('\n--- 7. Verify Ticket (Driver) ---');
        const tickets = await req('GET', '/tickets/my', null, dToken);
        console.log('Tickets:', JSON.stringify(tickets.body).substring(0, 100) + '...');

    } catch (e) {
        console.error('Error:', e);
    }
}

// Check server ready
setTimeout(run, 2000);
