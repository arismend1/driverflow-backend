const sqlite3 = require('better-sqlite3');
const http = require('http');

const db = sqlite3('driverflow.db');

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

function getEvents(reqId) {
    return db.prepare('SELECT * FROM events_outbox WHERE request_id = ? ORDER BY id ASC').all(reqId);
}

async function run() {
    const uniqueId = Date.now();
    const companyEmail = `ev_comp_${uniqueId}@test.com`;
    const driverEmail = `ev_drv_${uniqueId}@test.com`;
    const pwd = 'password123';

    console.log('\n--- 1. Setup ---');
    // Register Company
    await request({
        hostname: 'localhost', port: 3000, path: '/register', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'empresa', nombre: 'EvCo', contacto: companyEmail, password: pwd, ciudad: 'City' });

    // Login Company
    const cmpToken = (await request({
        hostname: 'localhost', port: 3000, path: '/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'empresa', contacto: companyEmail, password: pwd })).body.token;

    // Register Driver
    await request({
        hostname: 'localhost', port: 3000, path: '/register', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'driver', nombre: 'EvDrv', contacto: driverEmail, password: pwd, tipo_licencia: 'B' });

    // Login Driver
    const drvToken = (await request({
        hostname: 'localhost', port: 3000, path: '/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'driver', contacto: driverEmail, password: pwd })).body.token;

    console.log('Got Tokens. CMP:', !!cmpToken, 'DRV:', !!drvToken);


    console.log('\n--- TEST A: Ticket Created Event ---');
    // Create Req
    const req1 = (await request({
        hostname: 'localhost', port: 3000, path: '/create_request', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cmpToken}` }
    }, { licencia_req: 'B', ubicacion: 'Loc1', tiempo_estimado: 10 })).body;

    // Accept Req
    const acceptRes = await request({
        hostname: 'localhost', port: 3000, path: '/accept_request', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${drvToken}` }
    }, { request_id: req1.id });

    console.log('Accept Res:', acceptRes.status, acceptRes.body);

    const eventsA = getEvents(req1.id);
    console.log('Events for Req 1:', eventsA);
    if (eventsA.length === 1 && eventsA[0].event_name === 'ticket_created' && eventsA[0].ticket_id) {
        console.log('✅ TEST A PASSED: ticket_created emitted.');
    } else {
        console.error('❌ TEST A FAILED.');
    }

    console.log('\n--- TEST B: Request Cancelled Event ---');
    // Register Company 2
    const cmpToken2 = (await request({
        hostname: 'localhost', port: 3000, path: '/register', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'empresa', nombre: 'EvCo2', contacto: `ev_co2_${uniqueId}@test.com`, password: pwd, ciudad: 'City' })).body.token;

    // Login (Register returns token? No, Register returns {id}, Login returns {token})
    // Wait, my prev fix verified that Register does NOT return token.
    // So I need Register + Login for Co2.
    // Actually, I can just use a helper.

    const cmpLogin2 = await request({
        hostname: 'localhost', port: 3000, path: '/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'empresa', contacto: `ev_co2_${uniqueId}@test.com`, password: pwd });
    const token2 = cmpLogin2.body.token;

    // Create Req 2
    const req2Res = await request({
        hostname: 'localhost', port: 3000, path: '/create_request', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token2}` }
    }, { licencia_req: 'B', ubicacion: 'Loc2', tiempo_estimado: 10 });
    const req2 = req2Res.body;

    // Check if created
    if (req2Res.status !== 201) console.error('Req2 Create Failed:', req2Res.status, req2);

    // Cancel Req 2
    await request({
        hostname: 'localhost', port: 3000, path: `/request/${req2.id}/cancel`, method: 'POST',
        headers: { 'Authorization': `Bearer ${token2}` }
    });

    const eventsB = getEvents(req2.id);
    console.log('Events for Req 2:', eventsB);
    if (eventsB.length === 1 && eventsB[0].event_name === 'request_cancelled') {
        console.log('✅ TEST B PASSED: request_cancelled emitted.');
    } else {
        console.error('❌ TEST B FAILED.');
    }

    console.log('\n--- TEST C: Idempotency (Retry Accept) ---');
    // Retry accept on Req1
    const retryRes = await request({
        hostname: 'localhost', port: 3000, path: '/accept_request', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${drvToken}` }
    }, { request_id: req1.id });

    console.log('Retry Status:', retryRes.status); // 409

    const eventsC = getEvents(req1.id);
    console.log('Events for Req 1 (Pre-Retry count was 1):', eventsC.length);
    if (eventsC.length === 1) {
        console.log('✅ TEST C PASSED: No duplicate events.');
    } else {
        console.error('❌ TEST C FAILED: Duplicate events found.');
    }

}

run().catch(console.error);
