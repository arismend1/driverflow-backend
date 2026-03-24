const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function runAudit() {
    console.log('==================================================');
    console.log('DRIVERFLOW BILLING SYSTEM - FINAL COMPLIANCE AUDIT');
    console.log('==================================================\n');

    const files = ['server.js', 'worker_queue.js'];
    const results = [];

    // --- [1-6] GREP CHECKS ---
    const checks = [
        { id: 1, label: 'VALIDACIÓN DE ESTADOS (unpaid/billable)', patterns: [/unpaid/i, /billable/i], expected: 0 },
        { id: 2, label: 'VALIDACIÓN DE FACTURACIÓN (IN)', patterns: [/billing_status\s+IN/i], expected: 0 },
        { id: 3, label: "VALIDACIÓN DE QUERY OFICIAL ('unbilled')", patterns: [/billing_status\s*=\s*'unbilled'/i], expected: 1 }, // min 1
        { id: 4, label: 'VALIDACIÓN DE DINERO (amount_cents)', patterns: [/amount_cents/i], expected: 0 },
        { id: 5, label: 'VALIDACIÓN DE HARDCODE (15000)', patterns: [/15000/], expected: 0 },
        { id: 6, label: 'VALIDACIÓN DE IDEMPOTENCIA', patterns: [/idempotency_key/i], expected: 1 } // min 1
    ];

    const logFile = path.join(process.cwd(), 'audit_failures.log');
    fs.writeFileSync(logFile, '--- AUDIT FAILURES LOG ---\n');

    for (const check of checks) {
        let count = 0;
        files.forEach(file => {
            const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, idx) => {
                check.patterns.forEach(pattern => {
                    const matches = line.match(pattern);
                    if (matches) {
                        count++;
                        const msg = `[ALERT] Match found in ${file}:${idx + 1} -> "${line.trim()}"\n`;
                        fs.appendFileSync(logFile, msg);
                        console.log(msg.trim());
                    }
                });
            });
        });
        
        const passed = (check.id === 3 || check.id === 6) ? count >= check.expected : count === check.expected;
        console.log(`[CHECK ${check.id}] ${check.label}: ${passed ? '✅ PASSED' : '❌ FAILED'} (Matches: ${count})`);
        results.push(passed);
    }

    // --- [7-10] SQL CHECKS ---
    const db = require('../db_adapter');
    try {
        console.log('\n--- SQL VALIDATION ---');
        
        // [7] States
        const statesRes = await db.all("SELECT billing_status, count(*) as count FROM tickets GROUP BY billing_status;");
        const allowedStates = ['hold', 'unbilled', 'invoiced', 'paid', 'void', 'pending'];
        const ticketStates = statesRes.map(r => r.billing_status);
        const illegalStates = ticketStates.filter(s => !allowedStates.includes(s));
        console.log(`[CHECK 7] Ticket States: ${illegalStates.length === 0 ? '✅ PASSED' : '❌ FAILED'} (${ticketStates.join(', ')})`);
        if (illegalStates.length > 0) fs.appendFileSync(logFile, `[SQL ERROR] Illegal ticket states: ${illegalStates.join(', ')}\n`);
        results.push(illegalStates.length === 0);

        // [8] Duplicates
        const dupsRes = await db.all("SELECT ticket_id FROM invoice_items GROUP BY ticket_id HAVING count(*) > 1;");
        console.log(`[CHECK 8] Invoice Item Duplicates: ${dupsRes.length === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        if (dupsRes.length > 0) fs.appendFileSync(logFile, `[SQL ERROR] Duplicate ticket_id found in invoice_items: ${JSON.stringify(dupsRes)}\n`);
        results.push(dupsRes.length === 0);

        // [9] Job Duplicates
        const jobsRes = await db.all("SELECT idempotency_key FROM jobs_queue WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING count(*) > 1;");
        console.log(`[CHECK 9] Job Duplicates: ${jobsRes.length === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        if (jobsRes.length > 0) fs.appendFileSync(logFile, `[SQL ERROR] Duplicate idempotency_key found in jobs_queue: ${JSON.stringify(jobsRes)}\n`);
        results.push(jobsRes.length === 0);

        // [10] Janitor
        const janRes = await db.all("SELECT id FROM invoices WHERE status = 'charging' AND updated_at < NOW() - INTERVAL '1 hour';");
        console.log(`[CHECK 10] Stuck Charging Invoices: ${janRes.length === 0 ? '✅ PASSED' : '❌ FAILED'}`);
        if (janRes.length > 0) fs.appendFileSync(logFile, `[SQL ERROR] Stuck charging invoices (>1h): ${JSON.stringify(janRes)}\n`);
        results.push(janRes.length === 0);

    } catch (e) {
        console.error('❌ SQL Validation Error:', e.message);
        fs.appendFileSync(logFile, `❌ SQL Validation Error: ${e.message}\n`);
    } finally {
        db.close();
    }

    console.log('\n==================================================');
    const allPassed = results.every(r => r === true);
    if (allPassed) {
        console.log('🚀 OVERALL STATUS: READY FOR DEPLOY');
        process.exit(0);
    } else {
        console.log('🛑 OVERALL STATUS: DO NOT DEPLOY - AUDIT FAILED');
        process.exit(1);
    }
}

runAudit();
