const { spawn } = require('child_process');
const http = require('http');

console.log("--- TEST: Ticket Voiding Integration ---");

// 1. Start Server
const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: '3002', DB_PATH: 'driverflow_test_void.db' },
    stdio: 'inherit'
});
// Error listeners to catch startup failures
server.on('error', (err) => console.error('Server process error:', err));

setTimeout(async () => {
    try {
        // 2. Setup Data
        const db = require('better-sqlite3')('driverflow_test_void.db');

        // Create dependencies
        db.prepare("INSERT OR IGNORE INTO drivers (id, nombre, contacto, password_hash, tipo_licencia) VALUES (1, 'TestDriver', 'td@test.com', 'pwd', 'A')").run();
        db.prepare("INSERT OR IGNORE INTO empresas (id, nombre, contacto, password_hash, ciudad) VALUES (10, 'TestCo', 'tc@test.com', 'pwd', 'City')").run();
        db.prepare("INSERT OR IGNORE INTO solicitudes (id, empresa_id, driver_id, estado, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion, fecha_creacion) VALUES (1000, 10, 1, 'FINALIZADA', 'A', 'Loc', 10, '2030-01-01', '2025-01-01')").run();

        // Ensure ticket exists
        const now = new Date().toISOString();
        db.prepare("INSERT OR REPLACE INTO tickets (id, company_id, driver_id, request_id, price_cents, billing_status, created_at, currency) VALUES (500, 10, 1, 1000, 15000, 'unbilled', ?, 'USD')").run(now);

        console.log("Setup: Ticket 500 created with status 'unbilled'.");

        // 3. Trigger Void
        const payload = JSON.stringify({
            ticket_id: 500,
            reason: 'Driver No Show'
        });

        const req = http.request({
            hostname: 'localhost',
            port: 3002,
            path: '/admin/tickets/void',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
                'x-admin-secret': 'simulated_admin_secret'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`API Response: ${res.statusCode} ${data}`);

                // 4. Verify DB State
                const t = db.prepare("SELECT billing_status FROM tickets WHERE id = 500").get();

                console.log(`Ticket Status: ${t.billing_status} (Expected: void)`);

                if (t.billing_status === 'void') {
                    console.log("✅ SUCCESS: Ticket voided.");
                } else {
                    console.error("❌ FAILURE: Ticket not voided.");
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
}, 4000);
