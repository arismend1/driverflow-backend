const db = require('./db_adapter');

async function migrate() {
    try {
        console.log("Creando tabla invoices si no existe...");
        await db.run(`
            CREATE TABLE IF NOT EXISTS invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_id INTEGER NOT NULL,
                week_start TEXT NOT NULL,
                week_end TEXT NOT NULL,
                total_cents INTEGER NOT NULL DEFAULT 0,
                currency TEXT DEFAULT 'usd',
                status TEXT NOT NULL DEFAULT 'pending',
                stripe_payment_intent_id TEXT,
                stripe_charge_id TEXT,
                receipt_url TEXT,
                failure_reason TEXT,
                last_error_code TEXT,
                last_error_message TEXT,
                attempt_count INTEGER DEFAULT 0,
                last_attempt_at TEXT,
                next_retry_at TEXT,
                suspended_at TEXT,
                paid_at TEXT,
                created_at TEXT,
                updated_at TEXT,
                total_requests INTEGER DEFAULT 0,
                active_drivers INTEGER DEFAULT 0
            )
        `);

        // Ensure columns if table already existed without them
        try { await db.run("ALTER TABLE invoices ADD COLUMN stripe_charge_id TEXT;"); } catch (e) { }
        try { await db.run("ALTER TABLE invoices ADD COLUMN receipt_url TEXT;"); } catch (e) { }

        console.log("Migracion completada exitosamente.");
    } catch (e) {
        console.error("Error migrando:", e);
    }
}

migrate();
