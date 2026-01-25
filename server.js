const express = require('express');
const { execSync, exec } = require('child_process');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

// ⚠️ TIME AND ACCESS CONTROL IMPORTS
const { nowIso, nowEpochMs } = require('./time_provider');
const { enforceCompanyCanOperate } = require('./access_control');

// --- DATABASE SETUP ---
let dbPath = process.env.DB_PATH || 'driverflow.db';

// Render / Production Persistence Logic
if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    const dataDir = '/data';
    try {
        if (!fs.existsSync(dataDir)) {
            console.log('Creating /data directory...');
            fs.mkdirSync(dataDir, { recursive: true });
        }
        dbPath = '/data/driverflow.sqlite';
        console.log(`Using persistent database at: ${dbPath}`);
    } catch (err) {
        console.error('Failed to prepare /data directory:', err);
        // Fallback or exit? strictly user said /data/driverflow.sqlite
        // Use standard path if /data fails (e.g. strict permissions?)
        // keeping dbPath as logic falls through, but normally this works on Render.
    }
}

const db = require('better-sqlite3')(dbPath);
// Enable WAL for better concurrency
db.pragma('journal_mode = WAL');

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIG ---
const SECRET_KEY = process.env.JWT_SECRET || 'driverflow_secret_key_mvp';
const REQUEST_DURATION_MINUTES = 30;

