const db = require('./db_adapter');

async function check() {
    console.log("--- PUSH TOKENS DIAGNOSTIC ---");
    try {
        // 1. Check schema (Postgres or SQLite)
        if (db.IS_POSTGRES) {
            console.log("Checking Postgres schema...");
            const constraints = await db.all(`
                SELECT conname, pg_get_constraintdef(c.oid) 
                FROM pg_constraint c 
                JOIN pg_namespace n ON n.oid = c.connamespace 
                WHERE conrelid = 'push_tokens'::regclass
            `);
            console.log("Constraints:", JSON.stringify(constraints, null, 2));
        } else {
            console.log("Checking SQLite schema...");
            const info = await db.all("PRAGMA table_info(push_tokens)");
            console.log("Table Info:", JSON.stringify(info, null, 2));
            const indexes = await db.all("PRAGMA index_list(push_tokens)");
            console.log("Indexes:", JSON.stringify(indexes, null, 2));
        }

        // 2. Check for duplicates
        const dups = await db.all(`
            SELECT user_id, token, COUNT(*) as count 
            FROM push_tokens 
            GROUP BY user_id, token 
            HAVING COUNT(*) > 1
        `);
        console.log("Duplicates found:", JSON.stringify(dups, null, 2));

        // 3. Count total rows
        const count = await db.get("SELECT COUNT(*) as c FROM push_tokens");
        console.log("Total rows:", count.c);

    } catch (e) {
        console.error("Check failed:", e.message);
    } finally {
        db.close();
    }
}

check();
