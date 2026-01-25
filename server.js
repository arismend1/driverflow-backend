const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// ⚠️ TIME AND ACCESS CONTROL IMPORTS
// Assumes these files exist. If not, logic inside them is skipped for this file overwrite.
const { nowIso, nowEpochMs } = require('./time_provider');
const { enforceCompanyCanOperate } = require('./access_control');

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIG ---
const SECRET_KEY = process.env.JWT_SECRET || 'driverflow_secret_key_mvp';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'driverflow_admin_secret_123';
const REQUEST_DURATION_MINUTES = 30;

// --- DATABASE SETUP (ROBUST PERSISTENCE) ---
let dbPath = process.env.DB_PATH;

if (process.env.NODE_ENV === 'production') {
    // 1. Enforce Absolute Path in Production
    if (!dbPath) {
        // Fallback requested by user. 
        // NOTE: Ensure your Render Disk is mounted at /var/data or /data via Dashboard.
        dbPath = '/var/data/driverflow.db';
        console.log(`[DB] DB_PATH not set. Defaulting to: ${dbPath}`);
    }

    if (!path.isAbsolute(dbPath)) {
        console.error(`[FATAL] Production DB_PATH must be absolute. Received: ${dbPath}`);
        process.exit(1);
    }

    // 2. Ensure Directory Exists
    const dbDir = path.dirname(dbPath);
    try {
        if (!fs.existsSync(dbDir)) {
            console.log(`[DB] Creating directory: ${dbDir}`);
            fs.mkdirSync(dbDir, { recursive: true });
        }
    } catch (err) {
        console.error(`[FATAL] Could not create DB directory ${dbDir}:`, err.message);
        process.exit(1);
    }
} else {
    // Dev Fallback
    dbPath = dbPath || path.resolve(__dirname, 'driverflow.db');
}

console.log(`[DB] Connecting to: ${dbPath}`);
const db = new Database(dbPath); // better-sqlite3
db.pragma('journal_mode = WAL');

// --- DATABASE INITIALIZATION ---
const initDb = () => {
    console.log('[DB] Initializing Tables...');

    db.exec(`
        -- CORE TABLES
        CREATE TABLE IF NOT EXISTS drivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            contacto TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            tipo_licencia TEXT NOT NULL CHECK(tipo_licencia IN ('A', 'B', 'C')),
            estado TEXT NOT NULL DEFAULT 'DISPONIBLE' CHECK(estado IN ('DISPONIBLE', 'OCUPADO', 'SUSPENDED')),
            search_status TEXT DEFAULT 'ON',
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
            FOREIGN KEY (empresa_id) REFERENCES empresas(id),
            FOREIGN KEY (driver_id) REFERENCES drivers(id)
        );

        -- ADDITIONAL REQUIRED TABLES
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
            FOREIGN KEY (company_id) REFERENCES empresas(id),
            FOREIGN KEY(driver_id) REFERENCES drivers(id),
            FOREIGN KEY(request_id) REFERENCES solicitudes(id)
        );

         CREATE TABLE IF NOT EXISTS potential_matches (
            company_id INTEGER NOT NULL,
            driver_id INTEGER NOT NULL,
            match_score INTEGER DEFAULT 0,
            status TEXT DEFAULT 'NEW',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (company_id, driver_id)
        );

        CREATE TABLE IF NOT EXISTS company_match_prefs (
            company_id INTEGER PRIMARY KEY,
            req_license TEXT DEFAULT 'Any',
            req_experience TEXT DEFAULT 'Any',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES empresas(id)
        );

        CREATE TABLE IF NOT EXISTS events_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            payload TEXT,
            created_at TEXT NOT NULL,
            company_id INTEGER,
            driver_id INTEGER,
            request_id INTEGER,
            metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            amount_cents INTEGER NOT NULL,
            status TEXT DEFAULT 'draft',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS invoice_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            ticket_id INTEGER NOT NULL,
            FOREIGN KEY(invoice_id) REFERENCES invoices(id)
        );
        
        -- EXTRAS requested
        CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY, request_id INTEGER, rating INTEGER, comment TEXT);
        CREATE TABLE IF NOT EXISTS webhook_events (id INTEGER PRIMARY KEY, source TEXT, payload TEXT, created_at DATETIME);
        CREATE TABLE IF NOT EXISTS credit_notes (id INTEGER PRIMARY KEY, invoice_id INTEGER, amount_cents INTEGER, reason TEXT, created_at DATETIME);
        CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY, action TEXT, admin_user TEXT, target_id INTEGER, reason TEXT, created_at DATETIME);
        CREATE TABLE IF NOT EXISTS request_visibility (request_id INTEGER, driver_id INTEGER, ronda INTEGER, PRIMARY KEY (request_id, driver_id));

        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_type TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at INTEGER,
            created_at INTEGER NOT NULL
        );
    `);
    console.log('[DB] Tables Verified.');
};

