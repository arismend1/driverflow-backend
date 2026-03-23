const db = require('./db_adapter');

async function test() {
    try {
        console.log("Testing db.run with multi-params...");
        const res = await db.run(
            "UPDATE potential_matches SET updated_at = ? WHERE id = ? AND status = ?",
            new Date().toISOString(), 1, 'NEW'
        );
        console.log("Success:", res);
        
        console.log("\nTesting db.get...");
        const row = await db.get("SELECT * FROM potential_matches WHERE id = ? AND status = ?", 1, 'NEW');
        console.log("Row:", row);

    } catch (e) {
        console.error("FAILED:", e);
    } finally {
        db.close();
    }
}

test();
