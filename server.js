require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const multer = require('multer');
const leadUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
        execSync('node migrate_company_requirements.js', { stdio: 'inherit' });
        execSync('node migrate_driver_profile.js', { stdio: 'inherit' });
        execSync('node migrate_fix_profile_columns.js', { stdio: 'inherit' });
        execSync('node migrate_availability.js', { stdio: 'inherit' });
        execSync('node migrate_matches_consent.js', { stdio: 'inherit' });
        execSync('node migrate_ticket_match_unique.js', { stdio: 'inherit' });
        execSync('node migrate_ticket_payment.js', { stdio: 'inherit' });
        execSync('node migrate_matches_index.js', { stdio: 'inherit' });
        execSync('node migrate_matches_query_indexes.js', { stdio: 'inherit' });
        execSync('node migrate_lazy_matching.js', { stdio: 'inherit' });
        execSync('node migrate_candidate_pool.js', { stdio: 'inherit' });
        execSync('node migrate_candidate_pool_gin.js', { stdio: 'inherit' });
        execSync('node migrate_match_retention.js', { stdio: 'inherit' });
        execSync('node migrate_otr_eligibility.js', { stdio: 'inherit' });
        execSync('node migrate_normalize_preferences.js', { stdio: 'inherit' });
        execSync('node migrate_driver_leads.js', { stdio: 'inherit' });
        execSync('node migrate_lead_invitations.js', { stdio: 'inherit' });
        execSync('node migrate_lead_source.js', { stdio: 'inherit' });
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
    res.setHeader('X-App-Version', '1.3.1-fix-json');
    next();
});

console.log("[SERVER] Starting Version: 1.3.1-fix-json");

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
        // 1. Safe insertion mapped as lock (PostgreSQL ON CONFLICT)
        try {
            await db.run(
                `INSERT INTO stripe_webhook_events (stripe_event_id, type, created_at, status) VALUES ($1, $2, CURRENT_TIMESTAMP, 'pending')`,
                event.id, event.type
            );
        } catch (err) {
            // Error code 23505 in PostgreSQL represents a unique_violation. Event is duplicate.
            if (err.code === '23505' || err.message.includes('UNIQUE')) {
                return res.json({ received: true });
            }
            throw err;
        }

        // 3. Invoice Payment Interception
        if (event.type === 'payment_intent.succeeded') {
            const paymentIntent = event.data.object;
            const invoiceId = paymentIntent.metadata?.invoice_id || null;
            const piId = paymentIntent.id;

            let chargeId = null;
            let receiptUrl = null;

            // Deep charge resolution (Expansion safety fallback)
            if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object') {
                chargeId = paymentIntent.latest_charge.id;
                receiptUrl = paymentIntent.latest_charge.receipt_url;
            } else if (typeof paymentIntent.latest_charge === 'string') {
                chargeId = paymentIntent.latest_charge;
                try {
                    const chargeData = await stripe.charges.retrieve(chargeId);
                    receiptUrl = chargeData.receipt_url;
                } catch (e) {
                    console.error(`[Webhook] Fetch charge failed for PI ${piId}`);
                }
            }

            if (invoiceId) {
                // Direct Reconciliation (Worker Originated)
                await db.run(`
                    UPDATE weekly_invoices 
                    SET status='charged', stripe_payment_intent_id=$1, stripe_charge_id=$2, receipt_url=$3, paid_at=$4, updated_at=$5 
                    WHERE id=$6 AND status != 'charged'
                `, piId, chargeId, receiptUrl, nowIso(), nowIso(), invoiceId);
                console.log(`[Stripe Webhook] Reconciled PAID via metadata ID: ${invoiceId}`);

            } else {
                // Inverse Reconciliation (Out-of-band manual dashboard capture)
                await db.run(`
                    UPDATE weekly_invoices 
                    SET status='charged', stripe_charge_id=$1, receipt_url=$2, paid_at=$3, updated_at=$4 
                    WHERE stripe_payment_intent_id=$5 AND status != 'charged'
                `, chargeId, receiptUrl, nowIso(), nowIso(), piId);
                console.log(`[Stripe Webhook] Reconciled PAID via Inverse PI Match: ${piId}`);
            }
        }

        // 4. Ticket Checkout Reconciliation
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const ticketId = session.metadata?.ticket_id || session.client_reference_id;
            if (ticketId) {
                // Load ticket from DB for amount validation
                const ticket = await db.get('SELECT id, price_cents, currency FROM tickets WHERE id = ?', ticketId);
                if (!ticket) {
                    console.error(`[Stripe Webhook] Ticket #${ticketId} NOT FOUND in DB. Skipping.`);
                } else if (session.amount_total !== ticket.price_cents) {
                    console.error(`[Stripe Webhook] ❌ AMOUNT MISMATCH for Ticket #${ticketId}: Stripe=${session.amount_total}, DB=${ticket.price_cents}. NOT marking as paid.`);
                } else if (session.currency && ticket.currency && session.currency.toLowerCase() !== ticket.currency.toLowerCase()) {
                    console.error(`[Stripe Webhook] ❌ CURRENCY MISMATCH for Ticket #${ticketId}: Stripe=${session.currency}, DB=${ticket.currency}. NOT marking as paid.`);
                } else {
                    const piId = session.payment_intent || null;
                    const customerId = session.customer || null;
                    await db.run(
                        `UPDATE tickets SET billing_status='paid', paid_at=?, stripe_payment_intent_id=?, stripe_customer_id=? WHERE id=? AND billing_status <> 'paid'`,
                        nowIso(), piId, customerId, ticketId
                    );
                    console.log(`[Stripe Webhook] ✅ Ticket #${ticketId} marked PAID (PI: ${piId}, amount: ${session.amount_total})`);
                }
            }
        }

        // Complete Event Lock
        await db.run(`UPDATE stripe_webhook_events SET status='processed', processed_at=CURRENT_TIMESTAMP WHERE stripe_event_id=$1`, event.id);
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
    if (!token) {
        console.warn(`[Auth] Missing Token. Authorization header present: ${!!header}`);
        return res.status(401).json({ error: 'Unauthorized', reason: 'MissingToken' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.warn(`[Auth] JWT Verify Failed - Name: ${err.name}, Message: ${err.message}. Auth header present: ${!!header}`);
            return res.status(403).json({ error: 'Forbidden', reason: err.name || 'InvalidToken' });
        }

        user.type = user.type || user.tipo;

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
    console.log('LOGIN_ROUTE_VERSION_2_ACTIVE');

    const type = (req.body.type || '').toString().trim().toLowerCase();
    const contacto = (req.body.contacto || '').toString().trim().toLowerCase();
    const password = (req.body.password || '').toString();

    if (!['driver', 'empresa'].includes(type)) {
        return res.status(400).json({ error: 'Invalid Type' });
    }

    if (!contacto || !password) {
        return res.status(400).json({ error: 'Missing Data' });
    }

    const table = type === 'driver' ? 'drivers' : 'empresas';

    try {
        // ORDER BY id ASC: when duplicate emails exist, always use the oldest (canonical) account.
        // Without ORDER BY, Postgres returns non-deterministic rows which causes company_id mismatch.
        const rows = await db.all(`SELECT * FROM ${table} WHERE LOWER(contacto) = LOWER(?) ORDER BY id ASC`, contacto);
        if (rows.length > 1) {
            console.warn(`[Login] WARNING: ${rows.length} duplicate accounts for contacto="${contacto}" in ${table}. Using id=${rows[0].id} (oldest).`);
        }
        const row = rows.length > 0 ? rows[0] : null;

        if (!row) {
            console.warn(`[Login] Fail: ${contacto} - NOT_FOUND`);
            await auditLog('login_failed', 'unknown', contacto, { reason: 'not_found' }, req);
            return res.status(401).json({ error: 'Invalid credentials' });
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
                await db.run(`UPDATE ${table} SET failed_attempts=0, lockout_until=NULL WHERE id=?`, row.id);
            }
            const token = jwt.sign({ id: row.id, type: type === 'empresa' ? 'empresa' : 'driver' }, JWT_SECRET, { expiresIn: '24h' });

            await auditLog('login_success', row.id, table, {}, req);

            // Auto-claim lead on driver login
            if (type === 'driver') {
                try { await claimLeadForDriver(row.id, row.contacto, null); } catch (ce) { console.error('[LeadClaim] login error:', ce.message); }
            }

            res.json({ ok: true, token, type, id: row.id, name: row.nombre, search_status: row.search_status || 'ON' });
        } else {
            // Bad Password
            const fails = (row.failed_attempts || 0) + 1;
            let sql = `UPDATE ${table} SET failed_attempts = ?`;
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
    const { type, nombre, password, ...extras } = req.body;
    const contacto = (req.body.contacto || '').toString().trim().toLowerCase();

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

            // Auto-claim lead if driver email matches
            try { await claimLeadForDriver(newId, contacto, null); } catch (ce) { console.error('[LeadClaim] register error:', ce.message); }

            await db.run(`INSERT INTO events_outbox (request_id, event_name, created_at, driver_id, metadata) VALUES (?,?,?,?,?)`,
                req.requestId || 'system', 'verification_email', now, newId, JSON.stringify({ token, email: contacto, name: nombre, user_type: 'driver' }));
        } else {
            const result = await db.run(`INSERT INTO empresas (nombre, contacto, password_hash, legal_name, address_line1, city, ciudad, verified, verification_token, verification_expires, created_at) VALUES (?,?,?,?,?,?,?,false,?,?,?)`,
                nombre, contacto, hash, extras.legal_name || nombre, extras.address_line1 || '', extras.address_city || '', extras.address_city || '', token, expires, now);
            newId = result.lastInsertRowid;

            await db.run(`INSERT INTO events_outbox (request_id, event_name, created_at, company_id, metadata) VALUES (?,?,?,?,?)`,
                req.requestId || 'system', 'verification_email', now, newId, JSON.stringify({ token, email: contacto, name: nombre, user_type: 'empresa' }));
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

// Removed duplicate search_status endpoint here; true implementation is at line 1262.// Reset Web UI (Simple HTML)
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
        const ticket = await db.get("SELECT * FROM tickets WHERE id=? AND company_id=?", tid, req.user.id);
        if (!ticket) return res.status(404).json({ error: 'Not Found' });
        if (ticket.billing_status === 'paid') return res.status(409).json({ error: 'Already Paid' });

        const stripe = getStripe();
        if (!stripe) return res.status(503).json({ error: 'Payments Unavailable' });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: (ticket.currency || 'usd').toLowerCase(),
                    product_data: { name: `Ticket #${ticket.id}`, description: `Match #${ticket.match_id}` },
                    unit_amount: ticket.price_cents
                },
                quantity: 1
            }],
            mode: 'payment',
            client_reference_id: String(ticket.id),
            metadata: { ticket_id: String(ticket.id), company_id: String(req.user.id), match_id: String(ticket.match_id) },
            payment_intent_data: {
                metadata: { ticket_id: String(ticket.id), company_id: String(req.user.id), match_id: String(ticket.match_id) }
            },
            success_url: process.env.STRIPE_SUCCESS_URL || 'http://localhost:3000/success',
            cancel_url: process.env.STRIPE_CANCEL_URL || 'http://localhost:3000/cancel',
        });

        await db.run(
            "UPDATE tickets SET stripe_checkout_session_id=?, billing_status='checkout_created' WHERE id=? AND billing_status <> 'paid'",
            session.id, tid
        );
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

