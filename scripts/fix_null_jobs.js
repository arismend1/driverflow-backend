const db = require('../db_adapter');

async function run() {
    console.log("🔧 Fixing stuck jobs...");
    try {
        // Fix Internal: status IS NULL -> 'pending'
        const res = await db.run("UPDATE jobs_queue SET status='pending' WHERE status IS NULL");

        // Check how many were fixed? DB adapter result structure varies (pg vs sqlite)
        // We'll just count them afterwards or assume success.
        console.log("✅ Update command executed.");

        const count = await db.get("SELECT count(*) as c FROM jobs_queue WHERE status='pending'");
        console.log(`📊 Pending jobs count: ${count?.c || 0}`);

    } catch (e) {
        console.error("❌ Error fixing jobs:", e);
    }
}

// Check for main module if we want to run it directly, 
// but db_adapter might rely on env vars.
// We'll wrap in a block that waits for connection if needed or just runs.
// db_adapter is async usually? It exports query functions.

run().then(() => {
    console.log("👋 Done.");
    process.exit(0);
}).catch(err => {
    console.error("💥 Fatal Error:", err);
    process.exit(1);
});
