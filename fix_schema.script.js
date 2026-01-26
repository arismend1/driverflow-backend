const db = require('better-sqlite3')(process.env.DB_PATH || 'driverflow.db');
console.log('--- FORCING SCHEMA UPDATE: Solicitudes (EN_REVISION) ---');

try {
    const currentSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='solicitudes'").get();
    console.log("OLD SCHEMA:", currentSchema ? currentSchema.sql : "missing");

    db.exec("PRAGMA foreign_keys=off;");

    db.transaction(() => {
        // Drop if exists to be sure we recreate
        db.exec("DROP TABLE IF EXISTS solicitudes_temp_fix");

        db.exec(`
            CREATE TABLE solicitudes_temp_fix (
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
            )
        `);

        // Copy
        const oldExists = db.prepare("SELECT name FROM sqlite_master WHERE name='solicitudes'").get();
        if (oldExists) {
            // Check columns in old table
            const cols = db.prepare("PRAGMA table_info(solicitudes)").all().map(c => c.name);
            const commonCols = ['id', 'empresa_id', 'driver_id', 'licencia_req', 'ubicacion', 'tiempo_estimado', 'estado', 'fecha_creacion', 'fecha_expiracion', 'fecha_cierre', 'cancelado_por'];
            // ronda_actual, fecha_inicio_ronda might follow
            const hasRonda = cols.includes('ronda_actual');
            const hasFechaInicio = cols.includes('fecha_inicio_ronda');

            let selectCols = commonCols.join(', ');
            if (hasRonda) selectCols += ', ronda_actual';
            else selectCols += ', 1 as ronda_actual'; // Default

            if (hasFechaInicio) selectCols += ', fecha_inicio_ronda';
            else selectCols += ', NULL as fecha_inicio_ronda'; // Default

            const insertCols = commonCols.join(', ') + ', ronda_actual, fecha_inicio_ronda';

            db.exec(`
                INSERT INTO solicitudes_temp_fix (${insertCols})
                SELECT ${selectCols} FROM solicitudes
             `);
            db.exec("DROP TABLE solicitudes");
        }

        db.exec("ALTER TABLE solicitudes_temp_fix RENAME TO solicitudes");
    })();

    db.exec("PRAGMA foreign_keys=on;");

    const newSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='solicitudes'").get();
    console.log("NEW SCHEMA:", newSchema.sql);
    console.log("✅ FIXED SCHEMA.");

} catch (e) {
    console.error("❌ FIX FAILED:", e.message);
    process.exit(1);
}
