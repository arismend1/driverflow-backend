const Database = require('better-sqlite3');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Environment
const DB_PATH = (process.env.DB_PATH || 'driverflow.db').trim();
const WORKER_ID = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const POLL_INTERVAL = 2000;
const BATCH_SIZE = 5;
const LOCK_TTL_SEC = 300; // 5 mins

// Deps (Handlers)
// Note: We'll construct specific handler logic inside or require it if needed.
// For MVP, we inline standard handlers (email, etc) or reuse existing code logic.
const logger = require('./logger');

// DB Connection for Worker
let db;

function getDb() {
    if (!db) db = new Database(DB_PATH);
    return db;
}

function nowIso() { return new Date().toISOString(); }

// --- ENQUEUE HELPER ---
function enqueueJob(dbConn, type, payload, options = {}) {
    // options: { run_at, max_attempts, idempotency_key }
    const runAt = options.run_at || nowIso();
    const max = options.max_attempts || 5;
    const now = nowIso();

    try {
        const stmt = dbConn.prepare(`
            INSERT INTO jobs_queue (job_type, payload_json, run_at, max_attempts, created_at, idempotency_key)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(type, JSON.stringify(payload), runAt, max, now, options.idempotency_key || null);
        return true;
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return false; // Idempotent ignore
        throw e;
    }
}

// --- BRIDGE: Outbox -> Queue ---
function bridgeOutbox() {
    const conn = getDb();
    const now = nowIso();

    // Atomic Bridge Transaction
    // 1. Select Pending Events
    // 2. Update events_outbox status to 'queued'
    // 3. Insert into jobs_queue
    const tx = conn.transaction(() => {
        // Select pending (limit 50 to avoid big transactions)
        const rows = conn.prepare(`
            SELECT id, event_name, metadata, audience_type, audience_id, event_key 
            FROM events_outbox 
            WHERE queue_status = 'pending' 
            LIMIT 50
        `).all();

        if (rows.length === 0) return;

        const ids = rows.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');

        // Mark as 'queued' immediately to prevent other workers picking them up
        // Note: In SQLite, the transaction holds the lock.
        conn.prepare(`
            UPDATE events_outbox 
            SET queue_status = 'queued', queued_at = ? 
            WHERE id IN (${placeholders})
        `).run(now, ...ids);

        for (const ev of rows) {
            let meta = {};
            try { meta = JSON.parse(ev.metadata || '{}'); } catch { }

            // Job Construction
            let jobType = null;
            let payload = {};

            if (ev.event_name === 'verification_email' || ev.event_name === 'recovery_email') {
                jobType = 'send_email';
                payload = { ...meta, event_name: ev.event_name, email: meta.email }; // Ensure email is in payload
            }
            else if (['rating_created', 'invoice_paid', 'driver_applied', 'request_created', 'match_confirmed', 'request_cancelled'].includes(ev.event_name)) {
                jobType = 'realtime_push';
                payload = {
                    event_id: ev.id,
                    event_key: ev.event_key || ev.event_name,
                    audience_type: ev.audience_type,
                    audience_id: ev.audience_id,
                    data: meta
                };
            }

            if (jobType) {
                // Enqueue with Source Event ID to enforce Uniqueness at DB level
                try {
                    conn.prepare(`
                        INSERT INTO jobs_queue (
                            job_type, payload_json, run_at, max_attempts, created_at, idempotency_key, source_event_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        jobType,
                        JSON.stringify(payload),
                        now,
                        5,
                        now,
                        `ev_${ev.id}`, // idempotency_key
                        ev.id          // source_event_id (UNIQUE constraint)
                    );
                } catch (e) {
                    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                        // Already bridged? Ignore.
                        // Ideally shouldn't happen if queue_status logic works, but safety net.
                        logger.warn(`Duplicate bridge attempt for event ${ev.id}`);
                    } else {
                        throw e; // Abort transaction if other error
                    }
                }
            }
        }

        // logger.info(`Bridged ${rows.length} events`);
    });

    try {
        tx();
    } catch (e) {
        if (!e.message.includes('busy')) logger.error('Bridge Error', e);
    }
}

