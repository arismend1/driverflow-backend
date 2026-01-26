const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ⚠️ TIME AND ACCESS CONTROL IMPORTS
const { nowIso, nowEpochMs } = require('./time_provider');
const { enforceCompanyCanOperate } = require('./access_control');

// --- Producción: Strict Env Validation ---
if (process.env.NODE_ENV === 'production') {
    const requiredEnv = ['PORT', 'JWT_SECRET', 'DB_PATH', 'SENDGRID_API_KEY', 'FROM_EMAIL'];
    const missing = requiredEnv.filter(key => !process.env[key]);

    if (missing.length > 0) {
        console.error(`FATAL: Faltan variables de entorno requeridas para Producción: ${missing.join(', ')}`);
        process.exit(1);
    }
}

// --- MIGRATION: Run on Server Start (STRICT REQUIREMENT) ---
try {
    console.log('--- Running Auto-Migration (migrate_auth_fix.js) ---');
    execSync('node migrate_auth_fix.js', { stdio: 'inherit' });
    console.log('--- Migration Complete ---');
} catch (err) {
    console.error('FATAL: Migration failed on server start.');
    process.exit(1);
}

// Cargar DB después de validar entorno y migración
const dbPath = process.env.DB_PATH || 'driverflow.db';

// SAFETY GUARD: Anti-Production in Dev
if (process.env.NODE_ENV !== 'production' && (dbPath.includes('prod') || dbPath.includes('live'))) {
    console.error('FATAL: Attempting to access PRODUCTION DB in DEV mode. Aborting.');
    process.exit(1);
}

const db = require('better-sqlite3')(dbPath);

const app = express();
app.use(express.json());

// CORS Configuration
const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
};
app.use(cors(corsOptions));

// Root Endpoint (Health/Connectivity)
app.get("/", (req, res) => {
    res.status(200).json({
        status: "ok",
        service: "DriverFlow API",
        timestamp: new Date().toISOString()
    });
});

// Health Check
app.get('/health', (req, res) => {
    res.json({ ok: true, status: 'online' });
});

// Configuración
// Configuración
const SECRET_KEY = process.env.SECRET_KEY || process.env.JWT_SECRET || 'dev_secret_key_123'; // Prod usa ENV
const REQUEST_DURATION_MINUTES = 30;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];

// --- Rate Limiter (In-Memory) ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip, type) {
    const key = `${ip}:${type}`;
    const now = Date.now();
    let record = rateLimitMap.get(key);

    if (!record || now > record.expiry) {
        record = { count: 0, expiry: now + RATE_LIMIT_WINDOW };
    }

    if (record.count >= RATE_LIMIT_MAX) return false;

    record.count++;
    rateLimitMap.set(key, record);
    return true;
}

// --- Password Validator ---
function isStrongPassword(password) {
    if (!password || password.length < 8) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    return true;
}

// --- INTEGRATED WORKER SEAMLESS START ---
// Esto asegura que el mismo proceso que escribe en la DB también envíe los correos.
// Soluciona el problema de discos separados en Render.
try {
    const emailWorker = require('./process_outbox_emails');
    console.log('--- Starting Integrated Email Worker ---');
    emailWorker.startWorker(); // Run in background (non-blocking)
} catch (e) {
    console.error('Failed to start integrated worker:', e);
}

// --- Middleware Auth ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) {
            console.error('JWT Verify Error:', err.message);
            return res.sendStatus(403);
        }
        req.user = user;
        next();
    });
};

// --- Endpoints ---

