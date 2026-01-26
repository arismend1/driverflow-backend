const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');
const { nowIso } = require('./time_provider');
const fs = require('fs');

console.log("--- Seeding Simulation Data ---");

// Clean (Reverse Dependency Order)
db.prepare("DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = 2024)").run();
db.prepare("DELETE FROM invoices WHERE company_id = 2024").run();
db.prepare("DELETE FROM tickets WHERE company_id = 2024").run();
db.prepare("DELETE FROM events_outbox WHERE company_id = 2024").run();
db.prepare("DELETE FROM request_visibility WHERE request_id IN (SELECT id FROM solicitudes WHERE empresa_id = 2024)").run();
db.prepare("DELETE FROM solicitudes WHERE empresa_id = 2024").run();
// Skip deleting driver 1 to avoid FK issues with other test data
db.prepare("DELETE FROM empresas WHERE id = 2024").run();

// Reset Sim State... (unchanged comments omitted for brevity if possible, keeping context)

// Helper to get next Monday... (omitted)

// Create Company
db.prepare("INSERT OR IGNORE INTO drivers (id, nombre, contacto, password_hash, tipo_licencia) VALUES (1, 'SimDriver', 'sim@dr.com', 'hash', 'A')").run();
db.prepare("INSERT INTO empresas (id, nombre, contacto, password_hash, ciudad, is_blocked) VALUES (2024, 'SimCo', 'sim@2024.com', 'hash', 'City', 0)").run();

// Create Requests
const reqSql = "INSERT OR IGNORE INTO solicitudes (id, empresa_id, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion) VALUES (?, 2024, 'A', 'Loc', 10, '2025-12-31')";
for (let i = 1; i <= 4; i++) db.prepare(reqSql).run(200 + i);

// Create Tickets for Current and Future Weeks
// We don't know exact week labels easily without the helper.
// But we can just create tickets with dates spaced 7 days apart starting "Tomorrow".
// `generate_weekly_invoices` detects week from `created_at`.
const now = new Date(); // Real Now
const oneDay = 24 * 3600 * 1000;
const startT = now.getTime() + oneDay; // start tomorrow

for (let i = 0; i < 4; i++) {
    const t = new Date(startT + i * 7 * oneDay);
    const dateStr = t.toISOString().slice(0, 10);
    console.log(`Creating ticket for date: ${dateStr}`);
    // billing_week NULL so it gets derived
    db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, billing_status, created_at) VALUES (2024, 1, ?, 15000, 'unbilled', ?)").run(200 + i + 1, dateStr);
}

console.log("✅ Seeding Complete. Company ID: 2024");
