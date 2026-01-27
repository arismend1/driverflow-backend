const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');

console.log('--- TEST PHASE 4: BILLING SMOKE ---');

const DB_PATH = 'repro_phase4.db';
const PORT = '3004';
const BASE_URL = `http://localhost:${PORT}`;
const ADM_TOKEN = 'secret_admin_token_123';

const env = {
    ...process.env,
    DB_PATH,
    PORT,
    BILLING_ADMIN_TOKEN: ADM_TOKEN, // For testing security
    TICKET_PRICE_CENTS: '999',     // Custom price
    BILLING_CURRENCY: 'mxn',       // Custom currency
    FROM_EMAIL: 'no-reply@driverflow.app' // Strict validation override
};

// 0. Cleanup
try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch (e) { }

// 1. Init DB & Migrations
try {
    const opts = { env, stdio: 'inherit' };
    execSync('node migrate_phase1.js', opts);
    execSync('node migrate_missing_cols.js', opts); // Fix is_blocked
    execSync('node migrate_phase_billing.js', opts); // Fix invoices for access_control
    execSync('node migrate_phase2_requests.js', opts); // Correct name from prev artifacts? Or migrate_phase2.js? 
    // Wait, previously I saw migrate_phase2.js in the repro script but the file list had migrate_phase2_requests.js. 
    // Checking file list... migrate_phase2_requests.js existed in patch. 
    // I will try migrate_phase2_requests.js first. If not found, look at previous patch content.
    // Actually, Phase 2 migration was probably ad-hoc. 
    // Safe bet: The server runs migrations on start too (migrate_auth_fix, migrate_observability, migrate_billing).
    // So if I run migrate_phase1 (schema.sql), others will auto-run.
    // Let's rely on server startup for migrations 3 & 4. But Phase 1 schema is needed.
    // Schema.sql is usually loaded by migrate_phase1.
} catch (e) {
    console.error('Init DB failed:', e.message);
    process.exit(1);
}

// Helper Req
async function req(method, path, body, token, adminToken) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (adminToken) headers['X-Admin-Token'] = adminToken;

    return fetch(`${BASE_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

const serverOpts = { env: { ...env, BILLING_ADMIN_TOKEN: ADM_TOKEN, TICKET_PRICE_CENTS: '999', BILLING_CURRENCY: 'mxn', FROM_EMAIL: 'no-reply@driverflow.app' }, stdio: 'pipe' };

// 2. Start Server
const server = spawn('node', ['server.js'], serverOpts);
server.stdout.on('data', d => {
    const str = d.toString();
    console.log(`[SERVER] ${str}`);
    if (str.includes('listening')) console.log('Server UP');
});
server.stderr.on('data', d => console.error(`[SERVER ERR] ${d.toString()}`));


setTimeout(async () => {
    try {
        // A. Setup Users
        const PWD = 'SecurePass123!';
        // Company
        await req('POST', '/register', { type: 'empresa', nombre: 'Co', contacto: 'company_test@example.com', password: PWD, legal_name: 'L', address_line1: 'A', address_city: 'C' });
        // Force verify
        const db = require('better-sqlite3')(DB_PATH);
        db.prepare("UPDATE empresas SET verified=1, search_status='ON', is_blocked=0").run();
        const cLog = await (await req('POST', '/login', { type: 'empresa', contacto: 'company_test@example.com', password: PWD })).json();
        const cToken = cLog.token;

        // Driver
        await req('POST', '/register', { type: 'driver', nombre: 'Dr', contacto: 'driver_test@example.com', password: PWD, tipo_licencia: 'B' });
        db.prepare("UPDATE drivers SET verified=1, search_status='ON', is_blocked=0").run();
        const dLog = await (await req('POST', '/login', { type: 'driver', contacto: 'driver_test@example.com', password: PWD })).json();
        const dToken = dLog.token;

        // B. Create Match
        const reqRes = await (await req('POST', '/requests', { licencia_req: 'B', ubicacion: 'X', tiempo_estimado: 10 }, cToken)).json();
        const reqId = reqRes.request_id;

        await req('POST', `/requests/${reqId}/apply`, {}, dToken);

        // Confirm => Generates Ticket
        const confRes = await (await req('POST', `/requests/${reqId}/confirm`, {}, cToken)).json();
        const ticketId = confRes.ticket_id;
        console.log(`Ticket Created: ${ticketId}`);

        // C. Verify Pending
        const summary1 = await (await req('GET', '/billing/summary', null, cToken)).json();
        console.log('Summary Pending:', summary1);

        if (summary1.pending_count !== 1 || summary1.pending_amount_cents !== 999) throw new Error('Summary Pending Mismatch');
        if (summary1.currency !== 'mxn') throw new Error('Currency Mismatch');

        // D. Mark Paid (With Admin Token)
        const payRes = await req('POST', `/billing/tickets/${ticketId}/mark_paid`, { payment_ref: 'REF123' }, cToken, ADM_TOKEN);
        const payData = await payRes.json();
        console.log('Mark Paid:', payRes.status, payData.billing_status);
        if (payData.billing_status !== 'paid') throw new Error('Failed to mark paid');

        // E. Verify Paid
        const summary2 = await (await req('GET', '/billing/summary', null, cToken)).json();
        console.log('Summary Paid:', summary2);
        if (summary2.paid_count !== 1 || summary2.paid_amount_cents !== 999) throw new Error('Summary Paid Mismatch');
        if (summary2.pending_count !== 0) throw new Error('Summary Pending should be 0');

        // F. Try Void (Should Fail 409)
        const voidRes = await req('POST', `/billing/tickets/${ticketId}/void`, {}, cToken, ADM_TOKEN);
        console.log('Void Paid Ticket:', voidRes.status);
        if (voidRes.status !== 409) throw new Error('Should not void paid ticket');

        console.log('✅ TEST PASSED');
        server.kill();
        process.exit(0);

    } catch (e) {
        console.error('❌ TEST FAILED:', e.message);
        server.kill();
        process.exit(1);
    }
}, 6000);
