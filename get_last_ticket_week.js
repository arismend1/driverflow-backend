const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

// Helper: Get Monday-based week label (YYYY-WW)
// COPIED FROM generate_weekly_invoices.js to ensure exact match
function getMondayBasedWeekLabel(dateInput) {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) {
        throw new Error(`Invalid date: ${dateInput}`);
    }

    // Adjust to Monday-based week
    const target = new Date(date.valueOf());
    const dayNr = (date.getDay() + 6) % 7; // Monday=0, Sunday=6
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
        target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
    }
    const weekNumber = 1 + Math.ceil((firstThursday - target) / 604800000);
    const year = target.getFullYear(); // ISO week year
    return `${year}-${String(weekNumber).padStart(2, '0')}`;
}

const lastTicket = db.prepare('SELECT billing_week, created_at FROM tickets ORDER BY id DESC LIMIT 1').get();

if (!lastTicket) {
    console.error("No tickets found.");
    process.exit(1);
}

let week = lastTicket.billing_week;
if (!week) {
    week = getMondayBasedWeekLabel(lastTicket.created_at);
}

console.log(`BILLING_WEEK=${week}`);
