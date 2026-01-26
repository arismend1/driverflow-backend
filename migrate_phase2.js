const db = require('./database');

try {
    // Agregar columnas nuevas para Fase 2
    // Nota: Como SQLite no permite modificar constraints CHECK fácilmente en columnas existentes sin recrear tabla,
    // manejaremos la validación de nuevos estados (FINALIZADA, CANCELADA) en lógica de aplicación
    // y asumiremos que la columna 'estado' existente TEXT permite los nuevos valores si no fuera por el CHECK original.
    // Sin embargo, en SQLite los CHECK constraints se definen al crear la tabla. 
    // Para MVP rápido sin recrear tablas: ignoraremos el CHECK constraint a nivel de BD si falla, 
    // o idealmente recreariamos la tabla.
    // DADO QUE ES MVP y se pidió NO REFACTORIZAR FASE 1:
    // La estrategia más segura es simplemente agregar las columnas informativas.
    // El constraint CHECK de la FASE 1 (PENDIENTE, ACEPTADA, EXPIRADA) podría bloquear los nuevos estados.
    // SI db.js definió CHECK estricto, debemos hacer un migration real 'ALTER TABLE...'.
    // PERO SQLite NO soporta DROP CONSTRAINT. 
    // HACK MVP: Como 'estado' es TEXT, si SQLite no enforcea CHECKs en ALTERs antiguos (depende version), probamos.
    // Si falla, la única forma correcta en SQLite es recrear: Rename -> Create New -> Copy -> Drop Old.
    // Procederemos con el script de migración estándar de SQLite.

    db.exec(`
        PRAGMA foreign_keys=off;

        BEGIN TRANSACTION;

        CREATE TABLE IF NOT EXISTS solicitudes_f2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL,
            driver_id INTEGER,
            licencia_req TEXT NOT NULL CHECK(licencia_req IN ('A', 'B', 'C')),
            ubicacion TEXT NOT NULL,
            tiempo_estimado INTEGER NOT NULL,
            estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(estado IN ('PENDIENTE', 'ACEPTADA', 'EXPIRADA', 'FINALIZADA', 'CANCELADA')),
            fecha_creacion DATETIME DEFAULT (datetime('now')),
            fecha_expiracion DATETIME NOT NULL,
            fecha_cierre DATETIME,
            cancelado_por TEXT,
            FOREIGN KEY (empresa_id) REFERENCES empresas(id),
            FOREIGN KEY (driver_id) REFERENCES drivers(id)
        );

        INSERT INTO solicitudes_f2 (id, empresa_id, driver_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_creacion, fecha_expiracion)
        SELECT id, empresa_id, driver_id, licencia_req, ubicacion, tiempo_estimado, estado, fecha_creacion, fecha_expiracion FROM solicitudes;

        DROP TABLE solicitudes;

        ALTER TABLE solicitudes_f2 RENAME TO solicitudes;

        COMMIT;

        PRAGMA foreign_keys=on;
    `);

    console.log('Migración Fase 2 completada: Tabla solicitudes actualizada.');
} catch (error) {
    console.error('Error en migración:', error.message);
}