// --- DATABASE SCHEMAS (Auto-Init) ---
const initSchema = () => {
    console.log('🔄 Initializing Database Schema...');
    db.exec(`
        CREATE TABLE IF NOT EXISTS drivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            contacto TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            tipo_licencia TEXT NOT NULL CHECK(tipo_licencia IN ('A', 'B', 'C')),
            estado TEXT NOT NULL DEFAULT 'DISPONIBLE' CHECK(estado IN ('DISPONIBLE', 'OCUPADO', 'SUSPENDED')),
            search_status TEXT DEFAULT 'ON',
            experience_level TEXT DEFAULT 'Intermediate',
            available_start DATETIME DEFAULT (datetime('now')),
            rating_avg REAL DEFAULT 5.0,
            fecha_registro DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS empresas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            contacto TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            ciudad TEXT NOT NULL,
            legal_name TEXT,
            address_line1 TEXT,
            address_state TEXT,
            contact_person TEXT,
            contact_phone TEXT,
            search_status TEXT DEFAULT 'OFF',
            account_state TEXT DEFAULT 'REGISTERED',
            created_at DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS solicitudes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL,
            driver_id INTEGER,
            licencia_req TEXT NOT NULL CHECK(licencia_req IN ('A', 'B', 'C')),
            ubicacion TEXT NOT NULL,
            tiempo_estimado INTEGER NOT NULL,
            estado TEXT NOT NULL DEFAULT 'PENDIENTE',
            fecha_creacion DATETIME DEFAULT (datetime('now')),
            fecha_expiracion DATETIME NOT NULL,
            fecha_cierre DATETIME,
            cancelado_por TEXT,
            ronda_actual INTEGER DEFAULT 1,
            fecha_inicio_ronda DATETIME,
            FOREIGN KEY (empresa_id) REFERENCES empresas(id),
            FOREIGN KEY (driver_id) REFERENCES drivers(id)
        );

        CREATE TABLE IF NOT EXISTS company_match_prefs (
            company_id INTEGER PRIMARY KEY,
            req_license TEXT DEFAULT 'Any',
            req_experience TEXT DEFAULT 'Any',
            req_team_driving TEXT DEFAULT 'Either',
            req_start TEXT DEFAULT 'Flexible',
            req_restrictions TEXT DEFAULT 'No',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES empresas(id)
        );

        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            driver_id INTEGER NOT NULL,
            request_id INTEGER NOT NULL UNIQUE,
            price_cents INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USD',
            billing_status TEXT NOT NULL DEFAULT 'unbilled',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT,
            billing_week TEXT,
            FOREIGN KEY (company_id) REFERENCES empresas(id),
            FOREIGN KEY(driver_id) REFERENCES drivers(id),
            FOREIGN KEY(request_id) REFERENCES solicitudes(id)
        );

        CREATE TABLE IF NOT EXISTS events_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            company_id INTEGER,
            driver_id INTEGER,
            request_id INTEGER,
            metadata TEXT,
            processed_at TEXT,
            process_status TEXT DEFAULT 'pending',
            last_error TEXT,
            send_attempts INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS request_visibility (
            request_id INTEGER NOT NULL,
            driver_id INTEGER NOT NULL,
            ronda INTEGER NOT NULL,
            PRIMARY KEY (request_id, driver_id)
        );

        CREATE TABLE IF NOT EXISTS potential_matches (
            company_id INTEGER NOT NULL,
            driver_id INTEGER NOT NULL,
            match_score INTEGER DEFAULT 0,
            status TEXT DEFAULT 'NEW',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (company_id, driver_id)
        );

        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            amount_cents INTEGER NOT NULL,
            currency TEXT DEFAULT 'USD',
            status TEXT DEFAULT 'draft',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            due_at DATETIME,
            paid_at DATETIME,
            stripe_invoice_id TEXT
        );

        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            ticket_id INTEGER NOT NULL,
            amount_cents INTEGER NOT NULL,
            description TEXT,
            FOREIGN KEY(invoice_id) REFERENCES invoices(id),
            FOREIGN KEY(ticket_id) REFERENCES tickets(id)
        );

        CREATE TABLE IF NOT EXISTS ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
            comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(request_id) REFERENCES solicitudes(id)
        );

        CREATE TABLE IF NOT EXISTS webhook_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            payload TEXT,
            processed_at DATETIME,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS credit_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            amount_cents INTEGER NOT NULL,
            reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(invoice_id) REFERENCES invoices(id)
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            admin_user TEXT,
            target_id INTEGER,
            reason TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✅ Database Schema Verified.');
};

// Initialize DB immediately
try {
    initSchema();
} catch (err) {
    console.error('❌ FATAL: Database Initialization Failed', err);
    process.exit(1);
}

// --- MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden: Invalid token' });
        req.user = user;
        next();
    });
};

// --- ENDPOINTS ---

// Health Check
app.get("/", (req, res) => {
    res.status(200).json({ status: "ok", service: "DriverFlow API", timestamp: new Date().toISOString() });
});
app.get('/health', (req, res) => {
    res.json({ ok: true, status: 'online' });
});

// Admin Migration Trigger (Legacy/Backup)
app.get('/admin/force-migrate', (req, res) => {
    const key = req.query.key;
    if (key !== 'driverflow_admin_secret_123') return res.status(403).json({ error: 'Forbidden' });

    // Schema is auto-inited, so just return status
    res.json({ success: true, message: 'Schema is enforced on startup.' });
});

// 1. Register
app.post('/register', async (req, res, next) => {
    try {
        const { type, nombre, contacto, password, ...extras } = req.body;

        if (type === 'driver') {
            const hashedPassword = await bcrypt.hash(password, 10);
            const { tipo_licencia } = extras;
            if (!['A', 'B', 'C'].includes(tipo_licencia)) return res.status(400).json({ error: 'Licencia inválida' });

            const stmt = db.prepare('INSERT INTO drivers (nombre, contacto, password_hash, tipo_licencia) VALUES (?, ?, ?, ?)');
            const info = stmt.run(nombre, contacto, hashedPassword, tipo_licencia);
            return res.status(201).json({ id: info.lastInsertRowid, type: 'driver', message: 'Driver registrado' });
        }

        if (type === 'empresa') {
            const { legal_name, address_line1, address_city, contact_person, contact_phone, match_prefs } = extras;
            if (!legal_name || !address_line1 || !address_city || !contact_person || !contact_phone) {
                return res.status(400).json({ error: 'Missing mandatory fields' });
            }

            const nowStr = nowIso();
            const hashedPassword = await bcrypt.hash(password, 10);

            const performRegister = db.transaction(() => {
                const stmt = db.prepare(`
                    INSERT INTO empresas (
                        nombre, contacto, password_hash, ciudad, 
                        legal_name, address_line1, address_state, 
                        contact_person, contact_phone, 
                        search_status, account_state, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFF', 'REGISTERED', ?)
                `);
                const info = stmt.run(nombre, contacto, hashedPassword, address_city, legal_name, address_line1, extras.address_state || '', contact_person, contact_phone, nowStr);
                const newId = info.lastInsertRowid;

                const mp = match_prefs || {};
                const stmtPrefs = db.prepare(`
                    INSERT INTO company_match_prefs (
                        company_id, req_license, req_experience, req_team_driving, req_start, req_restrictions
                    ) VALUES (?, ?, ?, ?, ?, ?)
                `);
                stmtPrefs.run(newId, mp.req_license || 'Any', mp.req_experience || 'Any', mp.req_team_driving || 'Either', mp.req_start || 'Flexible', mp.req_restrictions || 'No');

                db.prepare(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?)`).run('company_registered', nowStr, newId, JSON.stringify({ name: nombre }));
                return newId;
            });

            const newId = performRegister();
            return res.status(201).json({ id: newId, type: 'empresa', message: 'Empresa registrada' });
        }

        return res.status(400).json({ error: 'Tipo inválido' });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Contacto ya registrado' });
        next(err);
    }
});

