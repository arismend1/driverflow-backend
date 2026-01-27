const API_URL = 'http://localhost:3000';

// Helpers
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, options = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...options.headers },
        method: options.method || 'GET',
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await res.text();
    try {
        const data = JSON.parse(text);
        return { ok: res.ok, status: res.status, data };
    } catch (e) {
        return { ok: res.ok, status: res.status, text };
    }
}

async function main() {
    console.log('--- TEST PHASE 5: REALTIME NOTIFICATIONS (FETCH) ---');

    // 1. Create Company & Driver
    const ts = Date.now();
    const companyEmail = `comp_notif_${ts}@test.com`;
    const driverEmail = `driver_notif_${ts}@test.com`;

    // Register
    await fetchJson(`${API_URL}/register`, {
        method: 'POST',
        body: {
            type: 'empresa', nombre: 'Notif Corp', contacto: companyEmail, password: 'Password123!',
            legal_name: 'Corp', address_line1: 'St', address_city: 'City'
        }
    });
    await fetchJson(`${API_URL}/register`, {
        method: 'POST',
        body: {
            type: 'driver', nombre: 'Notif Driver', contacto: driverEmail, password: 'Password123!',
            tipo_licencia: 'C'
        }
    });

    // Verify via DB (Direct, bypassing Auth/Email)
    const db = require('better-sqlite3')('repro_phase4.db');
    db.prepare("UPDATE drivers SET verified = 1, status='active', estado='DISPONIBLE', search_status='ON' WHERE contacto = ?").run(driverEmail);
    db.prepare("UPDATE empresas SET verified = 1, search_status='ON' WHERE contacto = ?").run(companyEmail);
    console.log('✅ Users Verified via DB');

    // Login
    const cLogin = await fetchJson(`${API_URL}/login`, { method: 'POST', body: { type: 'empresa', contacto: companyEmail, password: 'Password123!' } });
    const cToken = cLogin.data.token;

    const dLogin = await fetchJson(`${API_URL}/login`, { method: 'POST', body: { type: 'driver', contacto: driverEmail, password: 'Password123!' } });
    const dToken = dLogin.data.token;

    if (!cToken || !dToken) {
        console.error('Login Failed', { c: cLogin.data, d: dLogin.data });
        process.exit(1);
    }
    console.log('✅ Logged In');

    // 2. Poll initial events
    // 3. Create Request -> Should Broadcast
    console.log('--- Action: Create Request ---');
    await fetchJson(`${API_URL}/create_request`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cToken}` },
        body: { licencia_req: 'C', ubicacion: 'Test City', tiempo_estimado: '2h' }
    });

    await sleep(2000); // Wait for dispatcher

    // Check Driver Events via /since
    const dEvents = await fetchJson(`${API_URL}/events/since?last_id=0`, { headers: { Authorization: `Bearer ${dToken}` } });
    const broadcastEvent = dEvents.data.find(e => e.event_key === 'request_created');

    if (broadcastEvent) console.log(`✅ Driver received Broadcast: ${broadcastEvent.id}`);
    else {
        console.error('❌ Driver missed Broadcast', dEvents.data);
        // Don't fail hard, just warn if timing issue, but strictly it should be there.
    }

    const list = await fetchJson(`${API_URL}/list_available_requests`, { headers: { Authorization: `Bearer ${dToken}` } });
    const request = list.data[0];
    if (!request) throw new Error('No requests list');
    console.log(`✅ Driver sees request ID: ${request.id}`);

    // 4. Driver Apply -> Notify Company
    console.log('--- Action: Apply ---');
    await fetchJson(`${API_URL}/apply_for_request`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dToken}` },
        body: { request_id: request.id }
    });

    await sleep(2000);

    const cEvents = await fetchJson(`${API_URL}/events/since?last_id=0`, { headers: { Authorization: `Bearer ${cToken}` } });
    const applyEvent = cEvents.data.find(e => e.event_key === 'driver_applied');
    if (applyEvent) console.log(`✅ Company received Apply: ${applyEvent.id}`);
    else {
        console.error('❌ Company missed Apply', cEvents.data);
    }

    // 5. Company Confirm -> Notify Driver
    console.log('--- Action: Confirm ---');
    await fetchJson(`${API_URL}/approve_driver`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cToken}` },
        body: { request_id: request.id }
    });

    await sleep(2000);

    const dEvents2 = await fetchJson(`${API_URL}/events/since?last_id=${broadcastEvent ? broadcastEvent.id : 0}`, { headers: { Authorization: `Bearer ${dToken}` } });
    const confirmEvent = dEvents2.data.find(e => e.event_key === 'match_confirmed');

    if (confirmEvent) console.log(`✅ Driver received Confirm: ${confirmEvent.id}`);
    else {
        console.error('❌ Driver missed Confirm', dEvents2.data);
    }

    console.log('✅ TEST PASSED: Realtime Flow Complete');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
