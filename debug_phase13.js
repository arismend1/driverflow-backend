const db = require('./db_adapter');

async function check() {
    try {
        console.log("--- Checking Weekly Invoices Schema ---");
        // Get column info (Postgres specific usually, but we can try inserting a dummy or just checking metadata if possible. 
        // Simpler: Select * limit 1 and print keys)
        const sample = await db.get("SELECT * FROM invoices LIMIT 1");
        if (sample) {
            console.log("Columns present:", Object.keys(sample).join(', '));
        } else {
            console.log("No invoices found to check schema. Table exists though?");
        }

        console.log("\n--- Checking Recent Jobs ---");
        const jobs = await db.all("SELECT * FROM jobs_queue ORDER BY id DESC LIMIT 5");
        console.log(JSON.stringify(jobs, null, 2));

        console.log("\n--- Checking Recent Invoices ---");
        const invoices = await db.all("SELECT * FROM invoices ORDER BY id DESC LIMIT 5");
        console.log(JSON.stringify(invoices, null, 2));

    } catch (e) {
        console.error("Error:", e);
    }
}

check();