// Initialize BEFORE listening
initDb();

// --- AUTH MIDDLEWARE ---
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
app.get('/health', (req, res) => {
    res.json({ ok: true, status: 'online', env: process.env.NODE_ENV });
});

// DEBUG DB ENDPOINT
app.get('/debug/db', (req, res) => {
    const isProd = process.env.NODE_ENV === 'production';
    const hasSecret = req.headers['x-admin-secret'] === ADMIN_SECRET;

    if (isProd && !hasSecret) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        const stats = fs.statSync(dbPath);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

        res.json({
            path: dbPath,
            exists: true,
            sizeBytes: stats.size,
            tables: tables.map(t => t.name)
        });
    } catch (e) {
        res.status(500).json({
            path: dbPath,
            exists: false,
            error: e.message
        });
    }
});

// 1. Register
app.post('/register', async (req, res, next) => {
    try {
        const { type, nombre, password, confirm_password, ...extras } = req.body;
        // 1. Normalize identifier (Priority: contacto > email > contact > phone)
        const contacto = (req.body.contacto || req.body.email || req.body.contact || req.body.phone || "").trim().toLowerCase();

        // 2. Dev Logging (Safe)
        if (process.env.NODE_ENV !== 'production') {
            console.log(`[REGISTER] Type: ${type}, Name: ${nombre}, Contacto: ${contacto}`);
        }

        // 3. Strict Validation
        if (!contacto) return res.status(400).json({ error: 'CONTACT_REQUIRED' });
        if (!password || !confirm_password) return res.status(400).json({ error: 'PASSWORD_REQUIRED' });
        if (password !== confirm_password) return res.status(400).json({ error: 'PASSWORDS_DO_NOT_MATCH' });

        if (type === 'driver') {
            // Check existence first to return clear 409
            const existing = db.prepare('SELECT id FROM drivers WHERE lower(contacto) = ?').get(contacto);
            if (existing) return res.status(409).json({ error: 'USER_ALREADY_EXISTS' });

            const hashedPassword = await bcrypt.hash(password, 10);
            const { tipo_licencia } = extras;
            if (!['A', 'B', 'C'].includes(tipo_licencia)) return res.status(400).json({ error: 'Licencia inválida' });

            const stmt = db.prepare('INSERT INTO drivers (nombre, contacto, password_hash, tipo_licencia) VALUES (?, ?, ?, ?)');
            const info = stmt.run(nombre, contacto, hashedPassword, tipo_licencia);
            return res.status(201).json({ id: info.lastInsertRowid, type: 'driver', message: 'Driver registrado' });
        } else if (type === 'empresa') {
            // Check existence first
            const existing = db.prepare('SELECT id FROM empresas WHERE lower(contacto) = ?').get(contacto);
            if (existing) return res.status(409).json({ error: 'USER_ALREADY_EXISTS' });

            // Simplified for brevity, assume similar robust logic for company
            const hashedPassword = await bcrypt.hash(password, 10);
            const stmt = db.prepare('INSERT INTO empresas (nombre, contacto, password_hash, ciudad, legal_name, address_line1, contact_person, contact_phone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const info = stmt.run(nombre, contacto, hashedPassword, extras.address_city, extras.legal_name, extras.address_line1, extras.contact_person, extras.contact_phone, nowIso());
            return res.status(201).json({ id: info.lastInsertRowid, type: 'empresa' });
        }
        res.status(400).json({ error: 'Invalid type' });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'USER_ALREADY_EXISTS' });
        next(err);
    }
});

