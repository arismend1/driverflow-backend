const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');

console.log('--- Migrating Phase 4: Double Opt-in (Schema Update) ---');

try {
    db.exec(`
        PRAGMA foreign_keys=off;

        BEGIN TRANSACTION;

        -- 1. Create new table with updated CHECK constraint (adding EN_REVISION)
        -- Also removing round columns from constraint if any (they are just INTs so fine)
        CREATE TABLE IF NOT EXISTS solicitudes_v4 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL,
            driver_id INTEGER,
            licencia_req TEXT NOT NULL CHECK(licencia_req IN ('A', 'B', 'C')),
            ubicacion TEXT NOT NULL,
            tiempo_estimado INTEGER NOT NULL,
            estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(estado IN ('PENDIENTE', 'EN_REVISION', 'ACEPTADA', 'EXPIRADA', 'FINALIZADA', 'CANCELADA')),
            fecha_creacion DATETIME DEFAULT (datetime('now')),
            fecha_expiracion DATETIME NOT NULL,
            fecha_cierre DATETIME,
            cancelado_por TEXT,
            ronda_actual INTEGER DEFAULT 1,
            fecha_inicio_ronda DATETIME,
            FOREIGN KEY (empresa_id) REFERENCES empresas(id),
            FOREIGN KEY (driver_id) REFERENCES drivers(id)
        );

        -- 2. Copy Data
        INSERT INTO solicitudes_v4 (id, empresa_id, driver_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_creacion, fecha_expiracion, fecha_cierre, cancelado_por, ronda_actual, fecha_inicio_ronda)
        SELECT id, empresa_id, driver_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_creacion, fecha_expiracion, fecha_cierre, cancelado_por, ronda_actual, fecha_inicio_ronda FROM solicitudes;

        -- 3. Drop Old
        DROP TABLE solicitudes;

        -- 4. Rename New
        ALTER TABLE solicitudes_v4 RENAME TO solicitudes;

        COMMIT;

        PRAGMA foreign_keys=on;
    `);

    console.log('✅ Migration Phase 4 complete: Added EN_REVISION state.');
} catch (error) {
    console.error('❌ Migration Error:', error.message);
    process.exit(1);
}
