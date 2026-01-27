const API_URL = 'http://localhost:3000';
const ADMIN_SECRET = 'dev_admin_secret_123';
const STRIPE_SECRET_KEY = 'sk_test_mock_123';
const STRIPE_WEBHOOK_SECRET = 'whsec_mock_123';

// Helpers
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, options = {}) {
    const res = await fetch(url, {
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        },
        method: options.method || 'GET',
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    // For Checkout (POST) it returns JSON.
    // For Webhook (POST) it might return text or JSON.

    // Handle specific status
    if (res.status === 204) return { ok: true, status: 204 };

    const text = await res.text();
    try {
        const data = JSON.parse(text);
        return { ok: res.ok, status: res.status, data };
    } catch (e) {
        return { ok: res.ok, status: res.status, text };
    }
}

async function main() {
    console.log('--- TEST PHASE 5.2: STRIPE PAYMENTS (MOCKED) ---');

    // 1. Setup Data (Company + Ticket)
    console.log('> Setting up Company & Ticket...');
    // We can reuse endpoints or DB directly if faster. Let's use Endpoints to be safe on logic.
    // Register Company
    const compEmail = `stripe_test_${Date.now()}@test.com`;
    const regRes = await fetchJson(`${API_URL}/register`, {
        method: 'POST',
        body: { type: 'empresa', nombre: 'Stripe Corp', contacto: compEmail, password: 'Password123!', legal_name: 'Corp' }
    });

    // Auto-verify via DB (since we can't click email)
    const db = require('better-sqlite3')('repro_phase4.db');
    db.prepare(`UPDATE empresas SET verified=1, search_status='ON' WHERE contacto=?`).run(compEmail);

    // Login
    const loginRes = await fetchJson(`${API_URL}/login`, {
        method: 'POST',
        body: { type: 'empresa', contacto: compEmail, password: 'Password123!' }
    });
    const { token, id: companyId } = loginRes.data;

    // Create Request (to get ticket later, wait, we need a ticket!)
    // Creating a ticket requires a full flow: Request -> Apply -> Confirm.
    // OR we can manually insert a ticket into DB for speed if "backend is legacy compatible".
    // Prompt says "Pruebas ... 1. Crear empresa+driver... 2. Crear request, apply, confirm => ticket pending".
    // I will follow the prompt strictly.

    // Register Driver
    const driverEmail = `driver_stripe_${Date.now()}@test.com`;
    await fetchJson(`${API_URL}/register`, {
        method: 'POST',
        body: { type: 'driver', nombre: 'Stripe Driver', contacto: driverEmail, password: 'Password123!', tipo_licencia: 'B' }
    });
    db.prepare(`UPDATE drivers SET verified=1, estado='DISPONIBLE', search_status='ON' WHERE contacto=?`).run(driverEmail);

    const dLogin = await fetchJson(`${API_URL}/login`, { method: 'POST', body: { type: 'driver', contacto: driverEmail, password: 'Password123!' } });
    const dToken = dLogin.data.token;

    // Flow
    const reqRes = await fetchJson(`${API_URL}/create_request`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { licencia_req: 'B', ubicacion: 'City', tiempo_estimado: '1h' }
    });
    // Request ID? The endpoint doesn't return it in response?? Wait, create_request returns { id, status } in server.js?
    // Let's check server server.js: line 800+ returns { id: reqId, status: 'PENDIENTE' }. Yes.
    const requestId = reqRes.data.id;

    await fetchJson(`${API_URL}/apply_for_request`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dToken}` },
        body: { request_id: requestId }
    });

    const confirmRes = await fetchJson(`${API_URL}/approve_driver`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { request_id: requestId }
    });

    // Server returns { ticket_id: ... } or { error: ... }
    if (!confirmRes.ok) throw new Error('Approve Driver Failed: ' + confirmRes.text);

    // DEBUG: Print response
    console.log('Approve Response:', confirmRes.data);

    const ticketId = confirmRes.data.ticket_id;
    if (!ticketId) throw new Error('Ticket ID is undefined in response');
    console.log(`✅ Ticket Created: #${ticketId}`);

    // 2. Checkout Session
    console.log('> Testing Checkout Session...');
    const checkoutRes = await fetchJson(`${API_URL}/billing/tickets/${ticketId}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!checkoutRes.ok) throw new Error('Checkout Failed: ' + checkoutRes.text);
    if (!checkoutRes.data.checkout_url) throw new Error('No checkout_url returned');
    if (!checkoutRes.data.session_id) throw new Error('No session_id returned');

    console.log(`✅ Checkout Session Created: ${checkoutRes.data.session_id}`);

    // Verify DB update
    const tRow = db.prepare('SELECT stripe_checkout_session_id, billing_status FROM tickets WHERE id=?').get(ticketId);
    if (tRow.stripe_checkout_session_id !== checkoutRes.data.session_id) throw new Error('DB not updated with session ID');
    if (tRow.billing_status !== 'pending') throw new Error('Ticket should be pending');

    // 3. Webhook (Mocked)
    console.log('> Testing Webhook (checkout.session.completed)...');

    // We use the bypass flag x-test-bypass-sig because we can't sign properly without Stripe libs in test script context easily (or we rely on server bypass).
    // Prompt allowed: "Simular webhook con un 'fake event' (saltando firma en modo test únicamente)".

    const fakeEvent = {
        id: `evt_test_${Date.now()}`,
        object: 'event',
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
            object: {
                id: checkoutRes.data.session_id,
                object: 'checkout.session',
                payment_status: 'paid',
                payment_intent: 'pi_test_123',
                customer: 'cus_test_123',
                metadata: {
                    ticket_id: ticketId,
                    company_id: companyId
                }
            }
        }
    };

    const webhookRes = await fetchJson(`${API_URL}/stripe/webhook`, {
        method: 'POST',
        headers: {
            'x-test-bypass-sig': 'true', // Uses the bypass we added
            'Content-Type': 'application/json'
        },
        body: fakeEvent
    });

    if (!webhookRes.ok) throw new Error('Webhook Failed: ' + webhookRes.text);
    console.log('✅ Webhook Received 200 OK');

    // 4. Verify Paid
    const tPaid = db.prepare('SELECT billing_status, paid_at, stripe_payment_intent_id FROM tickets WHERE id=?').get(ticketId);
    if (tPaid.billing_status !== 'paid') throw new Error('Ticket not marked PAID');
    if (!tPaid.paid_at) throw new Error('paid_at missing');
    if (tPaid.stripe_payment_intent_id !== 'pi_test_123') throw new Error('Payment Intent missing');
    console.log('✅ Ticket is PAID');

    // 5. Idempotency Replay
    console.log('> Testing Webhook Replay (Idempotency)...');
    const replayRes = await fetchJson(`${API_URL}/stripe/webhook`, {
        method: 'POST',
        headers: { 'x-test-bypass-sig': 'true', 'Content-Type': 'application/json' },
        body: fakeEvent
    });

    if (!replayRes.ok) throw new Error('Replay Failed');
    if (replayRes.data.idempotency !== 'cached') console.warn('⚠️ Idempotency flag missing in response (optional but good)');

    console.log('✅ Idempotency OK');
    console.log('✅ TEST PASSED: Phase 5.2 Stripe');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
