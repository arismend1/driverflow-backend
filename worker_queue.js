const crypto = require('crypto');
const db = require('./db_adapter'); // Async Adapter
const logger = require('./logger');
const time = require('./time_contract');

const WORKER_ID = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const POLL_INTERVAL = 2000;
const BATCH_SIZE = 5;

// Wrapper for compatibility
const nowIso = () => time.nowIso({ ctx: 'worker_queue' });

// --- ENQUEUE HELPER ---
async function enqueueJob(type, payload, options = {}) {
    // options: { run_at, max_attempts, idempotency_key }
    const runAt = options.run_at || nowIso();
    const max = options.max_attempts || 5;
    const now = nowIso();

    try {
        await db.run(`
            INSERT INTO jobs_queue (job_type, payload_json, run_at, max_attempts, created_at, idempotency_key)
            VALUES (?, ?, ?, ?, ?, ?)
        `, type, JSON.stringify(payload), runAt, max, now, options.idempotency_key || null);
        return true;
    } catch (e) {
        if (e.message.includes('UNIQUE')) return false; // Idempotent ignore
        throw e;
    }
}

// --- BRIDGE: Outbox -> Queue ---
async function bridgeOutbox() {
    const now = nowIso();

    // Atomic Bridge Transaction using manual BEGIN/COMMIT for Postgres compatibility
    try {
        await db.run('BEGIN');

        // Select pending (limit 50 to avoid big transactions)
        // FOR UPDATE SKIP LOCKED would be better in PG, but keeping it simple for MVP compatibility
        const rows = await db.all(`
            SELECT id, event_name, metadata, audience_type, audience_id, event_key 
            FROM events_outbox 
            WHERE queue_status = 'pending' 
            LIMIT 50
        `);

        if (rows.length === 0) {
            await db.run('COMMIT');
            return;
        }

        const ids = rows.map(r => r.id);

        // Mark as 'queued' immediately
        // In PG, we're in a transaction, so this is safe.
        // We can't easily do "WHERE id IN (?)" with generic adapter array params efficiently in one go 
        // without dynamic SQL or JSON args.
        // Simplest: Loop updates (inside tx, it's fast enough) or dynamic SQL.
        // Let's use dynamic SQL for the IDs since we have them.

        // Safety: ids are numbers.
        const idList = ids.join(',');
        await db.run(`UPDATE events_outbox SET queue_status = 'queued', queued_at = ? WHERE id IN (${idList})`, now);

        for (const ev of rows) {
            let meta = {};
            try { meta = JSON.parse(ev.metadata || '{}'); } catch { }

            // Job Construction
            let jobType = null;
            let payload = {};

            if (ev.event_name === 'verification_email' || ev.event_name === 'recovery_email') {
                jobType = 'send_email';
                payload = { ...meta, event_name: ev.event_name, email: meta.email };
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
                try {
                    await db.run(`
                        INSERT INTO jobs_queue (
                            job_type, payload_json, run_at, max_attempts, created_at, idempotency_key, source_event_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    `,
                        jobType,
                        JSON.stringify(payload),
                        now,
                        5,
                        now,
                        `ev_${ev.id}`, // idempotency_key
                        ev.id          // source_event_id (UNIQUE constraint)
                    );
                } catch (e) {
                    if (e.message.includes('UNIQUE')) {
                        logger.warn(`Duplicate bridge attempt for event ${ev.id}`);
                    } else {
                        throw e;
                    }
                }
            }
        }

        await db.run('COMMIT');

    } catch (e) {
        try { await db.run('ROLLBACK'); } catch (err) { }
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
            if (res.status === 403 || res.status === 429) {
                logger.warn(`SendGrid Limit Reached (${res.status}). Dropped.`, { to: payload.email });
                return;
            }
            throw new Error(`SendGrid Error ${res.status}: ${errText}`);
        }
    },

    async realtime_push(payload) {
        // Placeholder for SSE/Push logic
    }
};

