const db = require('./db_adapter');

async function checkResult() {
    try {
        console.log("--- Checking Job Status ---");
        // Get the last job (which should be our charge job)
        const job = await db.get("SELECT * FROM jobs_queue ORDER BY id DESC LIMIT 1");
        console.log("Last Job:", JSON.stringify(job, null, 2));

        console.log("\n--- Checking Invoice #5 ---");
        const inv = await db.get("SELECT * FROM invoices WHERE id = 5");
        console.log("Invoice 5:", JSON.stringify(inv, null, 2));

    } catch (e) {
        console.error("DB Error:", e);
    }
}

checkResult();
