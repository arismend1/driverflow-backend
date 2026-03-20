const db = require('./db_adapter');

async function run() {
    console.log("--- Initializing push_tokens table ---");
    try {
        // 1. Create base table
        await db.run(`
            CREATE TABLE IF NOT EXISTS push_tokens (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                user_type TEXT NOT NULL DEFAULT 'unknown',
                token TEXT NOT NULL,
                platform TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Ensure user_type column exists (safe migration for existing tables)
        try {
            if (db.IS_POSTGRES) {
                await db.run("ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS user_type TEXT NOT NULL DEFAULT 'unknown'");
            } else {
                await db.run("ALTER TABLE push_tokens ADD COLUMN user_type TEXT NOT NULL DEFAULT 'unknown'");
            }
            console.log("✅ user_type column ensured.");
        } catch (colErr) {
            // Column already exists — safe to ignore
            console.log("ℹ️ user_type column already exists.");
        }

        // 3. Drop old unique index on (user_id, token) if it exists — it's wrong now
        let oldIndexExists = false;
        if (db.IS_POSTGRES) {
            const res = await db.get("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_push_tokens_user_token'");
            oldIndexExists = !!res;
        } else {
            const res = await db.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_push_tokens_user_token'");
            oldIndexExists = !!res;
        }

        if (oldIndexExists) {
            console.log("⚠️ Dropping old unique index idx_push_tokens_user_token (user_id, token)...");
            await db.run("DROP INDEX idx_push_tokens_user_token");
            console.log("✅ Old index dropped.");
        }

        // 4. Clean up duplicates based on new key (user_id, user_type, token)
        await db.run(`
            WITH ranked AS (
              SELECT id,
                     ROW_NUMBER() OVER (
                       PARTITION BY user_id, user_type, token
                       ORDER BY id
                     ) AS rn
              FROM push_tokens
            )
            DELETE FROM push_tokens
            WHERE id IN (
              SELECT id FROM ranked WHERE rn > 1
            )
        `);
        console.log("✅ Duplicates cleaned (by user_id, user_type, token).");

        // 5. Create correct unique index on (user_id, user_type, token)
        let newIndexExists = false;
        if (db.IS_POSTGRES) {
            const res2 = await db.get("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_push_tokens_user_type_token'");
            newIndexExists = !!res2;
        } else {
            const res2 = await db.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_push_tokens_user_type_token'");
            newIndexExists = !!res2;
        }

        if (!newIndexExists) {
            await db.run("CREATE UNIQUE INDEX idx_push_tokens_user_type_token ON push_tokens(user_id, user_type, token)");
            console.log("✅ Unique index 'idx_push_tokens_user_type_token' created on (user_id, user_type, token).");
        } else {
            console.log("ℹ️ Unique index 'idx_push_tokens_user_type_token' already exists.");
        }

        console.log("🏁 push_tokens initialization finished.");
    } catch (e) {
        console.error("❌ Critical error:", e.message);
        process.exit(1);
    }
}

module.exports = run;

if (require.main === module) {
    run();
}