// Retry Invoice Charge
app.post('/admin/invoices/:id/retry', async (req, res) => {
    const adminParam = req.headers['x-admin-secret'];
    if (!adminParam || adminParam !== process.env.ADMIN_SECRET) return res.sendStatus(403);

    const invoiceId = req.params.id;

    try {
        const invoice = await db.get("SELECT * FROM weekly_invoices WHERE id = ?", invoiceId);
        if (!invoice) return res.status(404).json({ error: 'Not Found' });

        if (['charged', 'charging', 'suspended'].includes(invoice.status)) {
            return res.status(400).json({ error: `Cannot retry invoice in status: ${invoice.status}` });
        }

        // Set to retrying and reset next_retry_at to now for immediate pickup by Dunning loop or direct queue
        await db.run("UPDATE weekly_invoices SET status='retrying', failure_reason=NULL, next_retry_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), invoiceId);

        const { enqueueJob } = require('./worker_queue');
        await enqueueJob('charge_weekly_invoice', { invoice_id: invoiceId });

        await auditLog('invoice_retry_manual', 'admin', invoiceId, {}, req);

        res.json({ ok: true, message: 'Retry enqueued' });

    } catch (e) {
        console.error('Retry Error', e);
        res.status(500).json({ error: e.message });
    }
});

// Suspend Invoice (Admin)
app.post('/admin/invoices/:id/suspend', async (req, res) => {
    const adminParam = req.headers['x-admin-secret'];
    if (!adminParam || adminParam !== process.env.ADMIN_SECRET) return res.sendStatus(403);

    const invoiceId = req.params.id;

    try {
        const invoice = await db.get("SELECT * FROM weekly_invoices WHERE id = ?", invoiceId);
        if (!invoice) return res.status(404).json({ error: 'Not Found' });

        if (invoice.status === 'charged') return res.status(400).json({ error: 'Cannot suspend a charged invoice' });

        await db.run("UPDATE weekly_invoices SET status='suspended', suspended_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), invoiceId);
        await auditLog('invoice_suspended_manual', 'admin', invoiceId, {}, req);

        res.json({ ok: true, message: 'Invoice suspended manually' });
    } catch (e) {
        console.error('Suspend Error', e);
        res.status(500).json({ error: e.message });
    }
});

// Unsuspend Invoice (Admin)
app.post('/admin/invoices/:id/unsuspend', async (req, res) => {
    const adminParam = req.headers['x-admin-secret'];
    if (!adminParam || adminParam !== process.env.ADMIN_SECRET) return res.sendStatus(403);

    const invoiceId = req.params.id;

    try {
        const invoice = await db.get("SELECT * FROM weekly_invoices WHERE id = ?", invoiceId);
        if (!invoice) return res.status(404).json({ error: 'Not Found' });

        if (invoice.status !== 'suspended') return res.status(400).json({ error: `Invoice is not suspended (Status: ${invoice.status})` });

        // Set to failed/retrying with next_retry_at to NOW() so Dunning loop can pick it up
        await db.run("UPDATE weekly_invoices SET status='retrying', suspended_at=NULL, next_retry_at=?, attempt_count=0, updated_at=? WHERE id=?", nowIso(), nowIso(), invoiceId);

        // Also enqueue it immediately just in case
        const { enqueueJob } = require('./worker_queue');
        await enqueueJob('charge_weekly_invoice', { invoice_id: invoiceId });

        await auditLog('invoice_unsuspended_manual', 'admin', invoiceId, {}, req);

        res.json({ ok: true, message: 'Invoice unsuspended and queued for retry' });
    } catch (e) {
        console.error('Unsuspend Error', e);
        res.status(500).json({ error: e.message });
    }
});

// Debug JWT (Admin)
app.post('/admin/debug/jwt', (req, res) => {
    const adminParam = req.headers['x-admin-secret'];
    if (!adminParam || adminParam !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden: Invalid Admin Secret' });

    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing token in body' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ ok: false, error: err.name, message: err.message });
        }
        res.json({ ok: true, decoded });
    });
});

