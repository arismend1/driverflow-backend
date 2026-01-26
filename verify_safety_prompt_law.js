const { spawn } = require('child_process');
const http = require('http');

console.log("--- TEST REQ 5: Safety Closures Verification ---");

const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '3005', DB_PATH: 'driverflow_test_safety.db', NODE_ENV: 'test' },
    stdio: 'inherit'
});

const request = (path, method, body, token, headers = {}) => {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3005,
            path: path,
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...headers }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
                } catch (e) {
                    console.error("JSON Parse Error. Data:", data);
                    resolve({ status: res.statusCode, body: { error: "Invalid JSON", raw: data } });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
};

const jwt = require('jsonwebtoken');
const secret = 'driverflow_secret_key_mvp';
const delay = ms => new Promise(res => setTimeout(res, ms));

async function run() {
    await delay(3000);
    const db = require('better-sqlite3')('driverflow_test_safety.db');

    // Setup - Correct Deletion Order with FK OFF
    db.pragma('foreign_keys = OFF');
    try {
        db.prepare('DELETE FROM events_outbox').run();
        db.prepare('DELETE FROM webhook_events').run();
        db.prepare('DELETE FROM audit_logs').run();
        db.prepare('DELETE FROM credit_notes').run();
        db.prepare('DELETE FROM invoice_items').run();
        db.prepare('DELETE FROM invoices').run();
        db.prepare('DELETE FROM tickets').run();
        db.prepare('DELETE FROM ratings').run();
        db.prepare('DELETE FROM solicitudes').run();
        db.prepare('DELETE FROM drivers').run();
        db.prepare('DELETE FROM empresas').run();
    } catch (e) {
        console.error("Cleanup Error (Ignored):", e.message);
    }
    db.pragma('foreign_keys = ON');

    try {
        db.prepare("INSERT INTO drivers (id, nombre, contacto, estado, password_hash, tipo_licencia) VALUES (1, 'D1', 'd1_contact', 'DISPONIBLE', 'hash', 'A')").run();
        // Default company (ID 10)
        db.prepare("INSERT INTO empresas (id, nombre, contacto, ciudad, is_blocked, password_hash) VALUES (10, 'C1', 'c1_contact', 'City', 0, 'hash')").run();
        // Blocked company (ID 99)
        db.prepare("INSERT INTO empresas (id, nombre, contacto, ciudad, is_blocked, blocked_reason, password_hash) VALUES (99, 'BadCo', 'bad', 'City', 1, 'Debt', 'hash')").run();

        const companyToken = jwt.sign({ id: 10, type: 'empresa' }, secret);
        const blockedToken = jwt.sign({ id: 99, type: 'empresa' }, secret);
        const driverToken = jwt.sign({ id: 1, type: 'driver' }, secret);

        // --- TEST A: Normal Flow -> Reveal AFTER PAYMENT ---
        console.log("Test A: Normal Match & Reveal...");
        let res = await request('/create_request', 'POST', { licencia_req: 'A', ubicacion: 'Loc', tiempo_estimado: 60 }, companyToken);
        const reqId1 = res.body.id;

        // APPLY
        res = await request('/apply_for_request', 'POST', { request_id: reqId1 }, driverToken);
        if (!res.body.success && !res.body.message) {
            console.error("Apply Failed:", JSON.stringify(res.body));
            throw new Error("Apply Failed");
        }

        // APPROVE
        res = await request('/approve_driver', 'POST', { request_id: reqId1 }, companyToken);
        if (!res.body.success) {
            console.error("Approve Driver Failed:", JSON.stringify(res.body));
            throw new Error("A0: Confirm Match failed.");
        }

        // 1. Verify BLOCKED before payment (Strict Rule)
        console.log("  [Check] Access Blocked before payment...");
        res = await request(`/request/${reqId1}/contact`, 'GET', null, companyToken);
        if (res.status !== 402) {
            console.log("FAILED RESPONSE BODY (Expected 402):", JSON.stringify(res.body));
            throw new Error(`A1: Expected 402 Blocked (Unbilled/Unpaid), got ${res.status}`);
        }

        // 2. Stimulate Billing & Payment
        console.log("  [Action] Simulating Invoice & Payment...");
        const ticketId = db.prepare('SELECT id, price_cents FROM tickets WHERE request_id = ?').get(reqId1).id;
        const price = db.prepare('SELECT price_cents FROM tickets WHERE id = ?').get(ticketId).price_cents;

        // Note: 'status' default is pending. 'created_at' required.
        const invInfo = db.prepare("INSERT INTO invoices (company_id, total_cents, status, created_at, billing_week, due_date) VALUES (?, ?, 'pending', datetime('now'), '2026-W01', datetime('now', '+7 days'))").run(10, price);
        const invId = invInfo.lastInsertRowid;
        db.prepare("INSERT INTO invoice_items (invoice_id, ticket_id, price_cents) VALUES (?, ?, ?)").run(invId, ticketId, price);
        db.prepare("UPDATE tickets SET billing_status = 'billed' WHERE id = ?").run(ticketId);

        // Pay it
        db.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?").run(invId);

        // 3. Verify ACCESS after payment
        res = await request(`/request/${reqId1}/contact`, 'GET', null, companyToken);
        if (res.status !== 200 || !res.body.contacto) throw new Error("A2: Failed to reveal contact AFTER payment");
        console.log("  [PASS] Contact Revealed (Paid)");


        // --- TEST B: Blocked Company -> No Create, No Reveal ---
        console.log("Test B: Blocked Company Strictness...");
        res = await request('/create_request', 'POST', { licencia_req: 'A', ubicacion: 'X', tiempo_estimado: 60 }, blockedToken);
        if (res.status !== 403) {
            console.log("FAILED B: Body:", JSON.stringify(res.body));
            throw new Error("B: Blocked Company could create request (" + res.status + ")");
        }

        db.prepare("INSERT INTO solicitudes (id, empresa_id, driver_id, estado, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion) VALUES (999, 99, 1, 'ACEPTADA', 'A', 'X', 60, 'str')").run();
        db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, currency, billing_status, created_at) VALUES (99, 1, 999, 1000, 'USD', 'unbilled', datetime('now'))").run();

        res = await request('/request/999/contact', 'GET', null, blockedToken);
        if (res.status !== 403 || res.body.error !== 'COMPANY_BLOCKED') throw new Error("B: Blocked Company could reveal contact! " + JSON.stringify(res.body));
        console.log("  [PASS] Blocked Company Denied");


        // --- TEST C: Fake Webhook ---
        console.log("Test C: Fake Webhook...");
        res = await request('/webhooks/payment', 'POST', { type: 'invoice.paid' }, null, { 'x-webhook-secret': 'WRONG' });
        if (res.status !== 403) throw new Error("C: Fake secret accepted");
        console.log("  [PASS] Fake Webhook Rejected");


        // --- TEST D: Idempotency ---
        console.log("Test D: Webhook Idempotency...");
        const eventId = "evt_123";
        db.prepare("INSERT INTO invoices (id, company_id, total_cents, status, created_at, billing_week, due_date) VALUES (500, 10, 5000, 'pending', datetime('now'), '2026-W02', datetime('now', '+7 days'))").run();

        const payload = {
            type: 'invoice.paid',
            id: eventId,
            data: { invoice_id: 500, amount_paid_cents: 5000 }
        };

        res = await request('/webhooks/payment', 'POST', payload, null, { 'x-webhook-secret': 'simulated_webhook_secret' });
        if (!res.body.success) throw new Error("D: First webhook failed: " + JSON.stringify(res.body));

        const check = db.prepare('SELECT status FROM invoices WHERE id = 500').get();
        if (check.status !== 'paid') throw new Error("D: Invoice not paid");

        res = await request('/webhooks/payment', 'POST', payload, null, { 'x-webhook-secret': 'simulated_webhook_secret' });
        if (!res.body.success || res.body.message !== 'Event already processed') throw new Error("D: Idempotency failed: " + JSON.stringify(res.body));
        console.log("  [PASS] Idempotency Verified");


        // --- TEST E: Void Paid Invoice -> Credit Note ---
        console.log("Test E: Void Paid Invoice...");
        const adminSecret = process.env.ADMIN_SECRET || 'simulated_admin_secret';

        // Explicit Request for Test E (FK Satisfaction)
        db.prepare("INSERT INTO solicitudes (id, empresa_id, driver_id, estado, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion) VALUES (800, 10, 1, 'ACEPTADA', 'A', 'Test E', 60, 'str')").run();

        // Tickets need created_at
        db.prepare("INSERT INTO tickets (id, company_id, driver_id, request_id, price_cents, billing_status, created_at) VALUES (800, 10, 1, 800, 15000, 'billed', datetime('now'))").run();
        // Invoices need billing_week and due_date
        db.prepare("INSERT INTO invoices (id, company_id, total_cents, status, created_at, billing_week, due_date) VALUES (801, 10, 15000, 'paid', datetime('now'), '2026-W03', datetime('now', '+7 days'))").run();
        db.prepare("INSERT INTO invoice_items (invoice_id, ticket_id, price_cents) VALUES (801, 800, 15000)").run();

        res = await request('/admin/tickets/void', 'POST', { ticket_id: 800, reason: 'Test Credit' }, null, { 'x-admin-secret': adminSecret });

        if (!res.body.success || !res.body.message.includes('Credit Note')) throw new Error("E: Did not issue credit note: " + JSON.stringify(res.body));

        const credit = db.prepare('SELECT * FROM credit_notes WHERE company_id = 10').get();
        if (!credit || credit.amount_cents !== 15000) throw new Error("E: Credit Note missing or wrong amount");
        console.log("  [PASS] Credit Note Issued");

        const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'void_ticket' AND target_id = ?").get(800);
        if (!audit) {
            const allLogs = db.prepare("SELECT * FROM audit_logs").all();
            console.log("FAILED E: All Audit Logs:", JSON.stringify(allLogs));
            throw new Error("E: Audit log missing for target_id 800");
        }
        console.log("  [PASS] Audit Log Verified");


        console.log("\n✅ ALL PROMPT LAW REQUIREMENTS VERIFIED");
        server.kill();
        process.exit(0);

    } catch (e) {
        console.error("❌ TEST FAILED with DB/Request Error:", e);
        server.kill();
        process.exit(1);
    }
}

run();
