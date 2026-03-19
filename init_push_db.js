const db = require('./db_adapter');

async function run() {
    console.log("--- Initializing push_tokens table ---");
    try {
        // 1. Crear tabla base sin restricciones de unicidad internas
        await db.run(`
            CREATE TABLE IF NOT EXISTS push_tokens (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                token TEXT NOT NULL,
                platform TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Comprobar existencia del índice nombrado como única fuente de verdad
        let indexExists = false;
        if (db.IS_POSTGRES) {
            const res = await db.get("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_push_tokens_user_token'");
            indexExists = !!res;
        } else {
            const res = await db.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_push_tokens_user_token'");
            indexExists = !!res;
        }

        if (!indexExists) {
            console.log("⚠️ Unique index missing. Starting safe migration...");
            
            // 3. Limpieza quirúrgica (CTE + ROW_NUMBER) - Compatible con Postgres y SQLite 3.25+
            await db.run(`
                WITH ranked AS (
                  SELECT id,
                         ROW_NUMBER() OVER (
                           PARTITION BY user_id, token
                           ORDER BY id
                         ) AS rn
                  FROM push_tokens
                )
                DELETE FROM push_tokens
                WHERE id IN (
                  SELECT id FROM ranked WHERE rn > 1
                )
            `);
            console.log("✅ Duplicates removed.");

            // 4. Crear el índice único como mecanismo definitivo
            await db.run(`CREATE UNIQUE INDEX idx_push_tokens_user_token ON push_tokens(user_id, token)`);
            console.log("✅ Unique index 'idx_push_tokens_user_token' created.");
        } else {
            console.log("ℹ️ Unique index already exists. Skipping migration.");
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