// POST /admin/import-leads — Bulk CSV lead import (admin only)
// Supports: JSON body { company_id, csv } OR multipart/form-data { company_id, file }

function parseCsvText(csvText) {
    const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV must have header + at least 1 row');

    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const nameIdx = headers.indexOf('name');
    const emailIdx = headers.indexOf('email');
    const phoneIdx = headers.indexOf('phone');
    const notesIdx = headers.indexOf('notes');

    if (nameIdx === -1 && emailIdx === -1) throw new Error('CSV must have at least "name" or "email" column');

    const records = [];
    for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const name = nameIdx >= 0 ? (vals[nameIdx] || '').trim() : '';
        const email = emailIdx >= 0 ? (vals[emailIdx] || '').trim().toLowerCase() : null;
        const phone = phoneIdx >= 0 ? (vals[phoneIdx] || '').trim() : null;
        const notes = notesIdx >= 0 ? (vals[notesIdx] || '').trim() : null;

        if (!name && !email && !phone) continue;
        records.push({ name, email: email || null, phone: phone || null, notes: notes || null });
    }
    return records;
}

async function importLeadsFromRows(companyId, records) {
    const BATCH_SIZE = 100;
    let inserted = 0, skipped = 0;

    for (let b = 0; b < records.length; b += BATCH_SIZE) {
        const batch = records.slice(b, b + BATCH_SIZE);
        console.log(`[LeadImporter] importing batch ${Math.floor(b / BATCH_SIZE) + 1} (${batch.length} rows)`);

        for (const rec of batch) {
            try {
                await db.run(
                    `INSERT INTO driver_leads (company_id, name, phone, email, notes, status, source, is_synthetic)
                     VALUES (?, ?, ?, ?, ?, 'NEW', 'csv_import', false) ON CONFLICT DO NOTHING`,
                    companyId, rec.name, rec.phone, rec.email, rec.notes
                );
                inserted++;
            } catch (e) {
                skipped++;
                if (!(e.code === '23505' || (e.message && e.message.includes('duplicate')))) {
                    console.error('[LeadImporter] Row error:', e.message);
                }
            }
        }
    }

    console.log(`[LeadImporter] Done: inserted=${inserted} skipped=${skipped} total=${records.length}`);
    return { inserted, skipped, total: records.length };
}

app.post('/admin/import-leads', leadUpload.single('file'), async (req, res) => {
    const adminParam = req.headers['x-admin-secret'];
    if (!adminParam || adminParam !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

    try {
        let companyId, records, source;

        if (req.file) {
            // Multipart/form-data mode
            source = 'multipart';
            companyId = req.body.company_id;
            if (!companyId) return res.status(400).json({ error: 'Missing company_id field' });

            const csvText = req.file.buffer.toString('utf-8');
            console.log(`[LeadImporter] Upload received: ${req.file.originalname} (${req.file.size} bytes)`);
            records = parseCsvText(csvText);
            console.log(`[LeadImporter] Parsed file rows=${records.length}`);
        } else {
            // JSON body mode (backward compatible)
            source = 'json';
            companyId = req.body.company_id;
            const csv = req.body.csv;
            if (!companyId) return res.status(400).json({ error: 'Missing company_id' });
            if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'Missing csv string in body' });

            records = parseCsvText(csv);
            console.log(`[LeadImporter] Parsed ${records.length} records for company_id=${companyId}`);
        }

        const result = await importLeadsFromRows(companyId, records);
        res.json({ ok: true, ...result, source });
    } catch (e) {
        console.error('[LeadImporter] Fatal error:', e);
        res.status(500).json({ error: 'Import failed', message: e.message });
    }
});

// --- 7.2 BILLING (CLIENT DASHBOARD) ---
app.get('/api/billing/invoices/me', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    try {
        let limit = parseInt(req.query.limit) || 20;
        if (limit > 100) limit = 100;
        const offset = parseInt(req.query.offset) || 0;

        const rows = await db.all(`
            SELECT id, week_start, week_end, amount_cents, currency, status, created_at, updated_at, stripe_payment_intent_id, receipt_url 
            FROM weekly_invoices 
            WHERE company_id=? 
            ORDER BY week_start DESC 
            LIMIT ? OFFSET ?
        `, req.user.id, limit, offset);
        res.json(rows || []);
    } catch (e) {
        console.error('Invoices List Error', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/billing/invoices/:id', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    try {
        const inv = await db.get(`
            SELECT id, week_start, week_end, total_requests, active_drivers, amount_cents, currency, status, created_at, updated_at, stripe_payment_intent_id, receipt_url 
            FROM weekly_invoices 
            WHERE id=? AND company_id=?
        `, req.params.id, req.user.id);

        if (!inv) return res.status(404).json({ error: 'Not Found' });
        res.json(inv);
    } catch (e) {
        console.error('Invoice Detail Error', e);
        res.status(500).json({ error: e.message });
    }
});

// Checkout for Weekly Invoice (Escape Hatch / Manual Payment)
app.post('/api/billing/invoices/:id/checkout', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    const invId = req.params.id;

    try {
        const invoice = await db.get(`
            SELECT w.*, c.stripe_customer_id 
            FROM weekly_invoices w 
            JOIN empresas c ON w.company_id = c.id 
            WHERE w.id=? AND w.company_id=?
        `, invId, req.user.id);

        if (!invoice) return res.status(404).json({ error: 'Invoice Not Found' });

        // Allowed statuses for manual checkout
        const allowedStatuses = ['pending', 'failed', 'retrying', 'suspended'];
        if (!allowedStatuses.includes(invoice.status)) {
            return res.status(409).json({ error: `Checkout not allowed for status: ${invoice.status}` });
        }

        if (invoice.amount_cents <= 0) {
            return res.status(400).json({ error: 'Invoice has no amount to pay' });
        }

        const stripe = getStripe();
        if (!stripe) return res.status(503).json({ error: 'Stripe Unavailable' });

        // Idempotency: avoid creating too many sessions for the same attempt
        const idempotencyKey = `inv_checkout_${invoice.id}_${invoice.status}_${req.user.id}`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer: invoice.stripe_customer_id || undefined,
            line_items: [{
                price_data: {
                    currency: (invoice.currency || 'usd').toLowerCase(),
                    product_data: {
                        name: `Weekly Invoice (${invoice.week_start} - ${invoice.week_end})`,
                        description: `Usage for Company #${invoice.company_id}`
                    },
                    unit_amount: invoice.amount_cents
                },
                quantity: 1
            }],
            mode: 'payment',
            metadata: {
                invoice_id: invoice.id,
                company_id: req.user.id,
                type: 'weekly_invoice'
            },
            success_url: process.env.STRIPE_SUCCESS_URL || 'https://driverflow.app/billing/success',
            cancel_url: process.env.STRIPE_CANCEL_URL || 'https://driverflow.app/billing/cancel',
        }, { idempotencyKey });

        // Save reference for tracking
        await db.run("UPDATE weekly_invoices SET stripe_checkout_session_id=?, updated_at=? WHERE id=?",
            session.id, nowIso(), invoice.id);

        res.json({ ok: true, url: session.url, session_id: session.id });

    } catch (e) {
        console.error('Invoice Checkout Error', e);
        res.status(500).json({ error: e.message });
    }
});


