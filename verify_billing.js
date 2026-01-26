const db = require('better-sqlite3')('driverflow.db');
const { execSync } = require('child_process');

console.log("--- Starting Verification: Billing ---");

const cleanup = () => {
    try {
        db.prepare("DELETE FROM invoice_items WHERE ticket_id IN (99901, 99902, 99903, 99904)").run();
        db.prepare("DELETE FROM tickets WHERE id IN (99901, 99902, 99903, 99904)").run();
        db.prepare("DELETE FROM events_outbox WHERE company_id = 999").run();
        db.prepare("DELETE FROM invoices WHERE company_id = 999").run(); // cascade? No, manual delete items first.

        // Clean up dependencies
        db.prepare("DELETE FROM solicitudes WHERE id IN (777, 778, 779, 780)").run();
        db.prepare("DELETE FROM drivers WHERE id = 888").run();
        db.prepare("DELETE FROM empresas WHERE id = 999").run();
    } catch (e) {
        console.log("Cleanup warning:", e.message);
    }
};

const setup = () => {
    cleanup();

    // Create Test Company
    db.prepare("INSERT INTO empresas (id, nombre, contacto, password_hash, ciudad) VALUES (999, 'TestComp', 'test@test.com', 'hash', 'City')").run();

    // Create Driver
    db.prepare("INSERT INTO drivers (id, nombre, contacto, password_hash, tipo_licencia) VALUES (888, 'TestDriver', 'd@d.com', 'hash', 'A')").run();

    // Create Requests
    const reqSql = "INSERT INTO solicitudes (id, empresa_id, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion) VALUES (?, 999, 'A', 'Loc', 10, datetime('now'))";
    db.prepare(reqSql).run(777);
    db.prepare(reqSql).run(778);
    db.prepare(reqSql).run(779);
    db.prepare(reqSql).run(780);

    // Tickets
    // 1 & 2: Week 2099-01
    db.prepare(`
        INSERT INTO tickets (id, company_id, driver_id, request_id, price_cents, created_at, billing_status, billing_week)
        VALUES (99901, 999, 888, 777, 15000, '2099-01-01', 'unbilled', '2099-01')
    `).run();
    db.prepare(`
        INSERT INTO tickets (id, company_id, driver_id, request_id, price_cents, created_at, billing_status, billing_week)
        VALUES (99902, 999, 888, 778, 15000, '2099-01-02', 'unbilled', '2099-01')
    `).run();

    // 3: Week 2099-02 (Should be ignored)
    db.prepare(`
        INSERT INTO tickets (id, company_id, driver_id, request_id, price_cents, created_at, billing_status, billing_week)
        VALUES (99903, 999, 888, 779, 15000, '2099-02-01', 'unbilled', '2099-02')
    `).run();

    // 4: Null billing_week, but date implies 2099-01.
    // 2099-01-02 is in week 2099-01 (Assuming ISO).
    db.prepare(`
        INSERT INTO tickets (id, company_id, driver_id, request_id, price_cents, created_at, billing_status, billing_week)
        VALUES (99904, 999, 888, 780, 15000, '2099-01-02 12:00:00', 'unbilled', NULL)
    `).run();
}

const check = (desc) => {
    console.log(`\nChecking: ${desc}`);
    const inv = db.prepare("SELECT * FROM invoices WHERE billing_week='2099-01' AND company_id=999").get();
    if (!inv) {
        console.log("Invoice not found!");
        return;
    }
    const items = db.prepare("SELECT * FROM invoice_items WHERE invoice_id=?").all(inv.id);
    console.log(`Invoice ID: ${inv.id}, Subtotal: ${inv.subtotal_cents}, Items: ${items.length}`);

    // Check specific items presence
    const itemIds = items.map(i => i.ticket_id).sort();
    console.log(`Item Ticket IDs: ${itemIds.join(', ')}`);

    const tickets = db.prepare("SELECT id, billing_status, billing_week FROM tickets WHERE id IN (99901, 99902, 99903, 99904) ORDER BY id").all();
    tickets.forEach(t => console.log(`Ticket ${t.id}: ${t.billing_status} (Week: ${t.billing_week})`));

    // Event checking
    // request_id is the invoice_id for this event
    const evt = db.prepare("SELECT * FROM events_outbox WHERE request_id = ? AND event_name='invoice_generated'").get(inv.id);
    console.log(`Event found: ${!!evt}`);
    if (evt) console.log(`Event Metadata: ${evt.metadata}`);
}

try {
    setup();

    // A) Run Generation
    console.log(">>> RUN 1 (Clean) for 2099-01");
    execSync("node generate_weekly_invoices.js 2099-01", { stdio: 'inherit' });
    check("After Run 1");

    // B) Re-run (Idempotency)
    console.log(">>> RUN 2 (Idempotency)");
    execSync("node generate_weekly_invoices.js 2099-01", { stdio: 'inherit' });
    check("After Run 2");

    // Cleanup
    cleanup();
    console.log("\nPassed if: Run 1 has 3 items (99901, 99902, 99904), Subtotal 45000, Run 2 has same.");

} catch (e) {
    console.error("Verification failed:", e);
    // Try to cleanup anyway
    cleanup();
}
