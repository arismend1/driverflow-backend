const db = require('./db_adapter');
const time = require('./time_contract');

async function getMondayBasedWeekLabel(dateInput) {
  const date = new Date(dateInput);
  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  const weekNumber = 1 + Math.ceil((firstThursday - target) / 604800000);
  return `${target.getFullYear()}-${String(weekNumber).padStart(2, '0')}`;
}

async function getFridayFromWeek(weekLabel) {
  const [year, week] = weekLabel.split('-').map(Number);
  const jan4 = new Date(year, 0, 4);
  const day = (jan4.getDay() + 6) % 7;
  const mondayWeek1 = new Date(jan4.valueOf() - day * 86400000);
  const mondayTarget = new Date(mondayWeek1.valueOf() + (week - 1) * 7 * 86400000);
  return new Date(mondayTarget.valueOf() + 4 * 86400000).toISOString().split('T')[0];
}

async function run() {
  const targetWeek = process.argv[2] || await getMondayBasedWeekLabel(time.nowIso({ ctx: 'billing_cli' }));
  console.log(`--- Generating Invoices for Week: ${targetWeek} ---`);

  const unbilledTickets = await db.all("SELECT * FROM tickets WHERE billing_status = 'pending' OR billing_status = 'unbilled'");

  // Group by company
  const ticketsByCompany = {};
  for (const t of unbilledTickets) {
    let w = t.billing_week;
    if (!w) {
      const date = new Date(t.created_at);
      w = await getMondayBasedWeekLabel(date);
    }
    if (w === targetWeek) {
      if (!ticketsByCompany[t.company_id]) ticketsByCompany[t.company_id] = [];
      ticketsByCompany[t.company_id].push(t);
    }
  }

  for (const [companyId, tickets] of Object.entries(ticketsByCompany)) {
    console.log(`Processing Company ${companyId}: ${tickets.length} tickets...`);
    const dueDate = await getFridayFromWeek(targetWeek);

    try {
      await db.run('BEGIN');

      // Insert Invoice
      await db.run(
        `INSERT INTO invoices (company_id, billing_week, issue_date, due_date, status, currency) 
                 VALUES (?, ?, ?, ?, 'pending', 'USD') 
                 ON CONFLICT (company_id, billing_week) DO NOTHING`,
        companyId, targetWeek, time.nowIso({ ctx: 'billing_insert' }), dueDate
      );

      const invoice = await db.get("SELECT id FROM invoices WHERE company_id = ? AND billing_week = ?", companyId, targetWeek);
      if (!invoice) throw new Error('Invoice creation failed');

      for (const ticket of tickets) {
        await db.run(
          `INSERT INTO invoice_items (invoice_id, ticket_id, price_cents) VALUES (?, ?, ?)
                     ON CONFLICT (invoice_id, ticket_id) DO NOTHING`,
          invoice.id, ticket.id, ticket.price_cents
        );
        await db.run("UPDATE tickets SET billing_status = 'invoiced', billing_week = ? WHERE id = ?", targetWeek, ticket.id);
      }

      // Update Totals
      const totals = await db.get("SELECT SUM(price_cents) as subtotal, COUNT(*) as cnt FROM invoice_items WHERE invoice_id = ?", invoice.id);
      await db.run("UPDATE invoices SET subtotal_cents = ?, total_cents = ? WHERE id = ?", totals.subtotal, totals.subtotal, invoice.id);

      await db.run('COMMIT');
      console.log(`✅ Invoice ${invoice.id} generated.`);
    } catch (e) {
      await db.run('ROLLBACK');
      console.error(`❌ Failed for Company ${companyId}:`, e.message);
    }
  }
}

if (require.main === module) {
  run().catch(console.error);
}