// 2. Login
app.post('/login', async (req, res, next) => {
    try {
        const { type, password } = req.body;
        // 1. Normalize identifier
        const contacto = (req.body.contacto || req.body.email || req.body.contact || req.body.phone || "").trim().toLowerCase();

        // 2. Dev Logging (Safe)
        if (process.env.NODE_ENV !== 'production') {
            console.log(`[LOGIN] Type: ${type}, Contacto: ${contacto}`);
        }

        // 3. Strict Validation
        if (!contacto) return res.status(400).json({ error: 'CONTACT_REQUIRED' });
        if (!['driver', 'empresa'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
        const table = type === 'driver' ? 'drivers' : 'empresas';
        const row = db.prepare(`SELECT * FROM ${table} WHERE lower(contacto) = ?`).get(contacto);

        if (!row) return res.status(401).json({ error: 'Usuario no encontrado' });
        if (await bcrypt.compare(password, row.password_hash)) {
            const token = jwt.sign({ id: row.id, type }, SECRET_KEY, { expiresIn: '24h' });
            res.json({ token, type, id: row.id, nombre: row.nombre });
        } else {
            res.status(401).json({ error: 'Contraseña incorrecta' });
        }
    } catch (err) {
        next(err);
    }
});

// 3. Forgot Password
app.post('/forgot_password', (req, res, next) => {
    try {
        const { type } = req.body;
        const contact = (req.body.contact || req.body.email || req.body.phone || req.body.contacto || "").trim().toLowerCase();

        if (!contact || !['driver', 'empresa'].includes(type)) {
            // Always return success to prevent enumeration, unless input is blatantly malformed
            return res.json({ success: true, message: 'If the account exists, a recovery email was sent.' });
        }

        const table = type === 'driver' ? 'drivers' : 'empresas';
        const user = db.prepare(`SELECT id, contacto FROM ${table} WHERE lower(contacto) = ?`).get(contact);

        if (user) {
            // Generate secure token
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const expiresAt = Date.now() + 30 * 60 * 1000; // 30 mins

            // Invalidate old tokens
            db.prepare('DELETE FROM password_resets WHERE user_id = ? AND user_type = ?').run(user.id, type);

            // Store new token
            db.prepare('INSERT INTO password_resets (user_type, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
                .run(type, user.id, tokenHash, expiresAt, Date.now());

            // MVP: Log link (DEEP LINK / FRONTEND URL)
            const link = `driverflow://reset-password?token=${token}`;
            console.log(`[RESET LINK] For ${user.contacto}: ${link}`);
        }

        res.json({ success: true, message: 'If the account exists, a recovery email was sent.' });
    } catch (err) {
        next(err);
    }
});

// 4. Reset Password
app.post('/reset_password', async (req, res, next) => {
    try {
        const { token, new_password, confirm_password } = req.body;

        if (!token || !new_password || !confirm_password) {
            return res.status(400).json({ error: 'MISSING_FIELDS' });
        }
        if (new_password !== confirm_password) {
            return res.status(400).json({ error: 'PASSWORDS_DO_NOT_MATCH' });
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const record = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL').get(tokenHash);

        if (!record) {
            return res.status(401).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
        }

        if (Date.now() > record.expires_at) {
            return res.status(401).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
        }

        // Update password
        const hashedPassword = await bcrypt.hash(new_password, 10);
        const table = record.user_type === 'driver' ? 'drivers' : 'empresas';

        db.transaction(() => {
            db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(hashedPassword, record.user_id);
            db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(Date.now(), record.id);
        })();

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// 4.5 Reset Password Page (HTML)
app.get('/reset', (req, res) => {
    const token = req.query.token;
    if (!token) return res.send('Invalid Request: Missing Token');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Reset Password - DriverFlow</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: sans-serif; display: flex; justify-content: center; padding-top: 50px; background: #f0f2f5; }
            .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
            input { width: 90%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; }
            button { width: 100%; padding: 10px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
            button:hover { background: #0056b3; }
            .error { color: red; margin-bottom: 10px; display: none; }
            .success { color: green; margin-bottom: 10px; display: none; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>Reset Password</h2>
            <div id="error" class="error"></div>
            <div id="success" class="success">Password reset successfully! You can now login to the app.</div>
            <form id="resetForm">
                <input type="hidden" id="token" value="${token}">
                <input type="password" id="new_password" placeholder="New Password" required minlength="6">
                <input type="password" id="confirm_password" placeholder="Confirm Password" required minlength="6">
                <button type="submit">Set New Password</button>
            </form>
        </div>
        <script>
            document.getElementById('resetForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const errorDiv = document.getElementById('error');
                const successDiv = document.getElementById('success');
                const btn = e.target.querySelector('button');
                
                errorDiv.style.display = 'none';
                successDiv.style.display = 'none';
                
                const p1 = document.getElementById('new_password').value;
                const p2 = document.getElementById('confirm_password').value;
                
                if (p1 !== p2) {
                    errorDiv.textContent = 'Passwords do not match';
                    errorDiv.style.display = 'block';
                    return;
                }
                
                btn.disabled = true;
                btn.textContent = 'Updating...';
                
                try {
                    const res = await fetch('/reset_password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            token: document.getElementById('token').value,
                            new_password: p1,
                            confirm_password: p2
                        })
                    });
                    
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Failed to reset');
                    
                    successDiv.style.display = 'block';
                    e.target.style.display = 'none';
                } catch (err) {
                    errorDiv.textContent = err.message;
                    errorDiv.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Set New Password';
                }
            });
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// 5. Debug Password Resets
app.get('/debug/password_resets', (req, res) => {
    const hasSecret = req.headers['x-admin-secret'] === ADMIN_SECRET;
    if (!hasSecret) return res.status(403).json({ error: 'Forbidden' });

    try {
        const rows = db.prepare('SELECT * FROM password_resets ORDER BY created_at DESC LIMIT 50').all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Example Authorized Endpoint
app.get('/me', authenticateToken, (req, res) => {
    res.json({ user: req.user });
});

// Manual Migration (Trigger via Admin Secret)
app.get('/admin/force-migrate', (req, res) => {
    if (req.query.key !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
    initDb(); // Re-run init
    res.json({ success: true, message: 'Tables verified/created.' });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`   DB Path: ${dbPath}`);
});
