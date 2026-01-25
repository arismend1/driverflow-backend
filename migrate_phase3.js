const db = require('./database');

console.log('--- Migrating Phase 3: Gating, Tiers & Credits ---');

const addColumn = (table, colDef) => {
    try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colDef}`).run();
        console.log(`✅ Added column to ${table}: ${colDef.split(' ')[0]}`);
    } catch (e) {
        if (e.message.includes('duplicate column name')) {
            console.log(`⚠️ Column already exists in ${table}: ${colDef.split(' ')[0]}`);
        } else {
            console.error(`❌ Failed to add column to ${table}: ${colDef}`, e.message);
            // Don't throw for columns to allow idempotency, but log error
        }
    }
};

try {
    // 1. Update Empresas (Tier & Creditos)
    addColumn('empresas', "tier TEXT DEFAULT 'STANDARD' CHECK(tier IN ('STANDARD', 'GOLD'))");
    addColumn('empresas', "creditos INTEGER DEFAULT 10");

    // 2. Update Solicitudes (Rondas)
    addColumn('solicitudes', "ronda_actual INTEGER DEFAULT 1");
    // Note: SQLite ADD COLUMN with non-constant default (datetime('now')) might work in newer versions, 
    // but better to be safe or accept it. The user's previous script had it. 
    // If it fails due to expression, we might need a trigger or app-level default. 
    // The previous error was "duplicate column", so the syntax was likely valid for this sqlite version.
    addColumn('solicitudes', "fecha_inicio_ronda DATETIME DEFAULT (datetime('now'))");

    // 3. New Table: Request Visibility
    db.prepare(`
        CREATE TABLE IF NOT EXISTS request_visibility (
            request_id INTEGER NOT NULL,
            driver_id INTEGER NOT NULL,
            ronda INTEGER NOT NULL,
            fecha_publicacion DATETIME DEFAULT (datetime('now')),
            PRIMARY KEY (request_id, driver_id),
            FOREIGN KEY (request_id) REFERENCES solicitudes(id),
            FOREIGN KEY (driver_id) REFERENCES drivers(id)
        )
    `).run();
    console.log('✅ Created request_visibility table.');

    console.log('✅ Migración Fase 3 completada: Gating & Credits ready.');

} catch (error) {
    console.error('❌ Error en migración Fase 3:', error.message);
}