// --- COMPANY REQUIREMENTS ---
const getCompanyRequirements = async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies can access' });

    try {
        const row = await db.get("SELECT * FROM company_requirements WHERE company_id = ?", req.user.id);

        const defaults = {
            req_cdl: true,
            req_license_types: [],
            req_endorsements: [],
            req_operation_types: [],
            req_modalities: [],
            req_truck: false,
            offered_payment_methods: [],
            req_relationships: [],
            availability: 'Inmediata',
            req_experience_years: 0
        };

        if (!row) return res.json(defaults);

        // Map and parse JSON fields if SQLite
        const result = { ...row };
        const jsonFields = [
            'req_license_types', 'req_endorsements', 'req_operation_types',
            'req_modalities', 'offered_payment_methods', 'req_relationships'
        ];

        if (!db.IS_POSTGRES) {
            jsonFields.forEach(field => {
                try {
                    result[field] = typeof row[field] === 'string' ? JSON.parse(row[field]) : (row[field] || []);
                } catch (e) {
                    result[field] = [];
                }
            });
        }

        res.json(result);
    } catch (e) {
        console.error('Error fetching requirements:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
};

const updateCompanyRequirements = async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies can modify' });

    const companyId = req.user.id;
    const {
        req_cdl, req_license_types, req_endorsements, req_operation_types,
        req_modalities, req_truck, offered_payment_methods, req_relationships,
        availability, req_experience_years
    } = req.body;

    const safeJson = (val) => Array.isArray(val) ? JSON.stringify(val) : (typeof val === 'string' ? val : JSON.stringify(val || []));

    const p_req_license_types = safeJson(req_license_types);
    const p_req_endorsements = safeJson(req_endorsements);
    const p_req_operation_types = safeJson(req_operation_types);
    const p_req_modalities = safeJson(req_modalities);
    const p_offered_payment_methods = safeJson(offered_payment_methods);
    const p_req_relationships = safeJson(req_relationships);


    try {
        const sql = db.IS_POSTGRES
            ? `INSERT INTO company_requirements (
                company_id, req_cdl, req_license_types, req_endorsements, req_operation_types, 
                req_modalities, req_truck, offered_payment_methods, req_relationships, 
                availability, req_experience_years, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
              ON CONFLICT (company_id) DO UPDATE SET
                req_cdl=EXCLUDED.req_cdl,
                req_license_types=EXCLUDED.req_license_types,
                req_endorsements=EXCLUDED.req_endorsements,
                req_operation_types=EXCLUDED.req_operation_types,
                req_modalities=EXCLUDED.req_modalities,
                req_truck=EXCLUDED.req_truck,
                offered_payment_methods=EXCLUDED.offered_payment_methods,
                req_relationships=EXCLUDED.req_relationships,
                availability=EXCLUDED.availability,
                req_experience_years=EXCLUDED.req_experience_years,
                updated_at=CURRENT_TIMESTAMP`
            : `INSERT INTO company_requirements (
                company_id, req_cdl, req_license_types, req_endorsements, req_operation_types, 
                req_modalities, req_truck, offered_payment_methods, req_relationships, 
                availability, req_experience_years, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;

        const params = [
            companyId,
            (req_cdl ?? true) ? 1 : 0,
            JSON.stringify(req_license_types || []),
            JSON.stringify(req_endorsements || []),
            JSON.stringify(req_operation_types || []),
            JSON.stringify(req_modalities || []),
            (req_truck ?? false) ? 1 : 0,
            JSON.stringify(offered_payment_methods || []),
            JSON.stringify(req_relationships || []),
            availability || 'Inmediata',
            req_experience_years || 0
        ];

        if (!db.IS_POSTGRES) {
            await db.run('DELETE FROM company_requirements WHERE company_id = ?', companyId);
        }
        await db.run(sql, ...params);
        res.json({ ok: true });
    } catch (e) {
        console.error('Error updating requirements:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
};

app.get('/api/companies/requirements', authenticateToken, getCompanyRequirements);
app.put('/api/companies/requirements', authenticateToken, updateCompanyRequirements);
app.get('/companies/requirements', authenticateToken, getCompanyRequirements);
app.put('/companies/requirements', authenticateToken, updateCompanyRequirements);

// GET company search_status (reads from empresas table directly)
app.get('/api/company/search_status', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies can access' });
    try {
        const row = await db.get("SELECT search_status FROM empresas WHERE id = ?", req.user.id);
        const status = row ? (row.search_status || 'ON') : 'ON';
        res.json({ ok: true, status });
    } catch (e) {
        console.error('Error fetching company search_status:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// POST to update company search_status
app.post('/api/company/search_status', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies can modify their search status' });
    const { status } = req.body;
    if (status !== 'ON' && status !== 'OFF') return res.status(400).json({ error: 'Invalid status' });
    try {
        await db.run("UPDATE empresas SET search_status = ? WHERE id = ?", status, req.user.id);
        res.json({ ok: true, status });
    } catch (e) {
        console.error('Error updating company search_status:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// GET driver search_status (reads from drivers table directly)
app.get('/api/driver/search_status', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Only drivers can access' });
    try {
        const row = await db.get("SELECT search_status FROM drivers WHERE id = ?", req.user.id);
        const status = row ? (row.search_status || 'ON') : 'ON';
        res.json({ ok: true, status });
    } catch (e) {
        console.error('Error fetching driver search_status:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// POST to update driver search_status
app.post('/api/driver/search_status', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Only drivers can modify their search status' });
    const { status } = req.body;
    if (status !== 'ON' && status !== 'OFF') return res.status(400).json({ error: 'Invalid status' });
    try {
        await db.run("UPDATE drivers SET search_status = ? WHERE id = ?", status, req.user.id);
        res.json({ ok: true, status });
    } catch (e) {
        console.error('Error updating driver search_status:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// --- DRIVER PROFILE ---
app.get('/api/drivers/profile', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Only drivers can access' });

    try {
        const row = await db.get("SELECT * FROM drivers WHERE id = ?", req.user.id);
        if (!row) return res.status(404).json({ error: 'Driver not found' });

        const jsonFields = [
            'license_types', 'endorsements', 'operation_types',
            'job_preferences', 'payment_methods', 'work_relationships'
        ];

        const result = { ...row };
        // Clean sensitive data
        delete result.password_hash;
        delete result.verification_token;
        delete result.reset_token;

        if (!db.IS_POSTGRES) {
            jsonFields.forEach(field => {
                try {
                    result[field] = typeof row[field] === 'string' ? JSON.parse(row[field]) : (row[field] || []);
                } catch (e) {
                    result[field] = [];
                }
            });
        }

        // Safety Guarantee: Force all JSON fields to be arrays to prevent React Native .includes() crash
        jsonFields.forEach(field => {
            if (!Array.isArray(result[field])) {
                result[field] = [];
            }
        });

        res.json(result);
    } catch (e) {
        console.error('Error fetching driver profile:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

function safeJson(value, fallback = []) {
    if (value === undefined || value === null) return fallback;
    let parsed = value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return fallback;
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try { parsed = JSON.parse(trimmed); } catch (e) { return fallback; }
        }
    }
    if (Array.isArray(fallback)) {
        return Array.isArray(parsed) ? parsed : fallback;
    } else {
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : fallback;
    }
}

app.put('/api/drivers/profile', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Only drivers can modify' });

    const driverId = req.user.id;
    const body = req.body;
    const { token, password, ...safePayload } = body;
    console.log("[DRIVER_PROFILE][PUT] RECEIVED PAYLOAD:", JSON.stringify(safePayload));

    const {
        has_cdl, license_types, endorsements, operation_types,
        experience_years, job_preferences,
        has_truck, payment_methods, work_relationships, availability
    } = body;

    try {
        let sql, params;

        if (db.IS_POSTGRES) {
            sql = `UPDATE drivers SET 
                has_cdl = ?, license_types = ?::jsonb, endorsements = ?::jsonb, operation_types = ?::jsonb,
                experience_years = ?, job_preferences = ?::jsonb,
                has_truck = ?, payment_methods = ?::jsonb, work_relationships = ?::jsonb, availability = ?,
                updated_at = ?
                WHERE id = ?`;
            params = [
                !!has_cdl, // Native boolean
                JSON.stringify(safeJson(license_types, [])),
                JSON.stringify(safeJson(endorsements, [])),
                JSON.stringify(safeJson(operation_types, [])),
                experience_years || 0,
                JSON.stringify(safeJson(job_preferences, [])),
                !!has_truck, // Native boolean
                JSON.stringify(safeJson(payment_methods, [])),
                JSON.stringify(safeJson(work_relationships, [])),
                availability || 'Inmediata',
                nowIso(),
                driverId
            ];
        } else {
            sql = `UPDATE drivers SET 
                has_cdl = ?, license_types = ?, endorsements = ?, operation_types = ?,
                experience_years = ?, job_preferences = ?,
                has_truck = ?, payment_methods = ?, work_relationships = ?, availability = ?,
                updated_at = ?
                WHERE id = ?`;
            params = [
                +!!has_cdl, // 1/0 for SQLite
                JSON.stringify(safeJson(license_types, [])),
                JSON.stringify(safeJson(endorsements, [])),
                JSON.stringify(safeJson(operation_types, [])),
                experience_years || 0,
                JSON.stringify(safeJson(job_preferences, [])),
                +!!has_truck, // 1/0 for SQLite
                JSON.stringify(safeJson(payment_methods, [])),
                JSON.stringify(safeJson(work_relationships, [])),
                availability || 'Inmediata',
                nowIso(),
                driverId
            ];
        }

        console.log("[DRIVER_PROFILE][PUT] EXECUTING SQL:", sql);
        console.log("[DRIVER_PROFILE][PUT] WITH PARAMS:", JSON.stringify(params));

        await db.run(sql, ...params);
        res.json({ ok: true });
    } catch (e) {
        console.error("[DRIVER_PROFILE][PUT] ERROR", e);
        let detailedMessage = 'Unknown SQL Error';
        try {
            detailedMessage = `ERROR: ${e ? e.message : 'No Msg'} \nDETAIL: ${e ? e.detail : 'No Detail'}`;
        } catch (err) {
            detailedMessage = `Crash extracting error: ${err.message}`;
        }
        res.status(500).json({ error: detailedMessage, code: "DRIVER_PROFILE_PUT_FAILED" });
    }
});




// --- DRIVER TICKETS ---
app.get('/api/tickets/my', authenticateToken, async (req, res) => {
    // Both drivers and empresas might want to see their own tickets, but for drivers it's matches.
    const isDriver = req.user.type === 'driver';
    const isEmpresa = req.user.type === 'empresa';

    try {
        let sql = `
            SELECT t.*, e.nombre as company_name, d.nombre as driver_name 
            FROM tickets t
            LEFT JOIN empresas e ON t.company_id = e.id
            LEFT JOIN drivers d ON t.driver_id = d.id
        `;
        if (isDriver) {
            sql += ` WHERE t.driver_id = ?`;
        } else if (isEmpresa) {
            sql += ` WHERE t.company_id = ?`;
        } else {
            return res.status(403).json({ error: 'Forbidden' });
        }
        sql += ` ORDER BY t.created_at DESC LIMIT 100`;

        const rows = await db.all(sql, req.user.id);
        res.json(rows || []);
    } catch (e) {
        console.error('Error fetching tickets:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// Alias for tickets/my if app uses it
app.get('/tickets/my', authenticateToken, async (req, res) => {
    res.redirect(307, '/api/tickets/my');
});

// --- 8. LEGACY / DEPRECATED ROUTES ---

app.post('/requests/:id/apply', (req, res) => res.status(410).json({ error: 'Deprecated. Use /apply_for_request' }));

// --- 9. STARTUP ---
const { startQueueWorker } = require('./worker_queue');
startQueueWorker().catch(e => console.error('Worker Start Error:', e));

app.get('/api/diagnostics/version', (req, res) => {
    res.json({ version: '1.3.5-profile-crash-fix', status: 'deploy-verified' });
});

// ─── DRIVER LEADS ───────────────────────────────────────────────────────────

// Helper: claim a lead when a driver registers/logs in with matching email or phone
async function claimLeadForDriver(driverId, email, phone) {
    const conditions = [];
    const params = [];
    if (email) { conditions.push('LOWER(email) = LOWER(?)'); params.push(email); }
    if (phone) { conditions.push('phone = ?'); params.push(phone); }
    if (conditions.length === 0) return;

    const lead = await db.get(
        `SELECT id, company_id FROM driver_leads
         WHERE status IN ('NEW','INVITED')
           AND (${conditions.join(' OR ')})
         ORDER BY created_at DESC LIMIT 1`,
        ...params
    );
    if (!lead) return;

    await db.run(
        `UPDATE driver_leads SET status='CLAIMED', claimed_driver_id=?, updated_at=NOW()
         WHERE id=? AND status IN ('NEW','INVITED')`,
        driverId, lead.id
    );
    console.log(`[LeadClaim] driver_id=${driverId} lead_id=${lead.id} company_id=${lead.company_id}`);
}

// POST /leads — create a lead (company only)
app.post('/leads', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies can create leads' });
    const { name, phone, email, notes } = req.body;
    if (!name && !email && !phone) return res.status(400).json({ error: 'At least name, email, or phone required' });

    try {
        const result = await db.run(
            `INSERT INTO driver_leads (company_id, name, phone, email, notes)
             VALUES (?, ?, ?, ?, ?)`,
            req.user.id, name || '', phone || null, email ? email.toLowerCase().trim() : null, notes || null
        );
        console.log(`[Leads] Created lead id=${result.lastInsertRowid} for company_id=${req.user.id}`);
        res.json({ ok: true, id: result.lastInsertRowid });
    } catch (e) {
        if (e.code === '23505' || (e.message && e.message.includes('duplicate'))) {
            return res.status(409).json({ error: 'Lead with this email or phone already exists for your company' });
        }
        console.error('[Leads] Create error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /leads — list leads for company
app.get('/leads', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies' });
    const status = req.query.status || null;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    try {
        let query, params;
        if (status) {
            query = `SELECT id, name, phone, email, notes, status, claimed_driver_id, created_at, updated_at
                     FROM driver_leads WHERE company_id = ? AND status = ?
                     ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            params = [req.user.id, status.toUpperCase(), limit, offset];
        } else {
            query = `SELECT id, name, phone, email, notes, status, claimed_driver_id, created_at, updated_at
                     FROM driver_leads WHERE company_id = ?
                     ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            params = [req.user.id, limit, offset];
        }
        const rows = await db.all(query, ...params);
        res.json(rows);
    } catch (e) {
        console.error('[Leads] List error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /leads/import — CSV import (text/csv or JSON array)
app.post('/leads/import', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies' });

    try {
        let records = [];

        // Accept JSON array or CSV text
        if (Array.isArray(req.body)) {
            records = req.body;
        } else if (typeof req.body === 'string' || (req.body && req.body.csv)) {
            const csvText = typeof req.body === 'string' ? req.body : req.body.csv;
            const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header + at least 1 row' });

            const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
            for (let i = 1; i < lines.length; i++) {
                const vals = lines[i].split(',').map(v => v.trim());
                const obj = {};
                headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
                records.push(obj);
            }
        } else if (req.body && req.body.leads && Array.isArray(req.body.leads)) {
            records = req.body.leads;
        } else {
            return res.status(400).json({ error: 'Send JSON array, {leads:[...]}, or {csv:"..."}' });
        }

        let created = 0, skipped = 0, errors = 0;
        for (const rec of records) {
            const name = (rec.name || '').trim();
            const email = (rec.email || '').trim().toLowerCase() || null;
            const phone = (rec.phone || '').trim() || null;
            const notes = (rec.notes || '').trim() || null;

            if (!name && !email && !phone) { skipped++; continue; }

            try {
                await db.run(
                    `INSERT INTO driver_leads (company_id, name, phone, email, notes) VALUES (?, ?, ?, ?, ?)`,
                    req.user.id, name, phone, email, notes
                );
                created++;
            } catch (e) {
                if (e.code === '23505' || (e.message && e.message.includes('duplicate'))) {
                    skipped++;
                } else {
                    errors++;
                    console.error('[Leads] Import row error:', e.message);
                }
            }
        }

        console.log(`[Leads] Import for company_id=${req.user.id}: created=${created} skipped=${skipped} errors=${errors}`);
        res.json({ ok: true, created, skipped, errors, total: records.length });
    } catch (e) {
        console.error('[Leads] Import error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── MATCHES HELPERS (defensive, crash-proof) ──────────────────────────────

async function ensureUserMatchGenerationLogTable() {
    try {
        await db.run(`
            CREATE TABLE IF NOT EXISTS user_match_generation_log (
                user_id INTEGER NOT NULL,
                user_type TEXT NOT NULL,
                last_generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await db.run(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_user_match_gen_unique
            ON user_match_generation_log (user_type, user_id)
        `);
    } catch (e) {
        console.error("[matches] ensureUserMatchGenerationLogTable failed:", e);
    }
}

async function getLastGenerationAt(userType, userId) {
    try {
        const row = await db.get(
            `SELECT last_generated_at FROM user_match_generation_log
             WHERE user_type = ? AND user_id = ?
             LIMIT 1`,
            userType, userId
        );
        return row ? row.last_generated_at : null;
    } catch (e) {
        if (String(e.message || "").includes("does not exist") || e.code === "42P01") {
            console.warn("[matches] user_match_generation_log missing; creating...");
            await ensureUserMatchGenerationLogTable();
            return null;
        }
        console.error("[matches] getLastGenerationAt error:", e);
        return null; // fail open
    }
}

async function writeGenerationLog(userType, userId) {
    try {
        await db.run(
            `INSERT INTO user_match_generation_log (user_type, user_id, last_generated_at)
             VALUES (?, ?, NOW())
             ON CONFLICT (user_type, user_id)
             DO UPDATE SET last_generated_at = NOW()`,
            userType, userId
        );
    } catch (e) {
        if (String(e.message || "").includes("does not exist") || e.code === "42P01") {
            await ensureUserMatchGenerationLogTable();
            try {
                await db.run(
                    `INSERT INTO user_match_generation_log (user_type, user_id, last_generated_at)
                     VALUES (?, ?, NOW())
                     ON CONFLICT (user_type, user_id)
                     DO UPDATE SET last_generated_at = NOW()`,
                    userType, userId
                );
            } catch (e2) {
                console.error("[matches] writeGenerationLog retry failed:", e2);
            }
            return;
        }
        console.error("[matches] writeGenerationLog failed:", e);
    }
}

async function tryUserAdvisoryLock(lockKey) {
    try {
        const row = await db.get(`SELECT pg_try_advisory_lock(?) AS locked`, lockKey);
        return !!(row && (row.locked === true || row.locked === 1));
    } catch (e) {
        console.warn("[matches] advisory lock failed, continuing without lock:", e.message);
        return true; // fail open
    }
}

async function unlockUserAdvisoryLock(lockKey) {
    try {
        await db.get(`SELECT pg_advisory_unlock(?)`, lockKey);
    } catch (_) { }
}

// ─── MATCHES READER ENDPOINTS ───────────────────────────────────────────────

// GET /matches/candidates — Company sees matched drivers
app.get('/matches/candidates', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies can view candidates' });

    try {
        const freshHours = Number(process.env.MATCH_FRESH_HOURS || 24);
        const minActive = Number(process.env.MATCH_MIN_ACTIVE || 5);
        const cooldownMin = Number(process.env.MATCH_COOLDOWN_MINUTES || 10);
        const cutoff = new Date(Date.now() - freshHours * 3600 * 1000).toISOString();

        // 1) Count fresh active matches
        const recentRow = await db.get(
            `SELECT COUNT(*) AS c FROM potential_matches
             WHERE company_id = ? AND status NOT IN ('DECLINED','EXPIRED') AND created_at >= ?`,
            req.user.id, cutoff
        );
        const recentCount = recentRow ? parseInt(recentRow.c) : 0;

        // 2) Generate if needed
        if (recentCount < minActive) {
            const lastGen = await getLastGenerationAt('empresa', req.user.id);
            const inCooldown = lastGen && (Date.now() - new Date(lastGen).getTime()) < cooldownMin * 60 * 1000;

            if (!inCooldown) {
                const lockKey = 200000 + req.user.id;
                const locked = await tryUserAdvisoryLock(lockKey);
                if (locked) {
                    try {
                        const { generateMatchesForCompany } = require('./lazy_matching');
                        await generateMatchesForCompany(req.user.id);
                        await writeGenerationLog('empresa', req.user.id);
                    } finally {
                        await unlockUserAdvisoryLock(lockKey);
                    }
                }
            }
        }

        // 2.5) Auto-invite matching leads
        try {
            const MAX_INVITE_COUNT = 5;
            const leads = await db.all(
                `SELECT id, name, email FROM driver_leads
                 WHERE company_id = ? AND status IN ('NEW','INVITED')
                   AND email IS NOT NULL AND email <> ''
                   AND is_synthetic = false
                   AND (invited_at IS NULL OR invited_at < NOW() - INTERVAL '7 days')
                   AND (invite_count IS NULL OR invite_count < ?)
                 LIMIT 10`,
                req.user.id, MAX_INVITE_COUNT
            );

            if (leads.length > 0) {
                const companyRow = await db.get('SELECT nombre FROM empresas WHERE id = ?', req.user.id);
                const companyName = companyRow ? companyRow.nombre : 'Una empresa';

                for (const lead of leads) {
                    await db.run(
                        `UPDATE driver_leads SET invited_at = NOW(), invite_count = COALESCE(invite_count, 0) + 1, status = 'INVITED', updated_at = NOW() WHERE id = ?`,
                        lead.id
                    );
                    await db.run(
                        `INSERT INTO events_outbox (request_id, event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?, ?)`,
                        'lead_invite', 'lead_invitation_email', new Date().toISOString(), req.user.id,
                        JSON.stringify({ lead_id: lead.id, company_id: req.user.id, company_name: companyName, email: lead.email, name: lead.name || 'Conductor' })
                    );
                }
                console.log(`[Leads] Auto-invited ${leads.length} leads for company_id=${req.user.id}`);
            }
        } catch (invErr) {
            console.error('[Leads] Auto-invite error:', invErr.message);
        }

        // 3) Return matches (existing query)
        const rows = await db.all(`
            SELECT
                pm.id           AS match_id,
                pm.match_score,
                pm.status,
                pm.created_at,
                pm.driver_step1_accepted_at,
                pm.company_step1_accepted_at,
                pm.driver_share_consent_at,
                pm.company_share_consent_at,
                d.id            AS driver_id,
                d.nombre        AS display_name,
                d.contacto      AS driver_email,
                d.experience_years,
                d.license_types AS license_summ,
                d.operation_types AS op_types,
                d.payment_methods AS pay_methods,
                d.availability
            FROM potential_matches pm
            JOIN drivers d ON d.id = pm.driver_id
            WHERE pm.company_id = ?
              AND pm.status NOT IN ('DECLINED','EXPIRED')
            ORDER BY pm.created_at DESC
        `, req.user.id);

        const sanitized = rows.map(r => {
            if (r.status !== 'INFO_SHARED') {
                return { ...r, driver_email: null };
            }
            return r;
        });

        res.json(sanitized);
    } catch (e) {
        console.error('[matches/candidates] fatal:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /matches/opportunities — User sees their specific matches
app.get('/matches/opportunities', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const userType = req.user.type; // 'driver' or 'empresa'

    try {
        const freshHours = Number(process.env.MATCH_FRESH_HOURS || 24);
        const minActive = Number(process.env.MATCH_MIN_ACTIVE || 5);
        const cooldownMin = Number(process.env.MATCH_COOLDOWN_MINUTES || 10);
        const cutoff = new Date(Date.now() - freshHours * 3600 * 1000).toISOString();

        const filterColumn = userType === 'driver' ? 'driver_id' : 'company_id';
        if (userType !== 'driver' && userType !== 'empresa') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // 1) Count fresh active matches
        const recentRow = await db.get(
            `SELECT COUNT(*) AS c FROM potential_matches
             WHERE ${filterColumn} = ? AND status NOT IN ('DECLINED','EXPIRED') AND created_at >= ?`,
            userId, cutoff
        );
        const recentCount = recentRow ? parseInt(recentRow.c) : 0;
        console.log(`[matches/opportunities] user=${userType} id=${userId} recentActive=${recentCount} min=${minActive}`);

        // 2) Generate if needed (freshness + cooldown + lock)
        if (recentCount < minActive) {
            const lastGen = await getLastGenerationAt(userType, userId);
            const inCooldown = lastGen && (Date.now() - new Date(lastGen).getTime()) < cooldownMin * 60 * 1000;

            if (inCooldown) {
                console.log(`[matches/opportunities] user=${userType} id=${userId} inCooldown=true, skipping generation`);
            } else {
                const lockKey = (userType === 'driver' ? 100000 : 200000) + userId;
                const locked = await tryUserAdvisoryLock(lockKey);

                if (!locked) {
                    console.log(`[matches/opportunities] user=${userType} id=${userId} lock=blocked`);
                } else {
                    try {
                        const { generateMatchesForDriver, generateMatchesForCompany } = require('./lazy_matching');
                        if (userType === 'driver') {
                            await generateMatchesForDriver(userId);
                        } else {
                            await generateMatchesForCompany(userId);
                        }
                        await writeGenerationLog(userType, userId);
                    } finally {
                        await unlockUserAdvisoryLock(lockKey);
                    }
                }
            }
        }

        // 3) Return matches (existing query)
        const rows = await db.all(`
            SELECT
                pm.id           AS match_id,
                pm.match_score,
                pm.status,
                pm.created_at,
                pm.driver_step1_accepted_at,
                pm.company_step1_accepted_at,
                pm.driver_share_consent_at,
                pm.company_share_consent_at,
                pm.company_id,
                COALESCE(e.nombre, 'Company #' || CAST(pm.company_id AS TEXT)) AS display_name,
                e.contacto      AS company_email,
                cr.req_operation_types AS op_types,
                cr.offered_payment_methods AS pay_methods,
                cr.availability
            FROM potential_matches pm
            LEFT JOIN empresas e ON e.id = pm.company_id
            LEFT JOIN company_requirements cr ON cr.company_id = pm.company_id
            WHERE pm.${filterColumn} = ?
              AND pm.status NOT IN ('DECLINED','EXPIRED')
            ORDER BY pm.match_score DESC, pm.created_at DESC
        `, userId);

        const sanitized = rows.map(r => {
            if (r.status !== 'INFO_SHARED') {
                return { ...r, company_email: null };
            }
            return r;
        });

        res.json(sanitized);
    } catch (e) {
        console.error('[matches/opportunities] fatal:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── MATCH STATE TRANSITIONS ───────────────────────────────────────────────────

const updateMatchStatus = async (req, res, newStatus) => {
    const matchId = req.params.id;
    const userId = req.user.id;
    const userType = req.user.type; // 'empresa' or 'driver'
    const now = new Date().toISOString();

    try {
        const match = await db.get('SELECT * FROM potential_matches WHERE id = ?', matchId);
        if (!match) return res.status(404).json({ error: 'Match not found' });

        if (userType === 'empresa' && match.company_id !== userId) return res.status(403).json({ error: 'Unauthorized' });
        if (userType === 'driver' && match.driver_id !== userId) return res.status(403).json({ error: 'Unauthorized' });

        let updateSql = 'UPDATE potential_matches SET status = ?, updated_at = ?';
        let params = [newStatus, now];

        if (newStatus === 'ACCEPTED') {
            if (userType === 'driver') {
                updateSql = 'UPDATE potential_matches SET driver_step1_accepted_at = ?, updated_at = ?';
                params = [now, now];
            } else {
                updateSql = 'UPDATE potential_matches SET company_step1_accepted_at = ?, updated_at = ?';
                params = [now, now];
            }

            // Check if both accepted
            const dAccept = userType === 'driver' ? now : match.driver_step1_accepted_at;
            const cAccept = userType === 'empresa' ? now : match.company_step1_accepted_at;

            if (dAccept && cAccept) {
                updateSql = 'UPDATE potential_matches SET driver_step1_accepted_at = COALESCE(driver_step1_accepted_at, ?), company_step1_accepted_at = COALESCE(company_step1_accepted_at, ?), status = ?, updated_at = ?';
                params = [now, now, 'PREMATCH_READY', now];
                newStatus = 'PREMATCH_READY';
            }
        }

        updateSql += ' WHERE id = ?';
        params.push(matchId);

        await db.run(updateSql, ...params);

        console.log(`[Matches] Match ${matchId} updated to ${newStatus} by ${userType} ${userId}`);
        res.json({ success: true, status: newStatus });
    } catch (e) {
        console.error(`[Matches] Error updating match ${matchId} to ${newStatus}:`, e);
        res.status(500).json({ error: 'Server error' });
    }
};

const finalizeShare = async (matchId) => {
    const now = new Date().toISOString();
    await db.run(
        "UPDATE potential_matches SET status = 'INFO_SHARED', info_shared_at = ?, updated_at = ? WHERE id = ?",
        now, now, matchId
    );
};

app.post('/matches/:id/driver/confirm-share', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Only drivers' });
    const matchId = req.params.id;
    const now = new Date().toISOString();

    try {
        const match = await db.get('SELECT * FROM potential_matches WHERE id = ? AND driver_id = ?', matchId, req.user.id);
        if (!match) return res.status(404).json({ error: 'Match not found' });

        const validDriverStates = ['ACCEPTED', 'PREMATCH_READY', 'SHARE_PENDING_DRIVER', 'SHARE_PENDING_COMPANY', 'INFO_SHARED'];
        if (!validDriverStates.includes(match.status)) {
            return res.status(409).json({ error: 'Invalid match state for consent', current_status: match.status });
        }

        await db.run(
            'UPDATE potential_matches SET driver_share_consent_at = ?, updated_at = ? WHERE id = ?',
            now, now, matchId
        );

        const updated = await db.get('SELECT * FROM potential_matches WHERE id = ?', matchId);
        if (updated.company_share_consent_at && updated.ticket_id) {
            await finalizeShare(matchId);
            return res.json({ success: true, status: 'INFO_SHARED' });
        }

        res.json({ success: true, status: updated.status });
    } catch (e) {
        console.error('[Matches] driver confirm-share error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/matches/:id/company/confirm-share', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies' });
    const matchId = req.params.id;
    const now = new Date().toISOString();

    try {
        const match = await db.get('SELECT * FROM potential_matches WHERE id = ? AND company_id = ?', matchId, req.user.id);
        if (!match) return res.status(404).json({ error: 'Match not found' });

        const validCompanyStates = ['ACCEPTED', 'PREMATCH_READY', 'SHARE_PENDING_DRIVER', 'SHARE_PENDING_COMPANY', 'INFO_SHARED'];
        if (!validCompanyStates.includes(match.status)) {
            return res.status(409).json({ error: 'Invalid match state for consent', current_status: match.status });
        }

        if (!match.driver_share_consent_at) {
            return res.status(409).json({ error: 'Driver must consent first' });
        }

        // 1. Check if ticket already exists for this match (idempotent)
        const existingTicket = await db.get('SELECT id FROM tickets WHERE match_id = ?', parseInt(matchId));
        if (existingTicket) {
            // Idempotent: sync match record and return existing ticket
            await db.run(
                'UPDATE potential_matches SET company_share_consent_at = COALESCE(company_share_consent_at, ?), ticket_id = ?, updated_at = ? WHERE id = ?',
                now, existingTicket.id, now, matchId
            );
            await finalizeShare(matchId);
            return res.json({ success: true, status: 'INFO_SHARED', ticket_id: existingTicket.id });
        }

        // 2. Create new ticket (match_id is NOT NULL + UNIQUE enforced by DB)
        const amount = parseInt(process.env.WEEKLY_FEE_CENTS) || 15000;
        let ticketId = null;

        try {
            const t = await db.run(
                `INSERT INTO tickets (match_id, company_id, driver_id, price_cents, amount_cents, currency, created_at, billing_status, billing_notes)
                 VALUES (?,?,?,?,?,'USD',?,'pending',?)
                 RETURNING id`,
                parseInt(matchId), match.company_id, match.driver_id, amount, amount, now, `Match ID: ${matchId}`
            );
            ticketId = (t.rows && t.rows[0]) ? t.rows[0].id : t.lastInsertRowid;
        } catch (insertErr) {
            // Race condition safety: concurrent request already inserted
            if (insertErr.code === '23505' || (insertErr.message && (insertErr.message.includes('UNIQUE') || insertErr.message.includes('duplicate')))) {
                const race = await db.get('SELECT id FROM tickets WHERE match_id = ?', parseInt(matchId));
                ticketId = race ? race.id : null;
            } else {
                throw insertErr;
            }
        }

        if (!ticketId) {
            console.error(`[Matches] Failed to create or find ticket for match ${matchId}`);
            return res.status(500).json({ error: 'Ticket creation failed' });
        }

        // 3. Update match record
        await db.run(
            'UPDATE potential_matches SET company_share_consent_at = COALESCE(company_share_consent_at, ?), ticket_id = ?, fee_cents = ?, fee_currency = ?, updated_at = ? WHERE id = ?',
            now, ticketId, amount, 'USD', now, matchId
        );

        await finalizeShare(matchId);

        console.log(`[Matches] Company confirmed share for match ${matchId}. Ticket ${ticketId}`);
        res.json({ success: true, status: 'INFO_SHARED', ticket_id: ticketId });
    } catch (e) {
        console.error('[Matches] company confirm-share error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/matches/:id/viewed', authenticateToken, (req, res) => updateMatchStatus(req, res, 'VIEWED'));
app.post('/matches/:id/contacted', authenticateToken, (req, res) => updateMatchStatus(req, res, 'CONTACTED'));
app.post('/matches/:id/accept', authenticateToken, (req, res) => updateMatchStatus(req, res, 'ACCEPTED'));
app.post('/matches/:id/decline', authenticateToken, (req, res) => updateMatchStatus(req, res, 'DECLINED'));

// ──────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {

    console.log(`Server running on port ${PORT} [${process.env.NODE_ENV}]`);
    console.log(`DB Mode: ${db.IS_POSTGRES ? 'PostgreSQL' : 'SQLite'}`);
});
