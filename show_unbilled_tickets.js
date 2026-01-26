const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log("--- Unbilled Tickets ---");
const tickets = db.prepare(`
    SELECT id, request_id, company_id, driver_id, billing_status, billing_week, created_at 
    FROM tickets 
    WHERE billing_status = 'unbilled'
`).all();

if (tickets.length === 0) {
    console.log("No unbilled tickets found.");
} else {
    console.table(tickets);
}
