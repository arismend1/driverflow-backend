const db = require('./db_adapter');

async function run() {
    console.log("--- Initializing push_tokens table ---");
    try {
        await db.run(`
            CREATE TABLE IF NOT EXISTS push_tokens (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                token TEXT NOT NULL,
                platform TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, token)
            )
        `);
        console.log("✅ Table push_tokens created or already exists.");
    } catch (e) {
        console.error("❌ Failed to create push_tokens table:", e.message);
        process.exit(1);
    }
}

if (require.main === module) {
    run();
}
