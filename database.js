const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || 'driverflow.db';
const db = new Database(dbPath);

// Enable WAL for better concurrency
db.pragma('journal_mode = WAL');

const initDb = () => {
    // Drivers
    db.prepare(`
        CREATE TABLE IF NOT EXISTS drivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            contacto TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            tipo_licencia TEXT NOT NULL CHECK(tipo_licencia IN ('A', 'B', 'C')),
            estado TEXT NOT NULL DEFAULT 'DISPONIBLE' CHECK(estado IN ('DISPONIBLE', 'OCUPADO')),
            fecha_registro DATETIME DEFAULT (datetime('now'))
        )
    `).run();

    // Empresas
    db.prepare(`
        CREATE TABLE IF NOT EXISTS empresas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            contacto TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            ciudad TEXT NOT NULL,
            estado TEXT NOT NULL DEFAULT 'ACTIVO',
            fecha_registro DATETIME DEFAULT (datetime('now'))
        )
    `).run();

    // Solicitudes
    // Dates stored as TEXT (ISO8601) to work with SQLite datetime functions
    db.prepare(`
        CREATE TABLE IF NOT EXISTS solicitudes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL,
            driver_id INTEGER,
            licencia_req TEXT NOT NULL CHECK(licencia_req IN ('A', 'B', 'C')),
            ubicacion TEXT NOT NULL,
            tiempo_estimado INTEGER NOT NULL,
            estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(estado IN ('PENDIENTE', 'ACEPTADA', 'EXPIRADA')),
            fecha_creacion DATETIME DEFAULT (datetime('now')),
            fecha_expiracion DATETIME NOT NULL,
            FOREIGN KEY (empresa_id) REFERENCES empresas(id),
            FOREIGN KEY (driver_id) REFERENCES drivers(id)
        )
    `).run();

    console.log('Base de datos DriverFlow inicializada.');
};

initDb();

module.exports = db;