// 2. Login
app.post('/login', async (req, res, next) => {
    try {
        const { type, contacto, password } = req.body;
        if (!['driver', 'empresa'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });

        const table = type === 'driver' ? 'drivers' : 'empresas';
        const row = db.prepare(`SELECT * FROM ${table} WHERE contacto = ?`).get(contacto);

        if (!row) return res.status(401).json({ error: 'Usuario no encontrado' });

        if (await bcrypt.compare(password, row.password_hash)) {
            const payload = { id: row.id, type: type, licencia: type === 'driver' ? row.tipo_licencia : null };
            const token = jwt.sign(payload, SECRET_KEY, { expiresIn: '24h' });
            res.json({ token, type, id: row.id, nombre: row.nombre });
        } else {
            res.status(401).json({ error: 'Contraseña incorrecta' });
        }
    } catch (err) {
        next(err);
    }
});

// Search Status
app.post('/company/search_status', authenticateToken, (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    const { status } = req.body;
    try {
        if (status === 'ON') enforceCompanyCanOperate(db, req.user.id, 'enable_search');
        db.prepare('UPDATE empresas SET search_status = ? WHERE id = ?').run(status, req.user.id);
        res.json({ success: true, search_status: status });
    } catch (err) {
        if (err.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') return res.status(403).json({ error: 'COMPANY_BLOCKED', reason: err.details });
        res.status(500).json({ error: err.message });
    }
});

app.post('/driver/search_status', authenticateToken, (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Forbidden' });
    const { status } = req.body;
    db.prepare('UPDATE drivers SET search_status = ? WHERE id = ?').run(status, req.user.id);
    res.json({ success: true, search_status: status });
});

// Matching Read
app.get('/company/potential_matches', authenticateToken, (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    const matches = db.prepare(`
        SELECT pm.created_at, pm.status, pm.match_score, d.tipo_licencia, d.experience_level, d.available_start
        FROM potential_matches pm
        JOIN drivers d ON pm.driver_id = d.id
        WHERE pm.company_id = ?
        ORDER BY pm.created_at DESC
    `).all(req.user.id);
    res.json(matches);
});

app.get('/driver/potential_matches', authenticateToken, (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Forbidden' });
    const matches = db.prepare(`
        SELECT pm.created_at, pm.status, pm.match_score, e.nombre 
        FROM potential_matches pm
        JOIN empresas e ON pm.company_id = e.id
        WHERE pm.driver_id = ?
        ORDER BY pm.created_at DESC
    `).all(req.user.id);
    res.json(matches);
});

// Request Create
app.post('/create_request', authenticateToken, (req, res, next) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    try {
        const company = db.prepare('SELECT search_status FROM empresas WHERE id = ?').get(req.user.id);
        if (company && company.search_status === 'OFF') return res.status(403).json({ error: 'SEARCH_OFF' });

        enforceCompanyCanOperate(db, req.user.id, 'create_request');

        const { licencia_req, ubicacion, tiempo_estimado } = req.body;
        const currentMs = nowEpochMs();
        const expiresAt = new Date(currentMs + REQUEST_DURATION_MINUTES * 60000).toISOString();

        const result = db.transaction(() => {
            const activeCheck = db.prepare(`SELECT count(*) as count FROM solicitudes WHERE empresa_id = ? AND estado IN ('PENDIENTE', 'EN_REVISION', 'ACEPTADA')`).get(req.user.id);
            if (activeCheck.count > 0) throw new Error('ACTIVE_REQUEST_EXISTS');

            const info = db.prepare('INSERT INTO solicitudes (empresa_id, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion) VALUES (?, ?, ?, ?, ?)').run(req.user.id, licencia_req, ubicacion, tiempo_estimado, expiresAt);
            return { id: info.lastInsertRowid, status: 'PENDIENTE' };
        })();
        res.status(201).json(result);
    } catch (e) {
        if (e.message === 'ACTIVE_REQUEST_EXISTS') return res.status(409).json({ error: 'Request already active' });
        if (e.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') return res.status(403).json({ error: 'COMPANY_BLOCKED', reason: e.details });
        next(e);
    }
});

// List
app.get('/list_available_requests', authenticateToken, (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Forbidden' });
    const driver = db.prepare('SELECT estado, tipo_licencia, search_status FROM drivers WHERE id = ?').get(req.user.id);
    if (!driver || driver.search_status === 'OFF' || driver.estado !== 'DISPONIBLE') return res.json([]);

    const nowStr = nowIso();
    const requests = db.prepare(`
        SELECT s.id, 'Verified Company' as empresa, s.ubicacion, s.tiempo_estimado, s.fecha_expiracion
        FROM solicitudes s
        WHERE s.estado = 'PENDIENTE' AND s.licencia_req = ? AND s.fecha_expiracion > ?
    `).all(driver.tipo_licencia, nowStr);
    res.json(requests);
});

// Apply
app.post('/apply_for_request', authenticateToken, (req, res, next) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Forbidden' });
    try {
        const { request_id } = req.body;
        const nowStr = nowIso();
        const reqInfo = db.prepare("SELECT * FROM solicitudes WHERE id = ? AND estado = 'PENDIENTE' AND fecha_expiracion > ?").get(request_id, nowStr);
        if (!reqInfo) return res.status(409).json({ error: 'Request unavailable' });

        enforceCompanyCanOperate(db, reqInfo.empresa_id, 'driver_apply');

        db.transaction(() => {
            const driver = db.prepare('SELECT estado, search_status FROM drivers WHERE id = ?').get(req.user.id);
            if (driver.search_status === 'OFF') throw new Error('DRIVER_SEARCH_OFF');
            if (driver.estado !== 'DISPONIBLE') throw new Error('DRIVER_NOT_AVAILABLE');

            const reCheck = db.prepare("SELECT driver_id FROM solicitudes WHERE id = ?").get(request_id);
            if (reCheck.driver_id) throw new Error('REQUEST_TAKEN');

            db.prepare("UPDATE solicitudes SET estado = 'EN_REVISION', driver_id = ? WHERE id = ?").run(req.user.id, request_id);
            db.prepare("UPDATE drivers SET estado = 'OCUPADO' WHERE id = ?").run(req.user.id);
        })();

        res.json({ success: true });
    } catch (e) {
        if (e.message === 'DRIVER_NOT_AVAILABLE') return res.status(409).json({ error: 'Driver busy' });
        if (e.message === 'REQUEST_TAKEN') return res.status(409).json({ error: 'Request taken' });
        if (e.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') return res.status(403).json({ error: 'Company blocked' });
        next(e);
    }
});

// Approve
app.post('/approve_driver', authenticateToken, (req, res, next) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    try {
        const { request_id } = req.body;
        enforceCompanyCanOperate(db, req.user.id, 'approve_driver_match');

        const result = db.transaction(() => {
            const reqInfo = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(request_id);
            if (!reqInfo || reqInfo.empresa_id !== req.user.id || reqInfo.estado !== 'EN_REVISION') throw new Error('INVALID_STATE');

            db.prepare("UPDATE solicitudes SET estado = 'ACEPTADA' WHERE id = ?").run(request_id);
            const ticketInfo = db.prepare("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, currency, created_at) VALUES (?, ?, ?, 15000, 'USD', ?)")
                .run(reqInfo.empresa_id, reqInfo.driver_id, request_id, nowIso());
            return ticketInfo.lastInsertRowid;
        })();
        res.json({ success: true, ticket_id: result });
    } catch (e) {
        if (e.message === 'INVALID_STATE') return res.status(400).json({ error: 'Invalid state' });
        if (e.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') return res.status(403).json({ error: 'COMPANY_BLOCKED', reason: e.details });
        next(e);
    }
});

// Complete
app.post('/request/:id/complete', authenticateToken, (req, res, next) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Forbidden' });
    try {
        db.transaction(() => {
            const info = db.prepare('SELECT driver_id, estado FROM solicitudes WHERE id = ?').get(req.params.id);
            if (!info || info.driver_id !== req.user.id || info.estado !== 'ACEPTADA') throw new Error('INVALID');
            db.prepare("UPDATE solicitudes SET estado = 'FINALIZADA', fecha_cierre = ? WHERE id = ?").run(nowIso(), req.params.id);
            db.prepare("UPDATE drivers SET estado = 'DISPONIBLE' WHERE id = ?").run(req.user.id);
        })();
        res.json({ success: true });
    } catch (e) {
        if (e.message === 'INVALID') return res.status(400).json({ error: 'Invalid operation' });
        next(e);
    }
});

