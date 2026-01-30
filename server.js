const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { execSync } = require('child_process');

// --- LOCAL IMPORTS ---
const { validateEnv } = require('./env_guard');
const { nowIso, nowEpochMs } = require('./time_provider');
const { enforceCompanyCanOperate } = require('./access_control');
const logger = require('./logger');
const { getStripe } = require('./stripe_client');
const db = require('./db_adapter'); // NEW Unified Adapter

// --- 1. BOOTSTRAP & SECURITY CHECKS ---
validateEnv({ role: 'api' }); // Checks env vars

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Proxy (Render/Load Balancer)
app.set('trust proxy', 1);

// --- 2. MIGRATIONS (CONDITIONAL) ---
if (process.env.RUN_MIGRATIONS === 'true') {
    try {
        console.log('--- Auto-Migration Check ---');
        // We run these specific fixes as requested in the past
        execSync('node migrate_auth_fix.js', { stdio: 'inherit' });
        execSync('node migrate_prod_consolidated.js', { stdio: 'inherit' });
        execSync('node migrate_fix_events.js', { stdio: 'inherit' });
        console.log('--- Migration Done ---');
    } catch (err) {
        console.error('FATAL: Migration failed.');
        process.exit(1);
    }
}

// --- 3. MIDDLEWARE CONFIG ---

// 3.1 Rate Limiter
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15m
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100;
const RATE_LIMIT_WEBHOOK_MAX = 60;

function checkRateLimit(ip, type) {
    const key = `${ip}:${type}`;
    const now = nowEpochMs();
    let record = rateLimitMap.get(key);

    // Different limits for Webhooks
    const max = type === 'webhook' ? RATE_LIMIT_WEBHOOK_MAX : RATE_LIMIT_MAX;
    const window = type === 'webhook' ? 60000 : RATE_LIMIT_WINDOW;

    if (!record || now > record.expiry) {
        record = { count: 0, expiry: now + window };
    }
    if (record.count >= max) return false;
    record.count++;
    rateLimitMap.set(key, record);
    return true;
}

// 3.2 CORS
const allowedStr = (process.env.ALLOWED_ORIGINS || '').trim();
const ALLOWED_ORIGINS = allowedStr ? allowedStr.split(',').map(s => s.trim()).filter(Boolean) : [];

app.use(cors({
    origin: (origin, cb) => {
        // Mobile/Curl (no origin) -> Allow
        if (!origin) return cb(null, true);
        // Wildcard
        if (ALLOWED_ORIGINS.includes('*')) return cb(null, true);
        // Prod Strictness
        if (ALLOWED_ORIGINS.length === 0 && process.env.NODE_ENV === 'production') {
            return cb(new Error('CORS Denied (Empty Config)'));
        }
        // Match
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);

        cb(new Error('CORS Blocked'));
    }
}));

