const db = require('./db_adapter');

async function migrate() {
    console.log("--- Hardening Auth Indexes (Email/Phone) ---");
    console.log("Engine:", db.IS_POSTGRES ? "POSTGRES" : "SQLITE");

    try {
        if (db.IS_POSTGRES) {
            // Postgres: Use 'email' and 'telefono'
            console.log("Applying Postgres UNIQUE indexes...");
            await db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_email ON drivers(email);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_phone ON drivers(phone);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_email ON empresas(email);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_telefono ON empresas(telefono);
            `);
        } else {
            // SQLite: Use 'contacto' and 'phone'/'contact_phone'
            console.log("Applying SQLite UNIQUE indexes...");
            await db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_contacto ON drivers(contacto);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_phone ON drivers(phone);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_contacto ON empresas(contacto);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_phone ON empresas(contact_phone);
            `);
        }
        console.log("✅ Auth indexes applied successfully.");
    } catch (e) {
        console.error("❌ Migration Failed:", e.message);
    } finally {
        db.close();
    }
}

migrate();