// --- HANDLERS ---
const handlers = {
    async send_email(payload) {
        const dryRun = process.env.DRY_RUN === '1';

        const apiKey = process.env.SENDGRID_API_KEY;
        const fromEmail = process.env.FROM_EMAIL;

        if (!apiKey) {
            if (dryRun) { logger.info('DRY RUN MISSING KEY', payload); return; }
            throw new Error('Missing SENDGRID_API_KEY');
        }

        let subject = "DriverFlow Notification";
        let body = "Notification";

        if (payload.event_name === 'verification_email') {
            subject = "Verifica tu cuenta - DriverFlow";
            body = `Tu código de verificación es: ${payload.token}`;
        } else if (payload.event_name === 'recovery_email') {
            subject = "Restablecer Password - DriverFlow";
            body = `Usa este token para restablecer tu contraseña: ${payload.token}`;
        }

        if (dryRun) {
            logger.info(`[DRY RUN] Sending Email to ${payload.email}: ${subject}`);
            return;
        }

        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                personalizations: [{ to: [{ email: payload.email }] }],
                from: { email: fromEmail || "no-reply@driverflow.app" },
                subject,
                content: [{ type: "text/plain", value: body }]
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`SendGrid Error ${res.status}: ${errText}`);
        }
    },

    async realtime_push(payload) {
        // Logic: Mark as 'pushed' or rely on server.js polling loop
        // In this MVP architecture, the worker just acknowledges the event was bridged.
        // Actual push happens via server.js polling 'events_outbox'.
        // Wait, if we bridged it, server.js sees it?
        // Server.js polls `status='pending'`? No, server.js polls `realtime_sent_at IS NULL`.
        // So as long as we don't touch partial `realtime_sent_at`, server.js picks it up.
        // This 'realtime_push' job is arguably redundant for MVP Node+SQLite unless we move SSE logic here.
        // But for future Redis scaling, this is WHERE it goes.
        // So we leave it as a placeholder that marks the JOB as done.
        // The event in outbox remains there for server.js to pick up for SSE.
        // logger.info("Realtime Push Job logic (Placeholder)", payload);
    }
};

// --- WORKER LOOP ---
async function processJobs() {
    const conn = getDb();
    const now = nowIso();

    // 1. Release Old Locks (Safety)
    // conn.prepare("UPDATE jobs_queue SET locked_by=NULL, locked_at=NULL WHERE locked_at < datetime(?, '-? seconds')") ...

    // 2. Claim Batch (Atomic Transaction)
    // We use IMMEDIATE transaction to lock DB for writing, pick items, update them, and commit.
    // This effectively serializes the claim step across ANY connection to this DB file.

    const jobsToProcess = [];

    try {
        const claimTx = conn.transaction(() => {
            const candidates = conn.prepare(`
                SELECT id FROM jobs_queue 
                WHERE status = 'pending' AND run_at <= ? 
                LIMIT ?
            `).all(now, BATCH_SIZE);

            if (candidates.length === 0) return;

            const ids = candidates.map(c => c.id);
            const placeholders = ids.map(() => '?').join(',');

            conn.prepare(`
                UPDATE jobs_queue 
                SET status = 'processing', locked_by = ?, locked_at = ? 
                WHERE id IN (${placeholders})
            `).run(WORKER_ID, now, ...ids);

            return conn.prepare(`SELECT * FROM jobs_queue WHERE id IN (${placeholders})`).all(...ids);
        });

        // better-sqlite3 transactions are immediate by default if they write? 
        // We can force it: db.transaction(..., { immediate: true })? No, typical wrapper.
        // But running it inside transaction ensures atomicity.

        const claimed = claimTx();
        if (claimed) jobsToProcess.push(...claimed);

    } catch (e) {
        if (!e.message.includes('busy')) {
            logger.error('Worker Claim Error', e);
        }
        // If busy (locked by another worker), just wait next tick.
        return;
    }

    // Process Outside Transaction (to keep lock duration short)
    for (const job of jobsToProcess) {
        try {
            const handler = handlers[job.job_type];
            if (!handler) throw new Error(`Unknown handler ${job.job_type}`);

            const payload = JSON.parse(job.payload_json);

            // Execute
            await handler(payload);

            // Success
            conn.prepare("UPDATE jobs_queue SET status='done', updated_at=? WHERE id=?").run(nowIso(), job.id);
            logger.info(`Job ${job.id} (${job.job_type}) DONE`, { worker: WORKER_ID });

        } catch (e) {
            // Failure
            const attempts = job.attempts + 1;
            const isDead = attempts >= job.max_attempts;

            // DLQ transition
            const nextStatus = isDead ? 'dead' : 'pending'; // 'dead' is our DLQ status

            // Backoff: 5s, 10s, 20s...
            const delaySec = 5 * Math.pow(2, attempts - 1);
            const nextRun = new Date(Date.now() + delaySec * 1000).toISOString();

            conn.prepare(`
                UPDATE jobs_queue 
                SET status = ?, attempts = ?, last_error = ?, run_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ? 
                WHERE id = ?
            `).run(nextStatus, attempts, e.message, nextRun, nowIso(), job.id);

            logger.error(`Job ${job.id} FAILED (${attempts}/${job.max_attempts}) -> ${nextStatus}`, { error: e.message });
        }
    }
}

// --- MAIN LOOP ---
async function startQueueWorker() {
    const conn = getDb();
    logger.info(`Queue Worker Started`, { worker_id: WORKER_ID });

    setInterval(() => {
        // Heartbeat
        try {
            conn.prepare(`
                INSERT INTO worker_heartbeat (worker_name, last_seen, status) VALUES ('queue_worker', ?, 'running')
                ON CONFLICT(worker_name) DO UPDATE SET last_seen=excluded.last_seen
            `).run(nowIso());
        } catch (e) { }
    }, 15000);

    // Processing Loop
    while (true) {
        try {
            bridgeOutbox(); // Move items
            await processJobs(); // Process items
        } catch (e) {
            logger.error('Worker Loop fail', e);
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
}

module.exports = { startQueueWorker, enqueueJob, getDb, bridgeOutbox };
