const db = require('better-sqlite3')('driverflow.db');
const { execSync } = require('child_process');

console.log("--- Verification: Email Outbox ---");

const setup = () => {
    // 1. Clear previous test data
    db.prepare("DELETE FROM events_outbox WHERE metadata LIKE '%TEST_INVOICE_9999%'").run();

    // 2. Insert Dummy Event
    const payload = {
        invoice_id: 9999,
        company_id: 999, // assumes 999 exists from previous verify_billing
        billing_week: '2099-01',
        total_cents: 45000,
        ticket_count: 3,
        tag: 'TEST_INVOICE_9999'
    };

    db.prepare(`
        INSERT INTO events_outbox (event_name, created_at, company_id, request_id, metadata, process_status)
        VALUES ('invoice_generated', datetime('now'), 999, 9999, ?, 'pending')
    `).run(JSON.stringify(payload));

    console.log("Inserted test event for Invoice 9999 (Pending)");

    // 3. Ensure Company Exists
    db.prepare("INSERT OR IGNORE INTO empresas (id, nombre, contacto, password_hash, ciudad) VALUES (999, 'TestComp', 'billing@test.com', 'hash', 'City')").run();
    console.log("Ensured Company 999 exists.");
};

const check = (desc) => {
    console.log(`\nChecking: ${desc}`);
    const evt = db.prepare("SELECT * FROM events_outbox WHERE request_id = 9999").get();
    if (evt) {
        console.log(`Event ${evt.id}: Status=${evt.process_status}, ProcessedAt=${evt.processed_at}, Attempts=${evt.send_attempts}`);
    } else {
        console.log("Event not found.");
    }
};

try {
    setup();

    // A) Run in DRY_RUN Mode
    console.log("\n>>> RUN 1 (DRY_RUN)");
    // Use env option for cross-platform robustness
    execSync("node process_outbox_emails.js", {
        stdio: 'inherit',
        env: { ...process.env, DRY_RUN: '1' }
    });

    check("After Run 1");

    // B) Run Again (Idempotency)
    console.log("\n>>> RUN 2 (Idempotency Check)");
    execSync("node process_outbox_emails.js", {
        stdio: 'inherit',
        env: { ...process.env, DRY_RUN: '1' }
    });

    check("After Run 2");

    console.log("\nPassed if: Run 1 showed 'Would send', Status became 'sent', Run 2 processed 0 events.");

} catch (e) {
    console.error("Verification failed:", e);
}