// --- WORKER LOOP ---
async function processJobs() {
    const now = nowIso();
    const jobsToProcess = [];

    // 1. Claim Batch (Atomic Transaction)
    try {
        await db.run('BEGIN');

        // Note: For high concurrency in Postgres, "FOR UPDATE SKIP LOCKED" is best.
        // Using simple UPDATE ... WHERE ... RETURNING is a good approximation for MVP if rows are locked.
        // But here we do: Select -> Update. 
        // In Repeatable Read this might serialize or fail. In Read Committed it's okay but might race.
        // We'll rely on optimistic locking or standard locking.

        // Simpler approach compatible with Generic Adapter:
        // Use a single atomic UPDATE ... RETURNING ... LIMIT?
        // SQLite doesn't support UPDATE LIMIT easily without compiled options.
        // PG does with CTEs.
        // Standard MVP way: Fetch candidate IDs -> Update them -> Process them.

        const candidates = await db.all(`
            SELECT id FROM jobs_queue 
            WHERE status = 'pending' AND run_at <= ? 
            LIMIT ?
        `, now, BATCH_SIZE);

        if (candidates.length > 0) {
            const ids = candidates.map(c => c.id);
            const idList = ids.join(',');

            // Mark captured
            await db.run(`
                UPDATE jobs_queue 
                SET status = 'processing', locked_by = ?, locked_at = ? 
                WHERE id IN (${idList})
            `, WORKER_ID, now);

            // Re-fetch full data
            const claimed = await db.all(`SELECT * FROM jobs_queue WHERE id IN (${idList})`);
            jobsToProcess.push(...claimed);
        }

        await db.run('COMMIT');

    } catch (e) {
        try { await db.run('ROLLBACK'); } catch { }
        if (!e.message.includes('busy')) logger.error('Worker Claim Error', e);
        return;
    }

    // Process Outside Transaction
    for (const job of jobsToProcess) {
        try {
            const handler = handlers[job.job_type];
            if (!handler) throw new Error(`Unknown handler ${job.job_type}`);

            const payload = JSON.parse(job.payload_json);

            await handler(payload);

            // Success
            await db.run("UPDATE jobs_queue SET status='done', updated_at=? WHERE id=?", nowIso(), job.id);
            logger.info(`Job ${job.id} (${job.job_type}) DONE`, { worker: WORKER_ID });

        } catch (e) {
            // Failure
            const attempts = job.attempts + 1;
            const isDead = attempts >= job.max_attempts;
            const nextStatus = isDead ? 'dead' : 'pending';
            const delaySec = 5 * Math.pow(2, attempts - 1);
            const nowMs = time.nowMs({ ctx: 'worker_retry_calc' });
            const nextRun = new Date(nowMs + delaySec * 1000).toISOString();

            await db.run(`
                UPDATE jobs_queue 
                SET status = ?, attempts = ?, last_error = ?, run_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ? 
                WHERE id = ?
            `, nextStatus, attempts, e.message, nextRun, nowIso(), job.id);

            logger.error(`Job ${job.id} FAILED (${attempts}/${job.max_attempts}) -> ${nextStatus}`, { error: e.message });
        }
    }
}

// --- MAIN LOOP ---
async function startQueueWorker() {
    logger.info(`Queue Worker Started`, { worker_id: WORKER_ID });

    // Heartbeat Loop
    setInterval(async () => {
        try {
            // Upsert Heartbeat
            // PG: ON CONFLICT DO UPDATE
            // SQLite: same
            await db.run(`
                INSERT INTO worker_heartbeat (worker_name, last_seen, status) VALUES ('queue_worker', ?, 'running')
                ON CONFLICT(worker_name) DO UPDATE SET last_seen=excluded.last_seen
            `, nowIso());
        } catch (e) { }
    }, 15000);

    // Processing Loop
    while (true) {
        try {
            await bridgeOutbox();
            await processJobs();
        } catch (e) {
            logger.error('Worker Loop fail', e);
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
}

module.exports = { startQueueWorker, enqueueJob, bridgeOutbox };
