const { spawn } = require('child_process');
const http = require('http');

console.log("--- TEST: Payment Webhook Integration ---");

// 1. Start Server
const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '3001', DB_PATH: 'driverflow_test_webhook.db' },
    stdio: 'inherit'
});

server.on('error', (err) => {
    console.error('Failed to start server subprocess:', err);
});

server.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
        console.error(`Server subprocess exited with code ${code}`);
    }
});

console.log("Server starting on port 3001...");

setTimeout(async () => {
    try {
        // 2. Setup Data (Direct DB manipulation for test speed)
        const db = require('better-sqlite3')('driverflow_test_webhook.db');

        // Ensure company exists and is BLOCKED with debt
        db.prepare("INSERT OR IGNORE INTO empresas (id, nombre, contacto, password_hash, ciudad, is_blocked, blocked_reason) VALUES (999, 'TestCo', 'test@co.com', 'pwd', 'City', 1, 'Test Block')").run();

        // Create Overdue Invoice (29 days old)
        const oldDate = '2025-01-01T00:00:00.000Z'; // Way back
        db.prepare("INSERT OR REPLACE INTO invoices (id, company_id, billing_week, issue_date, due_date, status, total_cents) VALUES (100, 999, '2025-01', ?, ?, 'pending', 5000)").run(oldDate, oldDate);

        // CLEANUP PREVIOUS EVENTS
        db.prepare("DELETE FROM events_outbox WHERE request_id = 100 AND event_name = 'invoice_paid'").run();

        console.log("Setup: Company 999 is BLOCKED with Invoice 100 pending.");

        // 3. Trigger Webhook
        const payload = JSON.stringify({
            type: 'invoice.paid',
            data: {
                invoice_id: 100,
                amount_paid_cents: 5000,
                external_ref: 'ch_test_123'
            }
        });

        const req = http.request({
            hostname: 'localhost',
            port: 3001,
            path: '/webhooks/payment',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
                'x-webhook-secret': 'simulated_webhook_secret' // Default from server.js
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`Webhook Response: ${res.statusCode} ${data}`);

                // 4. Verify DB State
                const inv = db.prepare("SELECT status FROM invoices WHERE id = 100").get();
                const co = db.prepare("SELECT is_blocked FROM empresas WHERE id = 999").get();

                console.log(`Invoice Status: ${inv.status} (Expected: paid)`);
                console.log(`Company Blocked: ${co.is_blocked} (Expected: 0)`);

                if (inv.status === 'paid' && co.is_blocked === 0) {
                    console.log("✅ SUCCESS: Invoice paid and Company unblocked!");
                } else {
                    console.error("❌ FAILURE: State not updated correctly.");
                }

                server.kill();
                process.exit(0);
            });
        });

        req.write(payload);
        req.end();

    } catch (e) {
        console.error("Test Error:", e);
        server.kill();
        process.exit(1);
    }
}, 3000); // Wait for server boot