// Cancel
app.post('/request/:id/cancel', authenticateToken, (req, res, next) => {
    try {
        const { id: reqId } = req.params;
        const userId = req.user.id;
        db.transaction(() => {
            const reqInfo = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(reqId);
            if (!reqInfo) throw new Error('NOT_FOUND');
            if (req.user.type === 'empresa' && reqInfo.empresa_id !== userId) throw new Error('FORBIDDEN');
            if (req.user.type === 'driver' && reqInfo.driver_id !== userId) throw new Error('FORBIDDEN');
            if (['FINALIZADA', 'CANCELADA', 'EXPIRADA'].includes(reqInfo.estado)) throw new Error('INVALID_STATE');

            db.prepare("UPDATE solicitudes SET estado = 'CANCELADA', cancelado_por = ? WHERE id = ?").run(req.user.type.toUpperCase(), reqId);
            if (reqInfo.driver_id) db.prepare("UPDATE drivers SET estado = 'DISPONIBLE' WHERE id = ?").run(reqInfo.driver_id);
            if (reqInfo.estado === 'ACEPTADA') {
                db.prepare("UPDATE tickets SET billing_status = 'void' WHERE request_id = ?").run(reqId);
            }
        })();
        res.json({ success: true });
    } catch (e) {
        if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'Not found' });
        if (e.message === 'FORBIDDEN') return res.status(403).json({ error: 'Forbidden' });
        next(e);
    }
});

