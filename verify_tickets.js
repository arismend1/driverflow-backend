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

function getTickets(reqId) {
    return db.prepare('SELECT * FROM tickets WHERE request_id = ?').all(reqId);
}

async function run() {
    const uniqueId = Date.now();
    const companyEmail = `company_${uniqueId}@test.com`;
    const driverEmail = `driver_${uniqueId}@test.com`;
    const pwd = 'password123';

    console.log('\n--- 1. Setup: Register Company & Driver ---');
    // Create Company
    const cmpReg = await request({
        hostname: 'localhost', port: 3000, path: '/register', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'empresa', nombre: 'TestHub', contacto: companyEmail, password: pwd, ciudad: 'TestCity' });
    const cmpToken = (await request({
        hostname: 'localhost', port: 3000, path: '/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'empresa', contacto: companyEmail, password: pwd })).body.token;

    // Create Driver
    const drvReg = await request({
        hostname: 'localhost', port: 3000, path: '/register', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'driver', nombre: 'TestDriver', contacto: driverEmail, password: pwd, tipo_licencia: 'B' });
    const drvToken = (await request({
        hostname: 'localhost', port: 3000, path: '/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { type: 'driver', contacto: driverEmail, password: pwd })).body.token;

    console.log('\n--- TEST A: Happy Path (Match -> Ticket) ---');
    // Create Request
    const reqRes = await request({
        hostname: 'localhost', port: 3000, path: '/create_request', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cmpToken}` }
    }, { licencia_req: 'B', ubicacion: 'A', tiempo_estimado: 10 });
    const reqId = reqRes.body.id;
    console.log(`Request Created: ${reqId} (Round 1)`);

    // Allow driver to see it (force round logic might be needed if logic relies on driver exclusion, but here we just accept)
    // Actually, driver needs to see it to accept? The accept endpoint validates PENDIENTE, but not "if I saw it".
    // Wait for consistency... nah, just hit accept.
    const acceptRes = await request({
        hostname: 'localhost', port: 3000, path: '/accept_request', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${drvToken}` }
    }, { request_id: reqId });

    console.log('Accept Result:', acceptRes.body);

    if (acceptRes.status !== 200) {
        console.error('❌ Failed to accept request');
        return;
    }

    // VERIFY TICKET
    const ticketsA = getTickets(reqId);
    console.log(`Tickets found for Req ${reqId}:`, ticketsA);
    if (ticketsA.length === 1 && ticketsA[0].price_cents === 15000 && ticketsA[0].billing_status === 'unbilled') {
        console.log('✅ TEST A PASSED: Ticket created correctly.');
    } else {
        console.error('❌ TEST A FAILED: Ticket mismatch.');
    }

    console.log('\n--- TEST B: Idempotency (Retry Accept -> No Dupe Ticket) ---');
    // Try to accept again
    const retryRes = await request({
        hostname: 'localhost', port: 3000, path: '/accept_request', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${drvToken}` }
    }, { request_id: reqId });

    console.log('Retry Status:', retryRes.status, retryRes.body); // Expect 4XX

    const ticketsB = getTickets(reqId);
    console.log(`Tickets count after retry: ${ticketsB.length}`);

    if (retryRes.status >= 400 && ticketsB.length === 1) {
        console.log('✅ TEST B PASSED: Retry rejected & no duplicate ticket.');
    } else {
        console.error('❌ TEST B FAILED: Retry didn\'t fail or duplicate ticket created.');
    }

    console.log('\n--- TEST C: Persistence (Cancel -> Ticket Intact) ---');
    // Driver cancels (releases request back to pending... wait, User said "Cancel/complete NO debe borrar... ticket")
    // If Driver moves it back to PENDIENTE, what happens to ticket?
    // Rule: "Ticket is NOT affected by service completion, cancellation, or failure"
    // "Ticket is created ONLY when contact information is released"
    // If driver cancels, it goes back to pending. New driver accepts -> New ticket?
    // User said: "Ticket is generated ... ONLY when contact info is released".
    // If released AGAIN to another driver, is it another ticket?
    // "Ticket is NOT affected...".
    // Let's test Company side Cancel (Final Cancel) to be safe for "Persistence".

    const cancelRes = await request({
        hostname: 'localhost', port: 3000, path: `/request/${reqId}/cancel`, method: 'POST',
        headers: { 'Authorization': `Bearer ${cmpToken}` }
    });
    console.log('Cancel Status:', cancelRes.status);

    const ticketsC = getTickets(reqId);
    console.log('Tickets after Cancel:', ticketsC);

    if (ticketsC.length === 1) {
        console.log('✅ TEST C PASSED: Ticket persists after cancellation.');
    } else {
        console.error('❌ TEST C FAILED: Ticket lost.');
    }

}

run().catch(console.error);
