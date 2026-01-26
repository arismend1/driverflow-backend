const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH, { readonly: true });

const COMPANY_ID = 2002;

// === ISO week (Monday-based) -> "YYYY-WW" (MISMA lógica que usas en billing)
function getMondayBasedWeekLabel(dateInput) {
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) throw new Error("Invalid date: " + dateInput);

  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7; // Monday=0..Sunday=6
  target.setDate(target.getDate() - dayNr + 3); // Thursday of current week
  const firstThursday = target.valueOf();

  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }

  const weekNumber = 1 + Math.ceil((firstThursday - target) / 604800000);
  const year = target.getFullYear();
  return `${year}-${String(weekNumber).padStart(2, "0")}`;
}

// Trae tickets del cliente 2002
const tickets = db.prepare(`
  SELECT id, created_at, billing_week, billing_status
  FROM tickets
  WHERE company_id = ?
  ORDER BY datetime(created_at) ASC
`).all(COMPANY_ID);

// Agrupa por semana (usa billing_week si existe; si no, calcula por created_at)
const weeks = {};
for (const t of tickets) {
  const week = (t.billing_week && String(t.billing_week).trim())
    ? String(t.billing_week).trim()
    : getMondayBasedWeekLabel(t.created_at);

  if (!weeks[week]) weeks[week] = { total: 0, billed: 0, unbilled: 0, ticket_ids: [] };
  weeks[week].total += 1;
  weeks[week].ticket_ids.push(t.id);

  if (t.billing_status === "billed") weeks[week].billed += 1;
  if (t.billing_status === "unbilled") weeks[week].unbilled += 1;
}

// Imprime 2030-01..2030-52 con SI/NO
const out = [];
for (let i = 1; i <= 52; i++) {
  const w = `2030-${String(i).padStart(2, "0")}`;
  const row = weeks[w] || { total: 0, billed: 0, unbilled: 0, ticket_ids: [] };

  out.push({
    week: w,
    ticket_generated: row.total > 0 ? "YES" : "NO",
    tickets_total: row.total,
    billed: row.billed,
    unbilled: row.unbilled,
    ticket_ids: row.ticket_ids.join(",")
  });
}

console.table(out);

// Resumen corto
const yes = out.filter(r => r.ticket_generated === "YES").map(r => r.week);
const no  = out.filter(r => r.ticket_generated === "NO").map(r => r.week);

console.log("\nSUMMARY:");
console.log("Generated tickets weeks:", yes.length, yes.join(" "));
console.log("NO ticket weeks:", no.length, no.join(" "));
