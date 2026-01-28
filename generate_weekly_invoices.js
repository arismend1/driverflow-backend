// ⚠️ FROZEN LOGIC — DO NOT MODIFY
const DB_PATH_ENV = process.env.DB_PATH || 'driverflow.db';
console.log(`[Generator] Connecting to DB: ${DB_PATH_ENV}`);
const db = require('better-sqlite3')(DB_PATH_ENV);

if (process.env.DEBUG_DB) {
  const list = db.prepare("PRAGMA database_list").all();
  console.log("[DB_LIST]", JSON.stringify(list));
}
const { checkAndEnforceBlocking } = require('./delinquency');
const time = require('./time_contract');
// const { nowIso } = require('./time_provider'); // DEPRECATED

// ISO week label (YYYY-WW) Monday-based
function getMondayBasedWeekLabel(dateInput) {
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) throw new Error(`Invalid date: ${dateInput}`);

  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7; // Mon=0..Sun=6
  target.setDate(target.getDate() - dayNr + 3);

  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }

  const weekNumber = 1 + Math.ceil((firstThursday - target) / 604800000);
  const year = target.getFullYear();
  return `${year}-${String(weekNumber).padStart(2, '0')}`;
}

function getFridayFromWeek(weekLabel) {
  const [year, week] = weekLabel.split('-').map(Number);
  const jan4 = new Date(year, 0, 4);
  const day = (jan4.getDay() + 6) % 7;
  const mondayWeek1 = new Date(jan4.valueOf() - day * 86400000);
  const mondayTarget = new Date(mondayWeek1.valueOf() + (week - 1) * 7 * 86400000);
  const friday = new Date(mondayTarget.valueOf() + 4 * 86400000);
  return friday.toISOString().split('T')[0]; // YYYY-MM-DD
}

const getWeekFromDateStr = (dateStr) => getMondayBasedWeekLabel(new Date(dateStr));

const targetWeek = process.argv[2] || getMondayBasedWeekLabel(time.nowIso({ ctx: 'billing_cli' }));
console.log(`--- Generating Invoices for Week: ${targetWeek} ---`);

function run() {
  const unbilledTickets = db.prepare(`
    SELECT * FROM tickets WHERE billing_status = 'unbilled'
  `).all();

  const ticketsToBill = unbilledTickets.filter(t => {
    let w = t.billing_week;
    if (!w) w = getWeekFromDateStr(t.created_at);
    return w === targetWeek;
  });

  console.log(`Found ${ticketsToBill.length} unbilled tickets for week ${targetWeek}.`);

  if (ticketsToBill.length === 0) {
    console.log('No tickets to process.');
    return;
  }

  const ticketsByCompany = {};
  for (const t of ticketsToBill) {
    const cId = Number(t.company_id);
    if (!ticketsByCompany[cId]) ticketsByCompany[cId] = [];
    ticketsByCompany[cId].push(t);
  }

  for (const companyIdStr of Object.keys(ticketsByCompany)) {
    const companyId = Number(companyIdStr);
    const companyTickets = ticketsByCompany[companyId];

    console.log(`Processing Company ${companyId}: ${companyTickets.length} tickets...`);

    // ALLOW BILLING even if blocked. 
    // If tickets exist (service rendered), the debt must be formalized.
    // Access control prevents NEW tickets, but Billing must process OLD ones.

    const tx = db.transaction(() => {
      const dueDate = getFridayFromWeek(targetWeek);

      db.prepare(`
        INSERT OR IGNORE INTO invoices (company_id, billing_week, issue_date, due_date, status, currency)
        VALUES (?, ?, ?, ?, 'pending', 'USD')
      `).run(companyId, targetWeek, time.nowIso({ ctx: 'billing_insert' }), dueDate);

      const invoice = db.prepare(`
        SELECT id FROM invoices WHERE company_id = ? AND billing_week = ?
      `).get(companyId, targetWeek);

      if (!invoice) throw new Error('Failed to retrieve invoice');

      for (const ticket of companyTickets) {
        let currentTicketWeek = ticket.billing_week;
        if (!currentTicketWeek) {
          currentTicketWeek = getWeekFromDateStr(ticket.created_at);
          db.prepare(`UPDATE tickets SET billing_week = ? WHERE id = ?`).run(currentTicketWeek, ticket.id);
        }

        db.prepare(`
          INSERT OR IGNORE INTO invoice_items (invoice_id, ticket_id, price_cents)
          VALUES (?, ?, ?)
        `).run(invoice.id, ticket.id, ticket.price_cents);

        db.prepare(`UPDATE tickets SET billing_status = 'billed' WHERE id = ?`).run(ticket.id);
      }

      const totals = db.prepare(`
        SELECT COALESCE(SUM(price_cents),0) AS subtotal, COUNT(*) AS count
        FROM invoice_items WHERE invoice_id = ?
      `).get(invoice.id);

      db.prepare(`
        UPDATE invoices SET subtotal_cents = ?, total_cents = ? WHERE id = ?
      `).run(totals.subtotal, totals.subtotal, invoice.id);

      const payload = {
        invoice_id: invoice.id,
        company_id: companyId,
        billing_week: targetWeek,
        total_cents: totals.subtotal,
        ticket_count: totals.count
      };

      try {
        db.prepare(`
          INSERT INTO events_outbox (event_name, created_at, company_id, request_id, metadata)
          VALUES ('invoice_generated', ?, ?, ?, ?)
        `).run(time.nowIso({ ctx: 'billing_event' }), companyId, invoice.id, JSON.stringify(payload));
        console.log(`Event emitted for invoice ${invoice.id}`);
      } catch (err) {
        if (!String(err.message).includes('UNIQUE constraint failed')) throw err;
        console.log(`Event already emitted for invoice ${invoice.id}`);
      }

      // Optional: re-check after changes (doesn't hurt)
      checkAndEnforceBlocking(db, companyId);
    });

    tx();
    console.log(`Company ${companyId} invoices generated successfully.`);
  }
}

try {
  run();
} catch (e) {
  console.error('Script failed:', e);
  process.exit(1);
}
