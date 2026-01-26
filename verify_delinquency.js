const db = require('better-sqlite3')('driverflow.db');
const { execSync } = require('child_process');

console.log("--- Verification: Delinquency Logic ---");

const setup = () => {
    // Clean test data
    db.prepare("DELETE FROM invoices WHERE company_id = 998").run();
    db.prepare("DELETE FROM solicitudes WHERE empresa_id = 998").run();
    db.prepare("DELETE FROM empresas WHERE id = 998").run();

    // Create Test Company
    db.prepare("INSERT INTO empresas (id, nombre, contacto, password_hash, ciudad, is_blocked) VALUES (998, 'BadPayer', 'bad@pay.com', 'hash', 'City', 0)").run();
    console.log("Created Company 998 (Unblocked).");
};

const createOverdueInvoice = (week, id) => {
    // Ensure week is far past
    // Assuming current date is 2026-01-17.
    // Use fixed past weeks.
    const dueDate = '2025-01-01'; // Definitely overdue
    db.prepare(`
        INSERT INTO invoices (id, company_id, billing_week, issue_date, due_date, status, subtotal_cents, total_cents)
        VALUES (?, 998, ?, '2024-12-01', ?, 'pending', 1000, 1000)
    `).run(id, week, dueDate);
};

const checkBlockStatus = () => {
    const row = db.prepare("SELECT is_blocked, blocked_reason FROM empresas WHERE id = 998").get();
    console.log(`Company 998: Blocked=${row.is_blocked}, Reason=${row.blocked_reason}`);
    return row.is_blocked === 1;
};

try {
    setup();

    // 1. Create 3 Overdue Invoices (Threshold is 4)
    console.log("\n>>> Step 1: 3 Overdue Invoices");
    createOverdueInvoice('2024-01', 9001);
    createOverdueInvoice('2024-02', 9002);
    createOverdueInvoice('2024-03', 9003);

    // Call server endpoint simulation (requiring require implies we can't test api easily without curl)
    // We can run a small script that simulates the 'checkAndEnforceBlocking' call or just use mark_invoice_paid dummy?
    // Actually, verify_delinquency should call the helper or trigger the condition.
    // The requirement asks to test logic. 
    // Let's call the helper directly to simulate "system check".
    const { checkAndEnforceBlocking } = require('./delinquency');
    checkAndEnforceBlocking(db, 998);
    if (checkBlockStatus() === true) throw new Error("Should NOT be blocked yet (3 invoices)");

    // 2. Add 4th Overdue Invoice
    console.log("\n>>> Step 2: 4th Overdue Invoice");
    createOverdueInvoice('2024-04', 9004);
    checkAndEnforceBlocking(db, 998); // Trigger
    if (checkBlockStatus() !== true) throw new Error("Should BE blocked now (4 invoices)");

    // 3. Mark 1 Invoice Paid
    console.log("\n>>> Step 3: Paying Invoice 9001");
    execSync("node mark_invoice_paid.js 9001", { stdio: 'inherit' });

    // Check status (script calls logic automatically)
    if (checkBlockStatus() === true) throw new Error("Should be UNBLOCKED now (3 pending)");

    // 4. Idempotency (Pay same invoice)
    console.log("\n>>> Step 4: Pay Invoice 9001 Again (Idempotency)");
    execSync("node mark_invoice_paid.js 9001", { stdio: 'inherit' });
    if (checkBlockStatus() === true) throw new Error("Should remain UNBLOCKED");

    console.log("\n✅ Verification Passed: Blocking/Unblocking logic works.");

} catch (e) {
    console.error("❌ Verification Failed:", e);
    process.exit(1);
}
