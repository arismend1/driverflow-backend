const Database = require("better-sqlite3");
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || "driverflow.db";
const db = new Database(dbPath, { readonly: true });

// Parse Args
const args = process.argv.slice(2);
const companyId = Number(args[0]);
let limit = 52; // Default to full year

if (!companyId) {
  console.error("Usage: node audit_company_activity.js <company_id> [--limit <N>]");
  process.exit(1);
}

// Handle --limit flag
const limitIdx = args.indexOf('--limit');
if (limitIdx !== -1 && args[limitIdx + 1]) {
  limit = Number(args[limitIdx + 1]);
}

// ---- METRICS HELPERS (Autonomous) ----

const MILLIS_PER_DAY = 1000 * 3600 * 24;

function getMondayFromISOWeekLabel(weekLabel) {
  const [yearStr, weekStr] = String(weekLabel).split("-");
  const year = Number(yearStr);
  const week = Number(weekStr);

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = (jan4.getUTCDay() + 6) % 7;
  const mondayWeek1 = new Date(jan4.valueOf() - day * 86400000);
  const mondayTarget = new Date(mondayWeek1.valueOf() + (week - 1) * 7 * 86400000);
  return mondayTarget.toISOString().slice(0, 10);
}

function pad2(n) { return String(n).padStart(2, "0"); }

function getWeekData(cId, weekLabel) {
  const monday = getMondayFromISOWeekLabel(weekLabel); // YYYY-MM-DD
  const mondayMs = new Date(monday).valueOf(); // UTC midnight

  // 1. Debt at start of week: Invoices created BEFORE monday AND (paid_at IS NULL OR paid_at >= monday)
  // Logic: Invoice exists ('created_at' < monday) and is not paid by monday.
  // Note: generate_weekly_invoices sets 'issue_date'.
  // We assume 'issue_date' is the main timestamp.
  const debtRows = db.prepare(`
    SELECT issue_date, paid_at, total_cents
    FROM invoices 
    WHERE company_id = ?
      AND issue_date < ?
  `).all(cId, monday);

  let pendingCount = 0;
  for (const inv of debtRows) {
    const paidNum = inv.paid_at ? new Date(inv.paid_at).valueOf() : null;
    // If NOT paid OR paid AFTER monday, it was debt on monday.
    if (!paidNum || paidNum >= mondayMs) {
      pendingCount++;
    }
  }

  // 2. Last Payment before Monday
  const lastPayRow = db.prepare(`
    SELECT MAX(paid_at) as last_paid
    FROM invoices
    WHERE company_id = ?
      AND paid_at IS NOT NULL
      AND paid_at < ?
  `).get(cId, monday);

  let lastPaidMs = lastPayRow.last_paid ? new Date(lastPayRow.last_paid).valueOf() : null;

  // 3. First Pending Invoice (Anchor) if no last payment
  let anchorMs = null;
  if (!lastPaidMs && pendingCount > 0) {
    // Find oldest invoice that constitutes debt (created < monday, paid >= monday or null)
    // We want the OLDEST one.
    const oldestDebt = db.prepare(`
        SELECT MIN(issue_date) as oldest
        FROM invoices
        WHERE company_id = ?
          AND issue_date < ?
          AND (paid_at IS NULL OR paid_at >= ?)
      `).get(cId, monday, monday);

    if (oldestDebt.oldest) anchorMs = new Date(oldestDebt.oldest).valueOf();
  }

  // 4. Days Since
  let daysSince = 0;
  if (pendingCount > 0) {
    const ref = lastPaidMs || anchorMs;
    if (ref) {
      daysSince = (mondayMs - ref) / MILLIS_PER_DAY;
    }
  }

  // 5. Activity in Week
  // Tickets created IN this week.
  // We can use 'created_at' between Monday and next Monday.
  const nextMondayMs = mondayMs + (7 * MILLIS_PER_DAY);
  const nextMonday = new Date(nextMondayMs).toISOString().slice(0, 10);

  const tCount = db.prepare(`
    SELECT COUNT(*) as c FROM tickets 
    WHERE company_id = ? 
    AND created_at >= ? AND created_at < ?
  `).get(cId, monday, nextMonday).c;

  const invoice = db.prepare(`
    SELECT id, status FROM invoices
    WHERE company_id = ? AND billing_week = ?
  `).get(cId, weekLabel);

  return {
    week: weekLabel,
    monday,
    pending_at_start: pendingCount,
    days_since_ref: pendingCount > 0 ? daysSince.toFixed(1) : "0.0",
    blocked_rule: (pendingCount > 0 && daysSince >= 28) ? "YES" : "NO",
    ticket_generated: tCount > 0 ? "YES" : "NO",
    tickets: tCount,
    invoice_gen: invoice ? "YES" : "NO"
  };
}

// Main Loop: Full 52 Weeks of 2030
const report = [];
const WEEKS_TO_ANALYZE = 52;

for (let i = 1; i <= WEEKS_TO_ANALYZE; i++) {
  report.push(getWeekData(companyId, `2030-${pad2(i)}`));
}

// Export Full JSON (ALWAYS 52 Weeks)
const jsonFilename = `audit_company_${companyId}_weeks.json`;
// Try to write to logs dir if exists, else current dir
const logDir = path.join(__dirname, '..', 'jobs', 'logs'); // Heuristic based on project structure
let exportPath = jsonFilename;

if (fs.existsSync(logDir)) {
  exportPath = path.join(logDir, jsonFilename);
}

fs.writeFileSync(exportPath, JSON.stringify(report, null, 2));
console.log(`\n📄 Full 52-week audit saved to: ${exportPath}`);


// Display Table (Respecting Limit)
const displayRows = report.slice(0, limit);
console.table(displayRows);

if (limit < WEEKS_TO_ANALYZE) {
  console.log(`... (Showing first ${limit} of ${WEEKS_TO_ANALYZE} weeks. Use --limit 52 to see all)`);
}

console.log("\nSummary of Blockage vs Activity (Checking ALL 52 Weeks):");
const contradictions = report.filter(r => r.blocked_rule === "YES" && r.ticket_generated === "YES");
if (contradictions.length > 0) {
  console.log("❌ VIOLATION DETECTED: Tickets generated while blocked!");
  // Print violations even if hidden by limit
  console.table(contradictions);
} else {
  console.log("✅ No violations. Blocked weeks have 0 tickets.");
}