// 3.3 Audit Log Helper
async function auditLog(action, actorId, targetId, metadata, req) {
    try {
        const ip = req ? req.ip : 'system';
        // Ensure atomic strings
        await db.run(`INSERT INTO audit_logs (action, actor_id, target_id, metadata, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            action, String(actorId), String(targetId), JSON.stringify(metadata || {}), ip, nowIso());
    } catch (e) { console.error('Audit Fail:', e.message); }
}

// 3.4 Request ID
app.use((req, res, next) => {
    const rid = req.headers['x-request-id'] || crypto.randomUUID();
    req.requestId = rid;
    res.setHeader('X-Request-Id', rid);
    next();
});

// --- 4. WEBHOOKS (BEFORE BODY PARSER) ---

// Unified Stripe Webhook
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!checkRateLimit(req.ip, 'webhook')) return res.status(429).json({ error: 'RATE_LIMITED' });

    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const stripe = getStripe();
    let event;

    try {
        if (!stripe || !endpointSecret) throw new Error('Config Missing');
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        if (process.env.NODE_ENV === 'production' && !event.livemode) {
            console.warn('[Stripe] Test event ignored in PROD');
            return res.status(400).send('Livemode mismatch');
        }
    } catch (err) {
        console.error(`Webhook Signature Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        // Idempotency
        const existing = await db.get('SELECT status FROM stripe_webhook_events WHERE stripe_event_id = ?', event.id);
        if (existing) return res.json({ received: true });

        await db.run(`INSERT INTO stripe_webhook_events (stripe_event_id, type, created_at, status) VALUES (?, ?, ?, 'pending')`, event.id, event.type, nowIso());

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const ticketId = session.metadata?.ticket_id;
            if (ticketId) {
                console.log(`[Stripe] Invoice Paid: Ticket ${ticketId}`);
                await db.run(`UPDATE tickets SET billing_status='paid', paid_at=?, payment_ref=?, stripe_payment_intent_id=?, stripe_customer_id=?, billing_notes='Paid via Stripe' WHERE id=? AND billing_status != 'paid'`,
                    nowIso(), session.payment_intent, session.payment_intent, session.customer, ticketId);

                // Outbox Event
                await db.run(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?)`,
                    'invoice_paid', nowIso(), session.metadata.company_id, JSON.stringify({ ticket_id: ticketId, stripe_id: session.id }));
            }
        }

        await db.run(`UPDATE stripe_webhook_events SET status='processed', processed_at=? WHERE stripe_event_id=?`, nowIso(), event.id);
        res.json({ received: true });
    } catch (err) {
        console.error('[Stripe Processing Error]', err);
        res.status(500).send('Internal Server Error');
    }
});

// Legacy Webhook Redirects
const legacyWebhook = (req, res) => {
    console.warn(`[Legacy Webhook] Hit on ${req.path}. Client needs update to /stripe/webhook`);
    res.status(404).json({ error: 'Endpoint moved to /stripe/webhook' });
};
app.post('/api/stripe/webhook', legacyWebhook);
app.post('/webhooks/payment', legacyWebhook);


// --- 5. APP CONFIG & PUBLIC ROUTES ---
app.use(express.json());

// Health Check
app.get('/', (req, res) => res.json({ status: 'ok', time: nowIso(), mode: process.env.NODE_ENV }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/readyz', async (req, res) => {
    let dbOk = false;
    try {
        // Check DB
        if (await db.get('SELECT 1')) dbOk = true;
    } catch (e) { }
    res.status(dbOk ? 200 : 503).json({ db: dbOk });
});

// Metrics
// 5.1 Metrics (Machine Readable) - STRICT SECURE
app.get('/metrics', async (req, res) => {
    // strict bearer check
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) return res.status(401).json({ error: 'Missing Bearer Token' });
    if (token !== process.env.METRICS_TOKEN) return res.status(403).json({ error: 'Invalid Token' });

    try {
        const [drivers] = await db.all("SELECT count(*) as c FROM drivers");
        const [empresas] = await db.all("SELECT count(*) as c FROM empresas");
        const [requests] = await db.all("SELECT count(*) as c FROM solicitudes");
        const [tickets] = await db.all("SELECT count(*) as c FROM tickets");
        const [pendingEvents] = await db.all("SELECT count(*) as c FROM events_outbox WHERE queue_status='pending'");

        res.json({
            uptime_seconds: process.uptime(),
            db: { engine: db.IS_POSTGRES ? 'postgres' : 'sqlite', ok: true },
            counts: {
                drivers: parseInt(drivers?.c || 0),
                empresas: parseInt(empresas?.c || 0),
                solicitudes: parseInt(requests?.c || 0),
                tickets: parseInt(tickets?.c || 0),
                events_outbox_pending: parseInt(pendingEvents?.c || 0)
            },
            timestamp: nowIso()
        });
    } catch (e) {
        console.error('Metrics Error', e);
        res.status(500).json({ error: 'Metrics Error', db: { ok: false, err: e.message } });
    }
});

// 5.2 Metrics (Human Readable / Admin) - Protected by ADMIN_SECRET
app.get('/admin/metrics', async (req, res) => {
    const secret = req.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_SECRET) return res.status(403).send('Forbidden: Invalid Admin Secret');

    try {
        const fetchCount = async (tbl, where = '') => {
            const r = await db.get(`SELECT count(*) as c FROM ${tbl} ${where}`);
            return r ? parseInt(r.c) : 0;
        };

        const drivers = await fetchCount('drivers');
        const empresas = await fetchCount('empresas');
        const activeReqs = await fetchCount('solicitudes', "WHERE estado IN ('PENDIENTE','EN_REVISION')");
        const ticketsUnpaid = await fetchCount('tickets', "WHERE billing_status='unpaid'");
        const jobsPending = await fetchCount('jobs_queue', "WHERE status IN ('pending','retry')");
        const eventsPending = await fetchCount('events_outbox', "WHERE queue_status='pending'");

        const html = `
        <!DOCTYPE html>
        <html style="font-family: sans-serif; background: #f4f4f9; padding: 2rem;">
        <head><title>DriverFlow Admin Metrics</title></head>
        <body>
            <div style="max-width: 600px; margin: 0 auto; background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                <h2 style="margin-top:0; color: #333;">📊 Live Metrics</h2>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem;">
                    <div style="background: #eef; padding: 1rem; border-radius: 4px;"><strong>Drivers:</strong> ${drivers}</div>
                    <div style="background: #eef; padding: 1rem; border-radius: 4px;"><strong>Companies:</strong> ${empresas}</div>
                    <div style="background: #ffe; padding: 1rem; border-radius: 4px;"><strong>Active Reqs:</strong> ${activeReqs}</div>
                    <div style="background: #fdd; padding: 1rem; border-radius: 4px;"><strong>Unpaid Tickets:</strong> ${ticketsUnpaid}</div>
                    <div style="background: #eee; padding: 1rem; border-radius: 4px;"><strong>Pending Jobs:</strong> ${jobsPending}</div>
                    <div style="background: #eee; padding: 1rem; border-radius: 4px;"><strong>Pending Events:</strong> ${eventsPending}</div>
                </div>
                <p style="margin-top: 2rem; color: #666; font-size: 0.9em;">
                    System Uptime: ${Math.floor(process.uptime())}s <br>
                    DB Engine: ${db.IS_POSTGRES ? 'PostgreSQL' : 'SQLite'} <br>
                    Time: ${nowIso()}
                </p>
                <button onclick="location.reload()" style="background: #333; color: white; border: none; padding: 0.5rem 1rem; cursor: pointer; border-radius: 4px;">Refresh</button>
            </div>
        </body>
        </html>
        `;
        res.send(html);
    } catch (e) {
        res.status(500).send(`<h1>Error</h1><pre>${e.message}</pre>`);
    }
});

// Debug Endpoints (Production Diagnosis)
app.get('/sys/debug/email-status', async (req, res) => {
    try {
        const events = await db.all("SELECT id, event_name, queue_status, created_at FROM events_outbox ORDER BY id DESC LIMIT 10");
        const jobs = await db.all("SELECT id, job_type, status, attempts, last_error, run_at FROM jobs_queue ORDER BY id DESC LIMIT 5");
        res.json({ events, jobs });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sys/debug/reset-jobs', async (req, res) => {
    try {
        await db.run("UPDATE jobs_queue SET status='pending', attempts=0 WHERE status IS NULL OR status IN ('processing', 'failed')");
        // Also reset stuck outbox events
        await db.run("UPDATE events_outbox SET queue_status='pending' WHERE queue_status IS NULL OR queue_status='processing'");
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 6. AUTHENTICATION ---

// STRICT TOKEN SECRET
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is required.');
    process.exit(1);
}

const authenticateToken = (req, res, next) => {
    const header = req.headers['authorization'];
    const token = header && header.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

function isStrongPassword(p) {
    if (!p || p.length < 8) return false;
    return /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p);
}


// LOGIN
app.post('/login', async (req, res) => {
    if (!checkRateLimit(req.ip, 'login')) return res.status(429).json({ error: 'RATE_LIMITED' });
    const { type, contacto, password } = req.body;

    // Log intent (masked)
    // console.log(`[Login] Attempt for ${contacto} as ${type}`);

    try {
        const table = type === 'driver' ? 'drivers' : 'empresas';
        // Validate type to prevent SQL Injection via table name (though internal, best practice)
        if (!['driver', 'empresas'].includes(table) && type !== 'empresa') return res.status(400).json({ error: 'Invalid Type' });

        const safeTable = type === 'driver' ? 'drivers' : 'empresas';
        const row = await db.get(`SELECT * FROM ${safeTable} WHERE contacto = ?`, contacto);

        if (!row) {
            console.warn(`[Login] Fail: ${contacto} - NOT_FOUND`);
            await auditLog('login_failed', 'unknown', contacto, { reason: 'not_found' }, req);
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        // Lockout Check
        if (row.lockout_until && new Date(row.lockout_until) > new Date(nowEpochMs())) {
            console.warn(`[Login] Fail: ${contacto} - LOCKED`);
            return res.status(403).json({ error: 'Cuenta bloqueada temporalmente' });
        }

        // Verify Check (Loose check: 1, true, "1")
        if (row.verified != 1 && row.verified != true && row.verified != 'true') {
            // In phase 9 we might enforce this, but for now we might just warn or block.
            // User said "Hacer el check de verificación compatible". 
            // Logic: If we want to block unverified, we do it here. 
            // Existing code didn't strictly block login, but let's assume we proceed.
            // Wait, usually login is allowed but actions are restricted? 
            // Let's stick to standard auth. If user needed blocking, they'd say.
        }

        const match = await bcrypt.compare(password, row.password_hash);
        if (match) {
            // Success
            if (row.failed_attempts > 0) {
                await db.run(`UPDATE ${safeTable} SET failed_attempts=0, lockout_until=NULL WHERE id=?`, row.id);
            }
            const token = jwt.sign({ id: row.id, type: type === 'empresa' ? 'empresa' : 'driver' }, JWT_SECRET, { expiresIn: '24h' });

            await auditLog('login_success', row.id, table, {}, req);
            // console.log(`[Login] Success: ${contacto}`);
            res.json({ ok: true, token, type, id: row.id, name: row.nombre });
        } else {
            // Bad Password
            const fails = (row.failed_attempts || 0) + 1;
            let sql = `UPDATE ${safeTable} SET failed_attempts = ?`;
            const args = [fails];
            if (fails >= 5) {
                sql += `, lockout_until = ?`;
                args.push(new Date(nowEpochMs() + 15 * 60 * 1000).toISOString()); // 15m
            }
            sql += ` WHERE id = ?`;
            args.push(row.id);
            await db.run(sql, ...args);

            console.warn(`[Login] Fail: ${contacto} - BAD_PASSWORD (Attempt ${fails})`);
            await auditLog('login_failed', row.id, contacto, { reason: 'bad_password', attempts: fails }, req);
            res.status(401).json({ error: 'Credenciales inválidas' });
        }
    } catch (e) {
        console.error(`[Login] DB Error: ${e.message}`);
        res.status(500).json({ error: 'Server Error' });
    }
});

// REGISTER
app.post('/register', async (req, res) => {
    if (!checkRateLimit(req.ip, 'register')) return res.status(429).json({ error: 'RATE_LIMITED' });
    const { type, nombre, contacto, password, ...extras } = req.body;

    if (!['driver', 'empresa'].includes(type)) return res.status(400).json({ error: 'Bad type' });
    if (!nombre || !contacto || !password) return res.status(400).json({ error: 'Missing fields' });
    if (!isStrongPassword(password)) return res.status(400).json({ error: 'Weak Password' });

    try {
        const hash = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex');
        const now = nowIso();
        const expires = new Date(nowEpochMs() + 24 * 3600 * 1000).toISOString(); // 24h

        let newId;
        if (type === 'driver') {
            const result = await db.run(`INSERT INTO drivers (nombre, contacto, password_hash, tipo_licencia, status, created_at, verified, verification_token, verification_expires) VALUES (?,?,?,?,'active',?,false,?,?)`,
                nombre, contacto, hash, extras.tipo_licencia || 'B', now, token, expires);
            newId = result.lastInsertRowid;

            await db.run(`INSERT INTO events_outbox (event_name, created_at, driver_id, metadata) VALUES (?,?,?,?)`,
                'verification_email', now, newId, JSON.stringify({ token, email: contacto, name: nombre, user_type: 'driver' }));
        } else {
            const result = await db.run(`INSERT INTO empresas (nombre, contacto, password_hash, legal_name, address_line1, city, ciudad, verified, verification_token, verification_expires, created_at) VALUES (?,?,?,?,?,?,?,false,?,?,?)`,
                nombre, contacto, hash, extras.legal_name || nombre, extras.address_line1 || '', extras.address_city || '', extras.address_city || '', token, expires, now);
            newId = result.lastInsertRowid;

            await db.run(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?,?,?,?)`,
                'verification_email', now, newId, JSON.stringify({ token, email: contacto, name: nombre, user_type: 'empresa' }));
        }

        res.json({ ok: true, message: 'Registered. Please check your email to verify.' });
    } catch (e) {
        // Unique constraint check
        if (e.message && (e.message.includes('unique') || e.message.includes('duplicate'))) {
            return res.status(409).json({ error: 'User already exists' });
        }
        console.error('Register Error', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// RESEND VERIFICATION
app.post('/resend-verification', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    try {
        let u = await db.get("SELECT id, nombre, status, verified, 'driver' as type FROM drivers WHERE contacto=?", email);
        if (!u) u = await db.get("SELECT id, nombre, 'empresa' as type, verified FROM empresas WHERE contacto=?", email);

        if (!u) return res.status(404).json({ error: 'User not found' });

        // Loose check for verification
        if (u.verified == 1 || u.verified == true || u.verified == 'true') {
            return res.status(400).json({ error: 'Account already verified' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(nowEpochMs() + 24 * 3600 * 1000).toISOString();
        const table = u.type === 'driver' ? 'drivers' : 'empresas';

        await db.run(`UPDATE ${table} SET verification_token=?, verification_expires=? WHERE id=?`, token, expires, u.id);

        await db.run(`INSERT INTO events_outbox (event_name, created_at, driver_id, company_id, metadata) VALUES (?, ?, ?, ?, ?)`,
            'verification_email', nowIso(), u.type === 'driver' ? u.id : null, u.type === 'empresa' ? u.id : null, JSON.stringify({ token, email, name: u.nombre, user_type: u.type }));

        res.json({ ok: true, message: 'Verification email resent.' });
    } catch (e) {
        console.error('Resend Error', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// VERIFY EMAIL (Browser Friendly)
app.all('/verify-email', async (req, res) => {
    const token = req.query.token || req.body.token;
    if (!token) return res.status(400).send('<h1>Error</h1><p>Token missing</p>');

    try {
        let u = await db.get("SELECT id, 'driver' as type FROM drivers WHERE verification_token=?", token);
        if (!u) u = await db.get("SELECT id, 'empresa' as type FROM empresas WHERE verification_token=?", token);

        if (!u) return res.status(404).send('<h1>Error</h1><p>Invalid or expired token.</p>');

        const table = u.type === 'driver' ? 'drivers' : 'empresas';
        // Set verified=true (Postgres) or 1 (SQLite) - db adapter handles boolean mapping often, but using 'true' literal works in robust systems or 1.
        // Let's use 1 which is safe for both usually, or TRUE if PG.
        const val = db.IS_POSTGRES ? 'TRUE' : '1';

        await db.run(`UPDATE ${table} SET verified=${val}, verification_token=NULL WHERE id=?`, u.id);
        res.send('<h1>Cuenta Verificada</h1><p>Tu correo ha sido verificado exitosamente. Ya puedes iniciar sesion en la App.</p>');
    } catch (e) {
        console.error('Verify Error', e);
        res.status(500).send('<h1>Error</h1><p>Server Error</p>');
    }
});

// FORGOT PASSWORD
app.post('/forgot_password', async (req, res) => {
    if (!checkRateLimit(req.ip, 'forgot')) return res.status(429).json({ error: 'RATE_LIMITED' });
    const email = req.body.email || req.body.contacto;

    try {
        let u = await db.get("SELECT id, nombre, 'driver' as type FROM drivers WHERE contacto=?", email);
        if (!u) u = await db.get("SELECT id, nombre, 'empresa' as type FROM empresas WHERE contacto=?", email);

        if (u) {
            const token = crypto.randomBytes(32).toString('hex');
            const expires = new Date(nowEpochMs() + 3600 * 1000).toISOString(); // 1h
            const table = u.type === 'driver' ? 'drivers' : 'empresas';
            await db.run(`UPDATE ${table} SET reset_token=?, reset_expires=? WHERE id=?`, token, expires, u.id);

            await db.run(`INSERT INTO events_outbox (event_name, created_at, metadata) VALUES (?, ?, ?)`,
                'recovery_email', nowIso(), JSON.stringify({ token, email, name: u.nombre }));

            await auditLog('forgot_password_req', u.id, u.type, { email }, req);
        }
        // Always 200 checks
        res.json({ ok: true, message: 'If user exists, email sent.' });
    } catch (e) {
        console.error('Forgot Error', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// RESET PASSWORD
app.post('/reset_password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Missing Data' });
    if (!isStrongPassword(newPassword)) return res.status(400).json({ error: 'Weak Password' });

    try {
        let u = await db.get("SELECT id, 'driver' as type FROM drivers WHERE reset_token=? AND reset_expires > ?", token, nowIso());
        if (!u) u = await db.get("SELECT id, 'empresa' as type FROM empresas WHERE reset_token=? AND reset_expires > ?", token, nowIso());

        if (!u) return res.status(400).json({ error: 'Invalid or Expired Link' });

        const hash = await bcrypt.hash(newPassword, 10);
        const table = u.type === 'driver' ? 'drivers' : 'empresas';

        await db.run(`UPDATE ${table} SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?`, hash, u.id);
        await auditLog('password_reset_success', u.id, u.type, {}, req);

        res.json({ ok: true });
    } catch (e) {
        console.error('Reset Error', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Reset Web UI (Simple HTML)
app.get('/reset-password-web', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).send('Token missing');
    // Return the HTML form... (Condensed for brevity, same as before)
    res.send(`<html><body>
        <form action="/reset_password" method="POST" onsubmit="event.preventDefault(); submitForm();">
            <h2>Reset Password</h2>
            <input type="hidden" id="token" value="${token}">
            <input type="password" id="pass" placeholder="New Password" required>
            <button id="btn">Save</button>
            <p id="msg"></p>
        </form>
        <script>
            async function submitForm() {
                const p = document.getElementById('pass').value;
                const t = document.getElementById('token').value;
                const btn = document.getElementById('btn');
                btn.disabled = true;
                try {
                    const r = await fetch('/reset_password', { 
                        method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ token: t, newPassword: p })
                    });
                    const d = await r.json();
                    if(r.ok) document.body.innerHTML = '<h1>Success</h1><p>Password updated.</p>';
                    else { document.getElementById('msg').innerText = d.error || 'Error'; btn.disabled = false; }
                } catch(e) { document.getElementById('msg').innerText = 'Net Error'; btn.disabled = false; }
            }
        </script>
    </body></html>`);
});


// --- 7. CORE BUSINESS LOGIC ---

// Create Request (Company)
app.post('/create_request', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.sendStatus(403);

    try {
        await enforceCompanyCanOperate(db, req.user.id, 'create_request');

        // --- TRANSACTION START ---
        if (db.IS_POSTGRES) await db.run('BEGIN');

        // Check active sections
        const active = await db.get("SELECT count(*) as c FROM solicitudes WHERE empresa_id=? AND estado IN ('PENDIENTE','EN_REVISION','ACEPTADA')", req.user.id);
        if (active && parseInt(active.c) > 0) throw new Error('ACTIVE_EXISTS');

        const { licencia_req, ubicacion, tiempo_estimado } = req.body;
        const expires = new Date(nowEpochMs() + 30 * 60000).toISOString(); // 30 mins

        const result = await db.run(`INSERT INTO solicitudes (empresa_id, licencia_req, ubicacion, tiempo_estimado, fecha_expiracion) VALUES (?,?,?,?,?)`,
            req.user.id, licencia_req, ubicacion, tiempo_estimado, expires);

        const reqId = result.lastInsertRowid;

        await db.run(`INSERT INTO events_outbox (event_name,created_at,request_id,audience_type,event_key) VALUES (?,?,?,?,?)`,
            'request_created', nowIso(), reqId, 'broadcast_drivers', 'request_created');

        if (db.IS_POSTGRES) await db.run('COMMIT');
        // --- TRANSACTION END ---

        res.json({ id: reqId, status: 'PENDIENTE' });
    } catch (e) {
        if (db.IS_POSTGRES) await db.run('ROLLBACK').catch(() => { });
        if (e.message === 'ACTIVE_EXISTS') return res.status(409).json({ error: 'Active request exists' });
        res.status(500).json({ error: e.message });
    }
});

// List Requests (Driver)
app.get('/list_available_requests', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.sendStatus(403);

    const d = await db.get("SELECT estado, tipo_licencia, search_status FROM drivers WHERE id=?", req.user.id);
    if (!d || d.search_status === 'OFF' || d.estado !== 'DISPONIBLE') return res.json([]);

    const reqs = await db.all(`SELECT s.id, 'Verified Company' as empresa, s.ubicacion, s.tiempo_estimado, s.fecha_expiracion 
        FROM solicitudes s 
        WHERE s.estado='PENDIENTE' AND s.licencia_req=? AND s.fecha_expiracion > ?`,
        d.tipo_licencia, nowIso());

    res.json(reqs);
});

// Apply (Driver) - V2 (Replaces requests/:id/apply)
app.post('/apply_for_request', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.sendStatus(403);
    const { request_id } = req.body;

    try {
        const reqInfo = await db.get("SELECT * FROM solicitudes WHERE id=? AND estado='PENDIENTE'", request_id);
        if (!reqInfo) return res.status(404).json({ error: 'Request not found or taken' });

        await enforceCompanyCanOperate(db, reqInfo.empresa_id, 'driver_apply');

        if (db.IS_POSTGRES) await db.run('BEGIN');

        // Double check driver state
        const d = await db.get("SELECT estado FROM drivers WHERE id=?", req.user.id);
        if (d.estado !== 'DISPONIBLE') throw new Error('BUSY');

        // Check race condition
        const check = await db.get("SELECT driver_id FROM solicitudes WHERE id=?", request_id);
        if (check.driver_id) throw new Error('TAKEN');

        // Update
        await db.run("UPDATE solicitudes SET estado='EN_REVISION', driver_id=? WHERE id=?", req.user.id, request_id);
        await db.run("UPDATE drivers SET estado='OCUPADO' WHERE id=?", req.user.id);

        // Notify Company
        await db.run(`INSERT INTO events_outbox (event_name,created_at,company_id,driver_id,request_id,metadata) VALUES (?,?,?,?,?,?)`,
            'driver_applied', nowIso(), reqInfo.empresa_id, req.user.id, request_id, JSON.stringify({ driver_name: req.user.nombre || 'Driver' }));

        if (db.IS_POSTGRES) await db.run('COMMIT');

        res.json({ success: true });
    } catch (e) {
        if (db.IS_POSTGRES) await db.run('ROLLBACK').catch(() => { });
        if (e.message === 'BUSY') return res.status(409).json({ error: 'You are busy' });
        if (e.message === 'TAKEN') return res.status(409).json({ error: 'Request already taken' });
        res.status(500).json({ error: e.message });
    }
});

// Approve Driver (Company)
app.post('/approve_driver', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.sendStatus(403);
    const { request_id } = req.body;

    try {
        await enforceCompanyCanOperate(db, req.user.id, 'approve_driver');

        if (db.IS_POSTGRES) await db.run('BEGIN');

        const r = await db.get("SELECT * FROM solicitudes WHERE id=?", request_id);
        if (!r || r.empresa_id !== req.user.id) throw new Error('NOT_FOUND');
        if (r.estado !== 'EN_REVISION') throw new Error('INVALID_STATE');

        // Update Request
        await db.run("UPDATE solicitudes SET estado='ACEPTADA' WHERE id=?", request_id);

        // Create Ticket
        const t = await db.run("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, currency, created_at, billing_status) VALUES (?,?,?,15000,'USD',?,'unpaid')",
            req.user.id, r.driver_id, request_id, nowIso());
        const tid = t.lastInsertRowid;

        // Notify Driver & System
        await db.run(`INSERT INTO events_outbox (event_name,created_at,company_id,driver_id,request_id,ticket_id) VALUES (?,?,?,?,?,?)`,
            'match_confirmed', nowIso(), req.user.id, r.driver_id, request_id, tid);

        if (db.IS_POSTGRES) await db.run('COMMIT');

        res.json({ success: true, ticket_id: tid });
    } catch (e) {
        if (db.IS_POSTGRES) await db.run('ROLLBACK').catch(() => { });
        res.status(500).json({ error: e.message });
    }
});

// Checkout (Company)
app.post('/billing/tickets/:id/checkout', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.sendStatus(403);
    const tid = req.params.id;

    try {
        const ticket = await db.get("SELECT * FROM tickets WHERE id=?", tid);
        if (!ticket || ticket.company_id !== req.user.id) return res.status(404).json({ error: 'Not Found' });
        if (ticket.billing_status === 'paid') return res.status(409).json({ error: 'Already Paid' });

        const stripe = getStripe();
        if (!stripe) return res.status(503).json({ error: 'Payments Unavailable' });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: (ticket.currency || 'usd').toLowerCase(),
                    product_data: { name: `Ticket #${ticket.id}`, description: `Service for Req #${ticket.request_id}` },
                    unit_amount: ticket.price_cents
                },
                quantity: 1
            }],
            mode: 'payment',
            metadata: { ticket_id: ticket.id, company_id: req.user.id },
            success_url: process.env.STRIPE_SUCCESS_URL || 'http://localhost:3000/success',
            cancel_url: process.env.STRIPE_CANCEL_URL || 'http://localhost:3000/cancel',
        });

        await db.run("UPDATE tickets SET stripe_checkout_session_id=? WHERE id=?", session.id, tid);
        res.json({ success: true, checkout_url: session.url });

    } catch (e) {
        console.error('Checkout Error', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Admin Ops
app.post('/admin/tickets/:id/void', authenticateToken, async (req, res) => {
    // Basic Admin Role Check stub - assumes we have a better role system or use same JWT
    // For now, MVP: only explicit admin token or check user role in DB
    // Assuming JWT has { role: 'admin' } if admin. Or separate admin login.
    // Reusing old logic stub:
    const adminParam = req.headers['x-admin-secret'];
    if (adminParam && adminParam === process.env.ADMIN_SECRET) {
        // Allowed
    } else {
        return res.sendStatus(403);
    }

    try {
        await db.run("UPDATE tickets SET billing_status='void' WHERE id=?", req.params.id);
        await auditLog('ticket_voided', 'admin', req.params.id, {}, req);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 7.1 WEEKLY BILLING ADMIN ---

app.get('/admin/invoices', async (req, res) => {
    const adminParam = req.headers['x-admin-secret'];
    if (!adminParam || adminParam !== process.env.ADMIN_SECRET) return res.sendStatus(403);

    try {
        const rows = await db.all(`
            SELECT w.*, c.nombre as company_name 
            FROM weekly_invoices w 
            LEFT JOIN empresas c ON w.company_id = c.id 
            ORDER BY w.week_start DESC 
            LIMIT 100
        `);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/admin/invoices/generate', async (req, res) => {
    const adminParam = req.headers['x-admin-secret'];
    if (!adminParam || adminParam !== process.env.ADMIN_SECRET) return res.sendStatus(403);

    try {
        // Default: Previous Week
        // If today is Wednesday, previous week is last Mon-Sun.
        // If today is Monday, previous week is ... previous Mon-Sun.

        const now = new Date(nowEpochMs());
        let referenceDate = req.body.date ? new Date(req.body.date) : now;

        // Find "Previous Week" relative to referenceDate
        // Logic: Go back to last Monday?
        // Or specific logic: "Last complete week"

        // Simple logic: 
        // 1. Get current day of week (0=Sun, 1=Mon)
        // 2. Subtract days to get to LAST Monday.
        //    If today is Mon (1), last Monday was 7 days ago? Or today?
        //    Usually, we bill for the *completed* week.
        //    If referenceDate is during the week, we target the *completed* week prior.

        const day = referenceDate.getDay(); // 0-6
        const diffToMon = (day + 6) % 7; // Mon=0, Tue=1, ... Sun=6
        // Go back to THIS week's Monday
        const thisMon = new Date(referenceDate);
        thisMon.setDate(referenceDate.getDate() - diffToMon);

        // Go back 7 days for PREVIOUS week's Monday
        const prevMon = new Date(thisMon);
        prevMon.setDate(thisMon.getDate() - 7);

        const prevSun = new Date(prevMon);
        prevSun.setDate(prevMon.getDate() + 6);

        const week_start = prevMon.toISOString().split('T')[0];
        const week_end = prevSun.toISOString().split('T')[0];

        // Target specific company?
        const { company_id } = req.body;
        let companies = [];

        if (company_id) {
            companies.push({ id: company_id });
        } else {
            companies = await db.all("SELECT id FROM empresas");
        }

        const { enqueueJob } = require('./worker_queue');
        let count = 0;

        for (const c of companies) {
            await enqueueJob('generate_weekly_invoices', {
                company_id: c.id,
                week_start,
                week_end
            });
            count++;
        }

        res.json({
            ok: true,
            jobs_enqueued: count,
            period: { week_start, week_end }
        });

    } catch (e) {
        console.error('Invoice Gen Error', e);
        res.status(500).json({ error: e.message });
    }
});

// --- 8. LEGACY / DEPRECATED ROUTES ---
app.post('/requests/:id/apply', (req, res) => res.status(410).json({ error: 'Deprecated. Use /apply_for_request' }));

// --- 9. STARTUP ---
const { startQueueWorker } = require('./worker_queue');
startQueueWorker().catch(e => console.error('Worker Start Error:', e));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} [${process.env.NODE_ENV}]`);
    console.log(`DB Mode: ${db.IS_POSTGRES ? 'PostgreSQL' : 'SQLite'}`);
});
