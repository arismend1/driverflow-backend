const db = require('./database');

try {
    console.log('--- Migrating Phase 2: Requests Schema Update ---');

    db.exec(`
        PRAGMA foreign_keys=off;

        BEGIN TRANSACTION;

        -- Create new table with correct CHECK constraints for Phase 2
        CREATE TABLE IF NOT EXISTS solicitudes_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL,
            driver_id INTEGER,
            licencia_req TEXT NOT NULL CHECK(licencia_req IN ('A', 'B', 'C')),
            ubicacion TEXT NOT NULL,
            tiempo_estimado INTEGER NOT NULL,
            estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(estado IN ('PENDIENTE', 'APLICADA', 'CONFIRMADA', 'FINALIZADA', 'CANCELADA')),
            fecha_creacion DATETIME DEFAULT (datetime('now')),
            fecha_expiracion DATETIME NOT NULL,
            fecha_cierre DATETIME,
            cancelado_por TEXT,
            ronda_actual INTEGER DEFAULT 0,
            fecha_inicio_ronda DATETIME,
            FOREIGN KEY (empresa_id) REFERENCES empresas(id),
            FOREIGN KEY (driver_id) REFERENCES drivers(id)
        );

        -- Attempt to copy data if table exists (ignore errors if it doesn't)
        INSERT INTO solicitudes_v2 (id, empresa_id, driver_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_creacion, fecha_expiracion)
        SELECT id, empresa_id, driver_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_creacion, fecha_expiracion 
        FROM solicitudes 
        WHERE estado IN ('PENDIENTE', 'APLICADA', 'CONFIRMADA', 'FINALIZADA', 'CANCELADA');

        DROP TABLE IF EXISTS solicitudes;

        ALTER TABLE solicitudes_v2 RENAME TO solicitudes;

        COMMIT;

        PRAGMA foreign_keys=on;
    `);

    console.log('✅ Migración Phase 2 Requests completada: Tabla solicitudes actualizada con nuevos estados.');
} catch (error) {
    console.error('❌ Error en migración Requests:', error.message);
}