// Contact
app.get('/request/:id/contact', authenticateToken, (req, res, next) => {
    try {
        const reqInfo = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(req.params.id);
        if (!reqInfo) return res.status(404).json({ error: 'Not found' });
        if (reqInfo.empresa_id !== req.user.id && reqInfo.driver_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
        if (!['ACEPTADA', 'FINALIZADA', 'CANCELADA'].includes(reqInfo.estado)) return res.status(403).json({ error: 'Hidden' });

        if (req.user.type === 'empresa') {
            enforceCompanyCanOperate(db, req.user.id, 'reveal_contact');
            const ticket = db.prepare('SELECT t.id, t.billing_status, i.status FROM tickets t LEFT JOIN invoice_items ii ON t.id=ii.ticket_id LEFT JOIN invoices i ON ii.invoice_id=i.id WHERE t.request_id = ?').get(req.params.id);
            if (!ticket || ticket.billing_status === 'void' || ticket.status !== 'paid') {
                return res.status(402).json({ error: 'Payment user required for contact info' });
            }
            const data = db.prepare('SELECT nombre, contacto, tipo_licencia FROM drivers WHERE id = ?').get(reqInfo.driver_id);
            res.json(data);
        } else {
            const data = db.prepare('SELECT nombre, contacto, ciudad FROM empresas WHERE id = ?').get(reqInfo.empresa_id);
            res.json(data);
        }
    } catch (e) {
        if (e.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') return res.status(403).json({ error: 'COMPANY_BLOCKED' });
        next(e);
    }
});

// Recover Password
app.post('/recover-password', async (req, res, next) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email requerido' });

        let user = db.prepare('SELECT id FROM drivers WHERE contacto = ?').get(email);
        let table = 'drivers';
        if (!user) {
            user = db.prepare('SELECT id FROM empresas WHERE contacto = ?').get(email);
            table = 'empresas';
        }

        if (user) {
            const crypto = require('crypto');
            const tempPass = crypto.randomBytes(4).toString('hex');
            const hashed = await bcrypt.hash(tempPass, 10);
            db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(hashed, user.id);
            db.prepare("INSERT INTO events_outbox (event_name, payload, created_at) VALUES (?, ?, datetime('now'))").run('password_reset', JSON.stringify({ email, tempPass }));
            console.log('RESET PASS:', tempPass);
        }
        res.json({ message: 'Instructions sent' });
    } catch (e) {
        next(e);
    }
});

// Rate Service
app.post('/rate_service', authenticateToken, (req, res, next) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    try {
        const { request_id, rating, comment } = req.body;
        db.transaction(() => {
            const reqInfo = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(request_id);
            if (!reqInfo || reqInfo.empresa_id !== req.user.id || reqInfo.estado !== 'FINALIZADA') throw new Error('INVALID');
            db.prepare('INSERT INTO ratings (request_id, rating, comment) VALUES (?, ?, ?)').run(request_id, rating, comment);
            // Updating averages omitted for brevity, stick to core reqs
        })();
        res.json({ success: true });
    } catch (e) {
        if (e.message === 'INVALID') return res.status(400).json({ error: 'Invalid state' });
        next(e);
    }
});


// Global Error Handler (JSON Strict)
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err);
    if (!res.headersSent) {
        res.status(500).json({
            error: 'Internal Server Error',
            message: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`DB Path: ${dbPath}`);
});