// 1. Register - REAL ONBOARDING
// --- 1. Register - REAL ONBOARDING ---
app.post('/register', async (req, res) => {
    const { type, nombre, contacto, password, ...extras } = req.body;

    // Common Val
    if (!['driver', 'empresa'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    if (!nombre || !contacto || !password) return res.status(400).json({ error: 'Missing basic fields' });

    // Password Policy
    if (req.body.confirm_password && req.body.confirm_password !== password) {
        return res.status(400).json({ error: 'PASSWORDS_DO_NOT_MATCH' });
    }
    if (!isStrongPassword(password)) {
        return res.status(400).json({ error: 'WEAK_PASSWORD', message: 'Password must be 8+ chars, 1 uppercase, 1 lowercase, 1 number.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex');
        const now = nowIso();
        const expires = new Date(Date.now() + 24 * 3600000).toISOString();

        if (type === 'driver') {
            const { tipo_licencia } = extras;
            const stmt = db.prepare(`
                INSERT INTO drivers (nombre, contacto, password_hash, tipo_licencia, status, created_at, verified, verification_token, verification_expires)
                VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?)
            `);
            const info = stmt.run(nombre, contacto, hashedPassword, tipo_licencia || 'B', now, token, expires);

            // Outbox
            db.prepare(`
                INSERT INTO events_outbox (event_name, created_at, driver_id, metadata)
                VALUES (?, ?, ?, ?)
            `).run('verification_email', now, info.lastInsertRowid, JSON.stringify({ token, email: contacto, name: nombre, user_type: 'driver' }));
        }
        else {
            // Empresa
            const { legal_name, address_line1, address_city } = extras; // minimal fields for strictness
            const stmt = db.prepare(`
                INSERT INTO empresas (nombre, contacto, password_hash, legal_name, address_line1, city, ciudad, verified, verification_token, verification_expires, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            `);
            const info = stmt.run(nombre, contacto, hashedPassword, legal_name || nombre, address_line1 || '', address_city || '', address_city || '', token, expires, now);

            // Outbox
            db.prepare(`
                INSERT INTO events_outbox (event_name, created_at, company_id, metadata)
                VALUES (?, ?, ?, ?)
            `).run('verification_email', now, info.lastInsertRowid, JSON.stringify({ token, email: contacto, name: nombre, user_type: 'empresa' }));
        }

        return res.status(200).json({ ok: true, require_email_verification: true, message: 'Registro exitoso. Verifique su correo.' });

    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Usuario ya registrado' });
        console.error('Register Error:', err);
        return res.status(500).json({ error: 'Error interno de registro' });
    }
});

// --- 2. Login ---
app.post('/login', async (req, res) => {
    const { type, contacto, password } = req.body;
    if (!['driver', 'empresa'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });

    const table = type === 'driver' ? 'drivers' : 'empresas';
    const row = db.prepare(`SELECT * FROM ${table} WHERE contacto = ?`).get(contacto);

    // Generic error for security
    if (!row) return res.status(401).json({ error: 'Credenciales inválidas' });

    // STRICT VERIFICATION CHECK
    if (row.verified !== 1) {
        return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED' });
    }

    if (await bcrypt.compare(password, row.password_hash)) {
        const payload = { id: row.id, type: type };
        const token = jwt.sign(payload, SECRET_KEY, { expiresIn: '24h' });
        res.json({ ok: true, token, type, id: row.id, nombre: row.nombre });
    } else {
        res.status(401).json({ error: 'Credenciales inválidas' });
    }
});

// --- Verify Email (GET/POST) ---
app.all('/verify-email', (req, res) => {
    const token = req.method === 'GET' ? req.query.token : req.body.token;
    if (!token) return res.status(400).send('Missing Token');

    // Search both tables
    let user = db.prepare("SELECT id, 'driver' as type, verification_expires FROM drivers WHERE verification_token = ?").get(token);
    if (!user) user = db.prepare("SELECT id, 'empresa' as type, verification_expires FROM empresas WHERE verification_token = ?").get(token);

    if (!user) return res.status(404).send('Token Inválido o ya usado.');
    if (new Date(user.verification_expires) < new Date()) return res.status(400).send('Token Expirado.');

    const table = user.type === 'driver' ? 'drivers' : 'empresas';
    db.prepare(`UPDATE ${table} SET verified = 1, verification_token = NULL WHERE id = ?`).run(user.id);

    res.send(`<h1 style="color:green">Email Verificado con Éxito</h1><p>Ya puedes iniciar sesión en DriverFlow.</p>`);
});

// --- Resend Verification (Anti-Enumeration) ---
app.post(['/resend-verification', '/resend_verification'], (req, res) => {
    let { type, contact, email } = req.body;
    type = (type === 'company' ? 'empresa' : type) || 'driver'; // Normalization
    const target = (contact || email || '').trim();

    // Always 200 OK
    if (!target) return res.json({ ok: true });

    // Rate Limit
    if (!checkRateLimit(req.ip, 'resend')) return res.status(429).json({ error: 'RATE_LIMITED' });

    const table = type === 'driver' ? 'drivers' : 'empresas';
    const user = db.prepare(`SELECT * FROM ${table} WHERE contacto = ?`).get(target);

    if (user && user.verified === 0) {
        const token = crypto.randomBytes(32).toString('hex');
        const now = nowIso();
        const expires = new Date(Date.now() + 24 * 3600000).toISOString();

        db.prepare(`UPDATE ${table} SET verification_token = ?, verification_expires = ? WHERE id = ?`).run(token, expires, user.id);

        const idCol = type === 'driver' ? 'driver_id' : 'company_id';
        db.prepare(`INSERT INTO events_outbox (event_name, created_at, ${idCol}, metadata) VALUES (?, ?, ?, ?)`)
            .run('verification_email', now, user.id, JSON.stringify({ token, email: target, name: user.nombre, user_type: type }));
    }

    res.json({ ok: true, message: 'Si existe, se envió correo.' });
});

// --- Forgot Password (Anti-Enumeration) ---
app.post('/forgot_password', (req, res) => {
    let { type, contact, email } = req.body;
    type = (type === 'company' ? 'empresa' : type) || 'driver';
    const target = (contact || email || '').trim();

    if (!target) return res.json({ ok: true });

    // Rate Limit
    if (!checkRateLimit(req.ip, 'forgot')) return res.status(429).json({ error: 'RATE_LIMITED' });

    const table = type === 'driver' ? 'drivers' : 'empresas';
    const user = db.prepare(`SELECT * FROM ${table} WHERE contacto = ?`).get(target);

    if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        const now = nowIso();
        const expires = new Date(Date.now() + 1 * 3600000).toISOString(); // 1 Hour Expiry

        db.prepare(`UPDATE ${table} SET reset_token = ?, reset_expires = ? WHERE id = ?`).run(token, expires, user.id);

        const idCol = type === 'driver' ? 'driver_id' : 'company_id';
        db.prepare(`INSERT INTO events_outbox (event_name, created_at, ${idCol}, metadata) VALUES (?, ?, ?, ?)`)
            .run('recovery_email', now, user.id, JSON.stringify({ token, email: target, name: user.nombre, user_type: type }));
    }

    res.json({ ok: true, message: 'Si existe, se envió correo.' });
});

// --- Web Form for Reset Password (GET) ---
app.get('/reset-password-web', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('<h3>Error: Enlace inválido o sin token.</h3>');

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Restablecer Contraseña - DriverFlow</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; padding: 20px; max-width: 400px; margin: 0 auto; }
                input { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; }
                button { width: 100%; padding: 10px; background: #000; color: #fff; border: none; cursor: pointer; }
                .success { color: green; }
                .error { color: red; }
            </style>
        </head>
        <body>
            <h2>Restablecer Contraseña</h2>
            <form id="resetForm">
                <input type="hidden" id="token" value="${token}" />
                <label>Nueva Contraseña:</label>
                <input type="password" id="password" required placeholder="Ingresa tu nueva clave" minlength="6"/>
                <button type="submit">Guardar Nueva Contraseña</button>
                <p id="msg"></p>
            </form>
            <script>
                document.getElementById('resetForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const token = document.getElementById('token').value;
                    const new_password = document.getElementById('password').value;
                    const msg = document.getElementById('msg');
                    msg.textContent = 'Procesando...';
                    msg.className = '';

                    try {
                        const res = await fetch('/reset_password', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ token, new_password })
                        });
                        const data = await res.json();
                        if (res.ok) {
                            msg.textContent = '✅ Contraseña actualizada. Ya puedes entrar a la App.';
                            msg.className = 'success';
                            document.getElementById('password').value = '';
                            document.querySelector('button').disabled = true;
                        } else {
                            msg.textContent = '❌ ' + (data.error || 'Error al actualizar');
                            msg.className = 'error';
                        }
                    } catch (err) {
                        msg.textContent = '❌ Error de conexión';
                        msg.className = 'error';
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// --- Reset Password ---
app.post('/reset_password', async (req, res) => {
    const { token, new_password } = req.body;
    if (!token || !new_password) return res.status(400).json({ error: 'Faltan datos' });

    let user = db.prepare("SELECT id, 'driver' as type, reset_expires FROM drivers WHERE reset_token = ?").get(token);
    if (!user) user = db.prepare("SELECT id, 'empresa' as type, reset_expires FROM empresas WHERE reset_token = ?").get(token);

    if (!user) return res.status(400).json({ error: 'Token inválido' });
    if (new Date(user.reset_expires) < new Date()) return res.status(400).json({ error: 'Token expirado' });

    // Password Policy
    if (req.body.confirm_new_password && req.body.confirm_new_password !== new_password) {
        return res.status(400).json({ error: 'PASSWORDS_DO_NOT_MATCH' });
    }
    if (!isStrongPassword(new_password)) {
        return res.status(400).json({ error: 'WEAK_PASSWORD' });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);
    const table = user.type === 'driver' ? 'drivers' : 'empresas';

    db.prepare(`UPDATE ${table} SET password_hash = ?, reset_token = NULL WHERE id = ?`).run(hashedPassword, user.id);

    res.json({ ok: true });
});

// 1.1 Activation / Search Status Toggle - NEW
app.post('/company/search_status', authenticateToken, (req, res) => {
    if (req.user.type !== 'empresa') return res.sendStatus(403);
    const { status } = req.body;

    if (!['ON', 'OFF'].includes(status)) return res.status(400).json({ error: 'Invalid status (ON/OFF)' });

    try {
        // Guard: Blocked?
        if (status === 'ON') {
            enforceCompanyCanOperate(db, req.user.id, 'enable_search');
        }

        const nowStr = nowIso();
        const toggleTx = db.transaction(() => {
            // Update
            db.prepare('UPDATE empresas SET search_status = ? WHERE id = ?').run(status, req.user.id);

            // Emit Event
            db.prepare(`
                INSERT INTO events_outbox (event_name, created_at, company_id, request_id, metadata)
                VALUES (?, ?, ?, NULL, ?)
            `).run('search_status_changed', nowStr, req.user.id, JSON.stringify({ new_status: status }));
        });

        toggleTx();
        res.json({ success: true, search_status: status });

    } catch (err) {
        if (err.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') {
            return res.status(403).json({ error: 'COMPANY_BLOCKED', reason: err.details });
        }
        res.status(500).json({ error: err.message });
    }
});

// PHASE D: AUTOMATED MATCHING ENDPOINTS

// 1. Driver Search Status
app.post('/driver/search_status', authenticateToken, (req, res) => {
    if (req.user.type !== 'driver') return res.sendStatus(403);
    const { status } = req.body;
    if (!['ON', 'OFF'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    // Add logic here if drivers can be suspended? For now, just update.
    db.prepare('UPDATE drivers SET search_status = ? WHERE id = ?').run(status, req.user.id);
    res.json({ success: true, search_status: status });
});

// 2. Company Potential Matches
app.get('/company/potential_matches', authenticateToken, (req, res) => {
    if (req.user.type !== 'empresa') return res.sendStatus(403);

    // Return anon potential matches
    const matches = db.prepare(`
        SELECT pm.created_at, pm.status, pm.match_score, d.tipo_licencia, d.experience_level, d.available_start
        FROM potential_matches pm
        JOIN drivers d ON pm.driver_id = d.id
        WHERE pm.company_id = ?
        ORDER BY pm.created_at DESC
    `).all(req.user.id);

    res.json(matches);
});

// 3. Driver Potential Matches
app.get('/driver/potential_matches', authenticateToken, (req, res) => {
    if (req.user.type !== 'driver') return res.sendStatus(403);

    // Return anon potential matches
    const matches = db.prepare(`
        SELECT pm.created_at, pm.status, pm.match_score, e.nombre -- 'nombre' is public/verified name
        FROM potential_matches pm
        JOIN empresas e ON pm.company_id = e.id
        WHERE pm.driver_id = ?
        ORDER BY pm.created_at DESC
    `).all(req.user.id);

    res.json(matches);
});

// --- FASE 3: GATING & ROUNDS LOGICHelpers ---

const ROUND_DURATION_SEC = 30;
const N_DRIVERS = 3;

// Helper: Seleccionar Drivers Aleatorios Compatibles
const selectRandomDrivers = (count, licenciaReq, excludeIds = []) => {
    let query = `SELECT id FROM drivers WHERE estado = 'DISPONIBLE' AND tipo_licencia = ?`;
    if (excludeIds.length > 0) {
        query += ` AND id NOT IN (${excludeIds.join(',')})`;
    }
    query += ` ORDER BY random() LIMIT ?`;
    return db.prepare(query).all(licenciaReq, count).map(d => d.id);
};

// Helper: Avance Mecánico de Rondas
const advance_rounds = () => {
    // ⚠️ USE SIMULATED TIME
    const now = new Date(nowIso());

    // 1. Buscar solicitudes vencidas en R1, R2 o R3
    const pendingReqs = db.prepare(`
        SELECT id, ronda_actual, licencia_req, fecha_inicio_ronda 
        FROM solicitudes 
        WHERE estado = 'PENDIENTE' AND ronda_actual <= 3
    `).all();

    const updates = db.transaction((reqs) => {
        for (const req of reqs) {
            const startDate = new Date(req.fecha_inicio_ronda);
            const secondsElapsed = (now - startDate) / 1000;

            if (secondsElapsed >= ROUND_DURATION_SEC) {
                if (req.ronda_actual < 3) {
                    // Promoción de Ronda (1->2, 2->3)
                    let nextRound = req.ronda_actual + 1;

                    // Update
                    db.prepare(`
                        UPDATE solicitudes 
                        SET ronda_actual = ?, fecha_inicio_ronda = ? 
                        WHERE id = ?
                    `).run(nextRound, now.toISOString(), req.id);

                    // Si pasamos a R2, logica de notificar N drivers más
                    if (nextRound === 2) {
                        const notified = db.prepare('SELECT driver_id FROM request_visibility WHERE request_id = ?').all(req.id).map(r => r.driver_id);
                        const newDrivers = selectRandomDrivers(N_DRIVERS, req.licencia_req, notified);
                        const insertVis = db.prepare('INSERT INTO request_visibility (request_id, driver_id, ronda) VALUES (?, ?, ?)');
                        newDrivers.forEach(did => insertVis.run(req.id, did, 2));
                    }
                } else {
                    // Ronda 3 Vencida -> EXPIRAR
                    console.log(`Solicitud ${req.id} venció en Ronda 3. Expirando...`);
                    db.prepare(`
                        UPDATE solicitudes 
                        SET estado = 'EXPIRADA', fecha_cierre = ? 
                        WHERE id = ?
                    `).run(now.toISOString(), req.id);
                }
            }
        }
    });

    updates(pendingReqs);
};

// 3. Create Request (Empresa) - UPDATED PHASE 3
// 3. Create Request (Empresa) - PHASE 4: GLOBAL VISIBILITY
app.post('/create_request', authenticateToken, (req, res) => {
    if (req.user.type !== 'empresa') return res.sendStatus(403);
    const empresa_id = req.user.id;

    // Check Search Status (Operational Flag)
    const company = db.prepare('SELECT search_status FROM empresas WHERE id = ?').get(empresa_id);
    if (company && company.search_status === 'OFF') {
        return res.status(403).json({ error: 'SEARCH_OFF', message: 'Turn on search to create requests.' });
    }

    // 0. Update & Check Block Status (STRICT GUARD) - MOVED OUTSIDE TRANSACTION
    try {
        enforceCompanyCanOperate(db, empresa_id, 'create_request');
    } catch (err) {
        if (err.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') {
            return res.status(403).json({ error: 'COMPANY_BLOCKED', reason: err.details });
        }
        throw err;
    }

    const { licencia_req, ubicacion, tiempo_estimado } = req.body;

    const createTransaction = db.transaction(() => {
        // 1. Validar 1 activa
        const activeCheck = db.prepare(`
            SELECT count(*) as count FROM solicitudes 
            WHERE empresa_id = ? AND estado IN ('PENDIENTE', 'EN_REVISION', 'ACEPTADA')
        `).get(empresa_id);

        if (activeCheck.count > 0) throw new Error('ACTIVE_REQUEST_EXISTS');

        // Use SIMULATED TIME
        const currentMs = nowEpochMs();
        const expiresAt = new Date(currentMs + REQUEST_DURATION_MINUTES * 60000).toISOString();

        // 2. Insertar Solicitud (No Rounds)
        const stmt = db.prepare(`
            INSERT INTO solicitudes (empresa_id, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion)
            VALUES (?, ?, ?, ?, ?)
        `);
        const info = stmt.run(empresa_id, licencia_req, ubicacion, tiempo_estimado, expiresAt);
        const reqId = info.lastInsertRowid;

        return { id: reqId, status: 'PENDIENTE' };
    });

    try {
        const result = createTransaction();
        res.status(201).json(result);
    } catch (err) {
        if (err.message === 'ACTIVE_REQUEST_EXISTS') return res.status(409).json({ error: 'Ya tienes una solicitud activa' });
        res.status(500).json({ error: err.message });
    }
});

// 4. List Available Requests (Driver) - PHASE 4: GLOBAL LIST
app.get('/list_available_requests', authenticateToken, (req, res) => {
    if (req.user.type !== 'driver') return res.sendStatus(403);
    const driver_id = req.user.id;

    // Verificar estado del driver
    const driver = db.prepare('SELECT estado, tipo_licencia, search_status FROM drivers WHERE id = ?').get(driver_id);

    // Flags: Operational Check
    if (!driver || driver.search_status === 'OFF') return res.json([]); // Not Available
    if (driver.estado === 'OCUPADO' || driver.estado === 'SUSPENDED') return res.json([]);

    // Listado Global (Matching License)
    const nowStr = nowIso();

    const requests = db.prepare(`
        SELECT s.id, 'Verified Company' as empresa, s.ubicacion, s.tiempo_estimado, s.fecha_expiracion
        FROM solicitudes s
        JOIN empresas e ON s.empresa_id = e.id
        WHERE s.estado = 'PENDIENTE'
        AND s.licencia_req = ?
        AND s.fecha_expiracion > ? 
    `).all(driver.tipo_licencia, nowStr);

    res.json(requests);
});

// 5. Accept Request (ATÓMICA)
// 5. Apply for Request (Driver Action) - PHASE 4: APPLY ONLY
app.post('/apply_for_request', authenticateToken, (req, res) => {
    if (req.user.type !== 'driver') return res.sendStatus(403);
    const { request_id } = req.body;

    // Note: Driver apply technically checks company availability in Step 3. 
    // If we move it out, we must fetch reqInfo first to know company_id.
    // Or we leave it inside? The persistence issue is less critical here (Driver triggering block on company?). 
    // Actually, enforceCompanyCanOperate updates COMPANY status. 
    // If driver applies, and company is found owing money, we want to block company? Yes.
    // We'll calculate it inside, but we need to ensure the block persists even if "Driver Apply" fails?
    // Actually, better to fetch info, check block, then transaction.

    // FETCH INFO FIRST (Read-Only)
    const nowStr = nowIso();
    const reqInfo = db.prepare(`
        SELECT * FROM solicitudes 
        WHERE id = ? 
        AND estado = 'PENDIENTE' 
        AND fecha_expiracion > ?
    `).get(request_id, nowStr);

    if (!reqInfo) return res.status(409).json({ error: 'Solicitud no encontrada, expirada o ya tomada' });

    // 3. Validar Estricta de Bloqueo (Company check) - OUTSIDE TRANSACTION
    try {
        enforceCompanyCanOperate(db, reqInfo.empresa_id, 'driver_apply');
    } catch (err) {
        if (err.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') {
            return res.status(403).json({ error: 'COMPANY_BLOCKED', reason: err.details });
        }
        // If not blocking error, maybe generic? 
        return res.status(500).json({ error: err.message });
    }

    const performApply = db.transaction(() => {
        // 1. Validar Driver
        const driver = db.prepare('SELECT estado, nombre, search_status FROM drivers WHERE id = ?').get(req.user.id);
        if (driver.search_status === 'OFF') throw new Error('DRIVER_SEARCH_OFF');
        if (driver.estado !== 'DISPONIBLE') throw new Error('DRIVER_NOT_AVAILABLE');

        // Re-check request state inside transaction to be safe? 
        // We already checked above, but race conditions exist.
        // It's acceptable for MVP to rely on first check or re-check.
        const reCheck = db.prepare("SELECT driver_id FROM solicitudes WHERE id = ?").get(request_id);
        if (reCheck.driver_id) throw new Error('REQUEST_TAKEN');

        // 4. Actualizar Solicitud -> EN_REVISION
        const updateReq = db.prepare('UPDATE solicitudes SET estado = ?, driver_id = ? WHERE id = ?');
        updateReq.run('EN_REVISION', req.user.id, request_id);

        // 5. Actualizar Driver -> OCUPADO (Pending Approval)
        const updateDriver = db.prepare('UPDATE drivers SET estado = ? WHERE id = ?');
        updateDriver.run('OCUPADO', req.user.id);

        // 6. Emit Event: driver_applied (Notify Company)
        db.prepare(`
            INSERT INTO events_outbox (event_name, created_at, company_id, driver_id, request_id, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            'driver_applied',
            nowStr,
            reqInfo.empresa_id,
            req.user.id,
            request_id,
            JSON.stringify({ driver_name: driver.nombre, message: 'Driver applied, waiting approval.' })
        );
    });

    try {
        performApply();
        res.json({ success: true, message: 'Solicitud aplicada. Esperando aprobación de la empresa.' });
    } catch (err) {
        if (err.message === 'DRIVER_NOT_AVAILABLE') return res.status(409).json({ error: 'Driver no disponible' });
        if (err.message === 'REQUEST_TAKEN') return res.status(409).json({ error: 'Solicitud ya tomada' });
        if (err.message === 'DRIVER_SEARCH_OFF') return res.status(409).json({ error: 'Search mode OFF' });
        res.status(500).json({ error: err.message });
    }
});

// 6. Approve Driver (Company Action) - PHASE 4: FINAL MATCH & BILLING
app.post('/approve_driver', authenticateToken, (req, res) => {
    if (req.user.type !== 'empresa') return res.sendStatus(403);
    const { request_id } = req.body;

    // 2. Estricta Check de Bloqueo (Final Guard) - OUTSIDE TRANSACTION
    try {
        enforceCompanyCanOperate(db, req.user.id, 'approve_driver_match');
    } catch (err) {
        if (err.code === 'ACCOUNT_BLOCKED_OVERDUE_INVOICES') {
            return res.status(403).json({ error: 'COMPANY_BLOCKED', reason: err.details });
        }
        return res.status(500).json({ error: err.message });
    }

    const performApproval = db.transaction(() => {
        // 1. Validar Solicitud
        const nowStr = nowIso();
        const reqInfo = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(request_id);

        if (!reqInfo) throw new Error('NOT_FOUND');
        if (reqInfo.empresa_id !== req.user.id) throw new Error('FORBIDDEN');
        if (reqInfo.estado !== 'EN_REVISION') throw new Error('INVALID_STATE');
        if (!reqInfo.driver_id) throw new Error('NO_APPLICANT');

        // 3. Update Request -> ACEPTADA
        db.prepare('UPDATE solicitudes SET estado = ? WHERE id = ?').run('ACEPTADA', request_id);

        // 4. Generate Ticket (BILLING EVENT)
        const ticketStmt = db.prepare(`
            INSERT INTO tickets (company_id, driver_id, request_id, price_cents, currency, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const ticketInfo = ticketStmt.run(reqInfo.empresa_id, reqInfo.driver_id, request_id, 15000, 'USD', nowStr);

        // 5. Emit Event: match_confirmed (Info Exchange)
        db.prepare(`
            INSERT INTO events_outbox (event_name, created_at, company_id, driver_id, request_id, ticket_id, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            'match_confirmed',
            nowStr,
            reqInfo.empresa_id,
            reqInfo.driver_id,
            request_id,
            ticketInfo.lastInsertRowid,
            JSON.stringify({ price_cents: 15000, currency: 'USD', message: 'Contact info exchanged' })
        );

        return { ticket_id: ticketInfo.lastInsertRowid };
    });

    try {
        const result = performApproval();
        res.json({ success: true, message: 'Driver aprobado. Datos de contacto intercambiados.', ticket_id: result.ticket_id });
    } catch (err) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Solicitud no encontrada' });
        if (err.message === 'FORBIDDEN') return res.status(403).json({ error: 'No autorizado' });
        if (err.message === 'INVALID_STATE') return res.status(400).json({ error: 'Solicitud no está lista para aprobación' });
        res.status(500).json({ error: err.message });
    }
});

// --- FASE 2: CICLO DE VIDA (Complete & Cancel) ---

// 6. Complete Request (Driver only)
app.post('/request/:id/complete', authenticateToken, (req, res) => {
    if (req.user.type !== 'driver') return res.sendStatus(403);
    const requestId = req.params.id;

    const performComplete = db.transaction(() => {
        const info = db.prepare('SELECT driver_id, estado FROM solicitudes WHERE id = ?').get(requestId);

        if (!info) throw new Error('NOT_FOUND');
        if (info.driver_id !== req.user.id) throw new Error('FORBIDDEN');
        if (info.estado !== 'ACEPTADA') throw new Error('INVALID_STATE');

        const now = nowIso();
        db.prepare(`
            UPDATE solicitudes 
            SET estado = 'FINALIZADA', fecha_cierre = ? 
            WHERE id = ?
        `).run(now, requestId);

        db.prepare('UPDATE drivers SET estado = "DISPONIBLE" WHERE id = ?').run(req.user.id);
    });

    try {
        performComplete();
        res.json({ success: true, message: 'Servicio completado. Driver disponible.' });
    } catch (err) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Solicitud no encontrada' });
        if (err.message === 'FORBIDDEN') return res.status(403).json({ error: 'No autorizado para esta solicitud' });
        if (err.message === 'INVALID_STATE') return res.status(400).json({ error: 'La solicitud no está en curso' });
        res.status(500).json({ error: err.message });
    }
});

// 7. Cancel Request (Empresa o Driver)
app.post('/request/:id/cancel', authenticateToken, (req, res) => {
    const requestId = req.params.id;
    const { type, id: userId } = req.user;

    const performCancel = db.transaction(() => {
        const reqInfo = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(requestId);
        if (!reqInfo) throw new Error('NOT_FOUND');

        if (type === 'empresa' && reqInfo.empresa_id !== userId) throw new Error('FORBIDDEN');
        if (type === 'driver' && reqInfo.driver_id !== userId) throw new Error('FORBIDDEN');

        if (!['PENDIENTE', 'EN_REVISION', 'ACEPTADA'].includes(reqInfo.estado)) {
            throw new Error('INVALID_STATE');
        }

        const now = nowIso();

        if (type === 'driver') {
            if (reqInfo.estado === 'ACEPTADA') {
                // 1. VOID EXISTNG TICKET
                db.prepare(`
                    UPDATE tickets 
                    SET billing_status = 'void', updated_at = ? 
                    WHERE request_id = ? AND driver_id = ? AND billing_status = 'unbilled'
                `).run(now, requestId, userId);

                db.prepare(`
                    UPDATE solicitudes 
                    SET estado = 'PENDIENTE', driver_id = NULL 
                    WHERE id = ?
                `).run(requestId);

                db.prepare('UPDATE drivers SET estado = "DISPONIBLE" WHERE id = ?').run(userId);
            } else if (reqInfo.estado === 'EN_REVISION') {
                // Driver withdraws application
                db.prepare(`
                    UPDATE solicitudes 
                    SET estado = 'PENDIENTE', driver_id = NULL 
                    WHERE id = ?
                `).run(requestId);
                db.prepare('UPDATE drivers SET estado = "DISPONIBLE" WHERE id = ?').run(userId);
            } else {
                throw new Error('INVALID_ACTION_FOR_DRIVER');
            }
        } else {
            // Company Cancel
            // 1. VOID TICKET IF EXISTS
            if (reqInfo.driver_id && reqInfo.estado === 'ACEPTADA') {
                db.prepare(`
                    UPDATE tickets 
                    SET billing_status = 'void', updated_at = ? 
                    WHERE request_id = ? AND driver_id = ? AND billing_status = 'unbilled'
                `).run(now, requestId, reqInfo.driver_id);
            }

            db.prepare(`
                UPDATE solicitudes 
                SET estado = 'CANCELADA', fecha_cierre = ?, cancelado_por = 'EMPRESA' 
                WHERE id = ?
            `).run(now, requestId);

            if (reqInfo.driver_id) {
                db.prepare('UPDATE drivers SET estado = "DISPONIBLE" WHERE id = ?').run(reqInfo.driver_id);
            }

            db.prepare(`
                INSERT INTO events_outbox (event_name, created_at, company_id, driver_id, request_id, metadata)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                'request_cancelled',
                now,
                reqInfo.empresa_id,
                reqInfo.driver_id,
                requestId,
                JSON.stringify({ reason: 'CANCELLED_BY_COMPANY' })
            );
        }
    });

    try {
        performCancel();
        res.json({ success: true, message: 'Operación realizada correctamente.' });
    } catch (err) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Solicitud no encontrada' });
        if (err.message === 'FORBIDDEN') return res.status(403).json({ error: 'No tienes permiso sobre esta solicitud' });
        if (err.message === 'INVALID_STATE') return res.status(400).json({ error: 'Solo se pueden cancelar solicitudes activas' });
        if (err.message === 'INVALID_ACTION_FOR_DRIVER') return res.status(400).json({ error: 'No puedes cancelar una solicitud que no has aceptado' });
        res.status(500).json({ error: err.message });
    }
});

// 7. Get Contact Details (Secure Match Info) - PHASE 4: PRIVACY
app.get('/request/:id/contact', authenticateToken, (req, res) => {
    const requestId = req.params.id;
    const { type, id: userId } = req.user;

    const reqInfo = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(requestId);
    if (!reqInfo) return res.status(404).json({ error: 'Request not found' });

    // Validate Access (Must be participant)
    const isCompany = type === 'empresa' && reqInfo.empresa_id === userId;
    const isDriver = type === 'driver' && reqInfo.driver_id === userId;

    if (!isCompany && !isDriver) return res.status(403).json({ error: 'Forbidden' });

    // Validate State (Must be Matched/Paid Ticket existence assumed if ACEPTADA)
    if (!['ACEPTADA', 'FINALIZADA', 'CANCELADA'].includes(reqInfo.estado)) {
        if (reqInfo.estado === 'EN_REVISION' || reqInfo.estado === 'PENDIENTE') {
            return res.status(403).json({ error: 'Contact details hidden until match is approved' });
        }
    }

    let contactData = {};

    try {
        if (isCompany) {
            // Guard 1: Operational Check (REQ 2 - Strict on High Value) - Also catches blocking updates
            try {
                enforceCompanyCanOperate(db, userId, 'reveal_contact');
            } catch (e) {
                return res.status(403).json({ error: 'COMPANY_BLOCKED', reason: e.details });
            }

            // Guard 2: Payment Assurance (REQ 1 - Strict Invoice Paid)
            // Find Ticket and Associated Invoice Status
            const ticketInfo = db.prepare(`
                SELECT t.id, t.billing_status, i.status as invoice_status, i.paid_at
                FROM tickets t
                LEFT JOIN invoice_items ii ON t.id = ii.ticket_id
                LEFT JOIN invoices i ON ii.invoice_id = i.id
                WHERE t.request_id = ? AND t.company_id = ?
            `).get(requestId, userId);

            if (!ticketInfo) {
                // No ticket = No deal.
                return res.status(402).json({ error: 'CONTACT_LOCKED_PAYMENT_REQUIRED', detail: 'No ticket generated.' });
            }

            // Guard 3: Void Check (REQ 1.3)
            if (ticketInfo.billing_status === 'void') {
                return res.status(403).json({ error: 'CONTACT_LOCKED_VOIDED', detail: 'Ticket voided.' });
            }

            // Guard 4: Invoice Paid Check (REQ 1.4 - OBLIGATORY)
            if (ticketInfo.invoice_status !== 'paid' || !ticketInfo.paid_at) {
                return res.status(402).json({
                    error: 'CONTACT_LOCKED_PAYMENT_REQUIRED',
                    detail: 'Invoice not paid.',
                    invoice_status: ticketInfo.invoice_status || 'unbilled'
                });
            }

            // If passes, fetch data
            const driver = db.prepare('SELECT nombre, contacto, tipo_licencia, rating_avg FROM drivers WHERE id = ?').get(reqInfo.driver_id);
            contactData = { type: 'driver', ...driver };

        } else {
            // Driver viewing Company
            const company = db.prepare('SELECT nombre, contacto, ciudad FROM empresas WHERE id = ?').get(reqInfo.empresa_id);
            contactData = { type: 'company', ...company };
        }

        res.json(contactData);

    } catch (err) {
        console.error(`[RevealContact Error] ReqID: ${requestId} UserID: ${userId}`, err);
        res.status(500).json({ error: err.message });
    }
});

// 9. Rate Driver Service (Reputation System) - NEW
app.post('/rate_service', authenticateToken, (req, res) => {
    if (req.user.type !== 'empresa') return res.sendStatus(403);
    const { request_id, rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const performRating = db.transaction(() => {
        // 1. Validate Request & Ownership
        const reqInfo = db.prepare('SELECT driver_id, empresa_id, estado FROM solicitudes WHERE id = ?').get(request_id);

        if (!reqInfo) throw new Error('NOT_FOUND');
        if (reqInfo.empresa_id !== req.user.id) throw new Error('FORBIDDEN');
        if (reqInfo.estado !== 'FINALIZADA') throw new Error('INVALID_STATE'); // Only finished jobs
        if (!reqInfo.driver_id) throw new Error('NO_DRIVER');

        // 2. Insert Rating (Unique per request)
        db.prepare(`
            INSERT INTO ratings (request_id, company_id, driver_id, rating, comment, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(request_id, req.user.id, reqInfo.driver_id, rating, comment || null, nowIso());

        // 3. Update Driver Stats & Check Suspension
        const stats = db.prepare(`
            SELECT AVG(rating) as avg_rating, COUNT(*) as count 
            FROM ratings 
            WHERE driver_id = ?
        `).get(reqInfo.driver_id);

        const newAvg = stats.avg_rating || rating;
        let newStatus = 'DISPONIBLE'; // Default, won't overwrite OCUPADO if currently working elsewhere?
        // Actually, if request is finished, driver IS available unless suspended.

        let suspensionReason = null;

        // RULE: Suspend if Avg < 3.0 AND Count >= 5
        if (stats.count >= 5 && newAvg < 3.0) {
            newStatus = 'SUSPENDED';
            suspensionReason = `Low Rating: ${newAvg.toFixed(2)} (${stats.count} reviews)`;
        }

        // Update Driver
        db.prepare(`
            UPDATE drivers 
            SET rating_avg = ?, 
                estado = CASE WHEN ? = 'SUSPENDED' THEN 'SUSPENDED' ELSE estado END,
                suspension_reason = ?
            WHERE id = ?
        `).run(newAvg, newStatus, suspensionReason, reqInfo.driver_id);

        if (newStatus === 'SUSPENDED') {
            const now = nowIso(); // helper from scope
            db.prepare(`
                INSERT INTO events_outbox (event_name, created_at, company_id, driver_id, request_id, metadata)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run('driver_suspended', now, req.user.id, reqInfo.driver_id, request_id, JSON.stringify({ reason: suspensionReason }));
        }

        return { newAvg, newStatus };
    });

    try {
        const result = performRating();
        res.json({ success: true, driver_rating: result.newAvg, driver_status: result.newStatus });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Service already rated' });
        if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Request not found' });
        if (err.message === 'INVALID_STATE') return res.status(400).json({ error: 'Service not finished' });
        res.status(500).json({ error: err.message });
    }
});

// --- 1. Register - REAL ONBOARDING ---
app.post('/register', async (req, res) => {
    const { type, nombre, contacto, password, ...extras } = req.body;

    if (!['driver', 'empresa'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    if (!nombre || !contacto || !password) return res.status(400).json({ error: 'Missing basic fields' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex');
        const now = nowIso();
        const expires = new Date(Date.now() + 24 * 3600000).toISOString();

        if (type === 'driver') {
            const { tipo_licencia } = extras;
            const stmt = db.prepare(`
                INSERT INTO drivers (
                    nombre, contacto, password_hash, tipo_licencia, 
                    status, created_at, verified, 
                    verification_token, verification_expires
                ) VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?)
            `);
            const info = stmt.run(nombre, contacto, hashedPassword, tipo_licencia || 'B', now, token, expires);

            db.prepare(`
                INSERT INTO events_outbox (event_name, created_at, driver_id, metadata)
                VALUES (?, ?, ?, ?)
            `).run('verification_email', now, info.lastInsertRowid, JSON.stringify({
                token,
                email: contacto,
                name: nombre,
                user_type: 'driver'
            }));
        }
        else {
            const { legal_name, address_line1, address_city } = extras;
            const stmt = db.prepare(`
                INSERT INTO empresas (
                    nombre, contacto, password_hash, 
                    legal_name, address_line1, ciudad, 
                    verified, verification_token, verification_expires, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            `);
            const info = stmt.run(nombre, contacto, hashedPassword, legal_name || nombre, address_line1 || '', address_city || '', token, expires, now);

            db.prepare(`
                INSERT INTO events_outbox (event_name, created_at, company_id, metadata)
                VALUES (?, ?, ?, ?)
            `).run('verification_email', now, info.lastInsertRowid, JSON.stringify({
                token,
                email: contacto,
                name: nombre,
                user_type: 'empresa'
            }));
        }

        // NO TOKEN RETURNED. STRICT VERIFICATION.
        return res.status(200).json({
            ok: true,
            require_email_verification: true,
            message: 'Registro exitoso. Verifique su correo para entrar.'
        });

    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Usuario ya registrado' });
        console.error('Register Error:', err);
        return res.status(500).json({ error: 'Internal Error' });
    }
});

// --- 2. Login (STRICT) ---
app.post('/login', async (req, res) => {
    const { type, contacto, password } = req.body;
    if (!['driver', 'empresa'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });

    const table = type === 'driver' ? 'drivers' : 'empresas';
    const row = db.prepare(`SELECT * FROM ${table} WHERE contacto = ?`).get(contacto);

    if (!row) return res.status(401).json({ error: 'Credenciales inválidas' }); // Generic error

    // STRICT VERIFICATION
    if (row.verified !== 1) {
        return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED' });
    }

    if (await bcrypt.compare(password, row.password_hash)) {
        const payload = { id: row.id, type };
        const token = jwt.sign(payload, SECRET_KEY, { expiresIn: '24h' });
        res.json({ ok: true, token, type, id: row.id, nombre: row.nombre });
    } else {
        res.status(401).json({ error: 'Credenciales inválidas' });
    }
});

// --- Verify Email (GET/POST) ---
app.all('/verify-email', (req, res) => {
    const token = req.method === 'GET' ? req.query.token : req.body.token;
    if (!token) return res.status(400).send('<h1>Error: Missing Token</h1>');

    let user = db.prepare("SELECT id, 'driver' as type, verification_expires FROM drivers WHERE verification_token = ?").get(token);
    if (!user) user = db.prepare("SELECT id, 'empresa' as type, verification_expires FROM empresas WHERE verification_token = ?").get(token);

    if (!user) return res.status(404).send('<h1>Error: Link inválido o ya usado.</h1>');

    if (new Date(user.verification_expires) < new Date()) {
        return res.status(400).send('<h1>Error: El link ha expirado. Solicite uno nuevo.</h1>');
    }

    const table = user.type === 'driver' ? 'drivers' : 'empresas';
    db.prepare(`UPDATE ${table} SET verified = 1, verification_token = NULL WHERE id = ?`).run(user.id);

    if (req.method === 'GET') {
        res.send(`
            <html>
                <body style="font-family:sans-serif; text-align:center; padding:50px;">
                    <h1 style="color:green;">¡Email Verificado!</h1>
                    <p>Tu cuenta ha sido activada correctamente.</p>
                    <p>Ya puedes cerrar esta ventana e iniciar sesión en la App.</p>
                    <script>setTimeout(() => window.location.href = "driverflow://login", 2000);</script>
                </body>
            </html>
        `);
    } else {
        res.json({ success: true });
    }
});

// --- Resend Verification (NORMALIZED + ANTI-ENUMERATION) ---
app.post(['/resend-verification', '/resend_verification'], (req, res) => {
    let { type, contact, email } = req.body;

    // Normalize Type
    type = String(type || '').trim().toLowerCase();
    if (type === 'company') type = 'empresa';
    if (!['driver', 'empresa'].includes(type)) type = 'driver'; // Default or Fail? MVP: Default search driver first or just fail safely.
    // Better: if invalid type, just return 200 to not leak API structure errors?
    // Let's rely on searched tables.

    // Normalize Email
    const target = String(contact || email || '').trim().toLowerCase();

    if (!target) return res.json({ ok: true, message: 'Si la cuenta existe, recibirá un correo.' });

    // Try finding user
    let user = null;
    let table = '';

    // If strict type provided, search that. If ambiguous, search both?
    // Spec says: "normaliza type... si type falta: buscar en drivers y empresas"

    if (type === 'driver') {
        user = db.prepare('SELECT * FROM drivers WHERE lower(contacto) = ?').get(target);
        if (user) table = 'drivers';
    } else if (type === 'empresa') {
        user = db.prepare('SELECT * FROM empresas WHERE lower(contacto) = ?').get(target);
        if (user) table = 'empresas';
    }

    // Fallback if type not found or not specified correctly
    if (!user) {
        user = db.prepare('SELECT * FROM drivers WHERE lower(contacto) = ?').get(target);
        if (user) { table = 'drivers'; type = 'driver'; }
        else {
            user = db.prepare('SELECT * FROM empresas WHERE lower(contacto) = ?').get(target);
            if (user) { table = 'empresas'; type = 'empresa'; }
        }
    }

    // Logic
    if (user && user.verified === 0) {
        const token = crypto.randomBytes(32).toString('hex');
        const now = nowIso();
        const expires = new Date(Date.now() + 24 * 3600000).toISOString();

        db.prepare(`UPDATE ${table} SET verification_token = ?, verification_expires = ? WHERE id = ?`).run(token, expires, user.id);

        const idCol = table === 'drivers' ? 'driver_id' : 'company_id';
        db.prepare(`
            INSERT INTO events_outbox (event_name, created_at, ${idCol}, metadata)
            VALUES (?, ?, ?, ?)
        `).run('verification_email', now, user.id, JSON.stringify({
            token,
            email: user.contacto,
            name: user.nombre,
            user_type: type
        }));
    }

    // ALWAYS 200 OK
    res.json({ ok: true, message: 'Si la cuenta existe y requiere verificación, se envió el correo.' });
});

// --- Forgot Password (NORMALIZED + ANTI-ENUMERATION) ---
app.post('/forgot_password', (req, res) => {
    let { type, contact, email } = req.body;

    // Normalize
    type = String(type || '').trim().toLowerCase();
    if (type === 'company') type = 'empresa';

    const target = String(contact || email || '').trim().toLowerCase();
    if (!target) return res.json({ ok: true, message: 'Si la cuenta existe, recibirá un correo.' });

    let user = null;
    let table = '';

    // Search
    user = db.prepare('SELECT * FROM drivers WHERE lower(contacto) = ?').get(target);
    if (user) { table = 'drivers'; type = 'driver'; }
    else {
        user = db.prepare('SELECT * FROM empresas WHERE lower(contacto) = ?').get(target);
        if (user) { table = 'empresas'; type = 'empresa'; }
    }

    if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        const now = nowIso();
        const expires = new Date(Date.now() + 1 * 3600000).toISOString();

        db.prepare(`UPDATE ${table} SET reset_token = ?, reset_expires = ? WHERE id = ?`).run(token, expires, user.id);

        const idCol = table === 'drivers' ? 'driver_id' : 'company_id';
        db.prepare(`
            INSERT INTO events_outbox (event_name, created_at, ${idCol}, metadata)
            VALUES (?, ?, ?, ?)
        `).run('recovery_email', now, user.id, JSON.stringify({
            token,
            email: user.contacto,
            name: user.nombre,
            user_type: type
        }));
    }

    // ALWAYS 200 OK
    res.json({ ok: true, message: 'Si la cuenta existe, recibirá un correo.' });
});

// --- Reset Password ---
app.post('/reset_password', async (req, res) => {
    const { token, new_password } = req.body;
    if (!token || !new_password) return res.status(400).json({ error: 'Faltan datos' });

    let user = db.prepare("SELECT id, 'driver' as type, reset_expires FROM drivers WHERE reset_token = ?").get(token);
    if (!user) user = db.prepare("SELECT id, 'empresa' as type, reset_expires FROM empresas WHERE reset_token = ?").get(token);

    if (!user) return res.status(400).json({ error: 'Token inválido' });
    if (new Date(user.reset_expires) < new Date()) return res.status(400).json({ error: 'Token expirado' });

    const hashedPassword = await bcrypt.hash(new_password, 10);
    const table = user.type === 'driver' ? 'drivers' : 'empresas';

    db.prepare(`UPDATE ${table} SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?`).run(hashedPassword, user.id);

    res.json({ ok: true, success: true, message: 'Contraseña actualizada.' });
});

// 8. Payment Webhook (Stripe/Provider) - NEW
// 8. Payment Webhook (Stripe/Provider) - SECURE & IDEMPOTENT (REQ 3)
app.post('/webhooks/payment', (req, res) => {
    // 1. Security Check (Signature/Secret)
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (req.headers['x-webhook-secret'] !== webhookSecret) {
        return res.status(403).json({ error: 'Invalid Webhook Secret' });
    }

    const { type, data, id: event_id } = req.body;

    if (!event_id) return res.status(400).json({ error: 'Missing event_id' });
    if (type !== 'invoice.paid') {
        return res.json({ ignored: true });
    }

    const performPayment = db.transaction(() => {
        // 2. Idempotency Check (Strict)
        const processed = db.prepare('SELECT 1 FROM webhook_events WHERE id = ?').get(event_id);
        if (processed) return { skipped: true };

        // Record Event
        db.prepare('INSERT INTO webhook_events (id, provider) VALUES (?, ?)').run(event_id, 'stripe_prod');

        const { invoice_id, external_ref, amount_paid_cents } = data || {};
        if (!invoice_id) throw new Error('Missing invoice_id');

        // 3. Validate Invoice
        const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice_id);
        if (!invoice) throw new Error('INVOICE_NOT_FOUND');
        if (invoice.status === 'paid') return { skipped: true };

        // 4. Validate Amount (Exact Match Required)
        if (amount_paid_cents !== invoice.total_cents) {
            console.warn(`Payment Mismatch: Paid ${amount_paid_cents}, Expected ${invoice.total_cents}`);
            return { partial: true }; // Do NOT unlock
        }

        // 5. Mark Paid
        const now = nowIso();
        db.prepare(`
            UPDATE invoices 
            SET status = 'paid', paid_at = ?, paid_method = 'webhook', total_cents = ?
            WHERE id = ?
        `).run(now, amount_paid_cents, invoice_id);

        // 6. Emit Events
        // a) For Company (Invoice Paid / Ticket Unlocked)
        db.prepare(`
            INSERT INTO events_outbox (event_name, created_at, company_id, request_id, metadata)
            VALUES (?, ?, ?, ?, ?)
        `).run('invoice_paid', now, invoice.company_id, 0, JSON.stringify({ invoice_id, amount: amount_paid_cents }));

        // b) For Drivers? (Contact Unlocked)
        // Find all tickets in this invoice and notify respective drivers? 
        // User asked: "Chofer: Contacto desbloqueado"
        // Iterate ticket items.
        const items = db.prepare('SELECT ticket_id, price_cents FROM invoice_items WHERE invoice_id = ?').all(invoice_id);
        for (const item of items) {
            const ticket = db.prepare('SELECT driver_id, request_id FROM tickets WHERE id = ?').get(item.ticket_id);
            if (ticket) {
                db.prepare(`
                    INSERT INTO events_outbox (event_name, created_at, company_id, driver_id, request_id, metadata)
                    VALUES (?, ?, ?, ?, ?, ?)
                 `).run('contact_unlocked', now, invoice.company_id, ticket.driver_id, ticket.request_id, JSON.stringify({ message: 'Company paid. Contact revealed.' }));
            }
        }

        // 7. AUTO-UNBLOCK CHECK
        try {
            enforceCompanyCanOperate(db, invoice.company_id, 'webhook_payment');
        } catch (e) {
            // Still blocked? Maybe other invoices pending.
        }

        return { success: true };
    });

    try {
        const result = performPayment();
        if (result.skipped) return res.json({ success: true, message: 'Event already processed' });
        if (result.partial) return res.status(400).json({ error: 'Partial payment rejected' });
        res.json({ success: true });
    } catch (err) {
        if (err.message === 'INVOICE_NOT_FOUND') return res.status(404).json({ error: 'Invoice not found' });
        console.error('Webhook Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 11. Admin Support Endpoints
app.get('/admin/companies', (req, res) => {
    // Simple verification check (omitted for brevity, assume internal/VPN or shared secret)
    if (req.headers['x-admin-secret'] !== (process.env.ADMIN_SECRET || 'simulated_admin_secret')) return res.sendStatus(403);

    const companies = db.prepare('SELECT id, nombre, contacto, ciudad, estado, search_status, is_blocked, blocked_reason FROM empresas').all();
    res.json(companies);
});

app.get('/admin/payments', (req, res) => {
    if (req.headers['x-admin-secret'] !== (process.env.ADMIN_SECRET || 'simulated_admin_secret')) return res.sendStatus(403);
    const payments = db.prepare('SELECT * FROM invoices ORDER BY issue_date DESC LIMIT 100').all();
    res.json(payments);
});

// 10. Admin: Void Ticket (Dispute Management) - NEW
// 10. Admin: Void Ticket (Dispute Management) - SECURE & AUDITED (REQ 4)
app.post('/admin/tickets/void', (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET || 'simulated_admin_secret';
    if (req.headers['x-admin-secret'] !== adminSecret) {
        return res.status(403).json({ error: 'Unauthorized: Invalid Admin Secret' });
    }

    const { ticket_id, reason, admin_user } = req.body;
    if (!ticket_id) return res.status(400).json({ error: 'Missing ticket_id' });

    const performVoid = db.transaction(() => {
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket_id);
        if (!ticket) throw new Error('NOT_FOUND');
        if (ticket.billing_status === 'void') throw new Error('ALREADY_VOID');

        // Check if invoiced & paid
        let invoiceStatus = 'unbilled';
        let invoiceId = null;

        // Find invoice logic (via invoice_items)
        const item = db.prepare('SELECT invoice_id FROM invoice_items WHERE ticket_id = ?').get(ticket_id);
        if (item) {
            const invoice = db.prepare('SELECT status FROM invoices WHERE id = ?').get(item.invoice_id);
            invoiceId = item.invoice_id;
            invoiceStatus = invoice ? invoice.status : 'unknown';
        }

        const now = nowIso();

        if (invoiceStatus === 'paid') {
            // REQ 4: Cannot void paid ticket without credit/refund
            // Implement Credit Note
            db.prepare(`
                INSERT INTO credit_notes (company_id, amount_cents, reason, created_at)
                VALUES (?, ?, ?, ?)
            `).run(ticket.company_id, ticket.price_cents, `Void Ticket ${ticket_id}: ${reason}`, now);

            console.log(`Credit Note issued for Company ${ticket.company_id}, Amount: ${ticket.price_cents}`);
        }

        // Void Ticket
        db.prepare(`
            UPDATE tickets 
            SET billing_status = 'void', updated_at = ? 
            WHERE id = ?
        `).run(now, ticket_id);

        // Audit Log (REQ 4)
        db.prepare(`
            INSERT INTO audit_logs (action, admin_user, target_id, reason, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            'void_ticket',
            admin_user || 'system_admin',
            ticket_id,
            reason || 'No reason provided',
            JSON.stringify({ invoice_id: invoiceId, invoice_status: invoiceStatus }),
            now
        );

        return { ticket, invoiceStatus };
    });

    try {
        const result = performVoid();
        const msg = result.invoiceStatus === 'paid'
            ? `Ticket voided. Credit Note issued due to paid invoice.`
            : `Ticket voided. Removed from billing cycle.`;

        res.json({ success: true, message: msg });
    } catch (err) {
        if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Ticket not found' });
        if (err.message === 'ALREADY_VOID') return res.status(400).json({ error: 'Ticket is already voided' });
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`DriverFlow MVP server listening on port ${PORT}`);
});
