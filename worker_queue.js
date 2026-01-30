const cron = require('node-cron');
const crypto = require('crypto');
const db = require('./db_adapter'); // Async Adapter
const logger = require('./logger');
const time = require('./time_contract');

const WORKER_ID = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const POLL_INTERVAL = 2000;
const BATCH_SIZE = 5;

// Wrapper for compatibility
const nowIso = () => time.nowIso({ ctx: 'worker_queue' });
const API_URL = process.env.API_URL || "https://driverflow-backend.onrender.com";
const FROM_NAME = "DriverFlow";

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
                            job_type, payload_json, run_at, max_attempts, created_at, idempotency_key, source_event_id, status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
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
        const fromName = FROM_NAME;

        if (payload.event_name === 'verification_email') {
            subject = "Verifica tu cuenta - DriverFlow";
            const name = payload.name || 'Usuario';
            body = `Hola ${name},\n\nGracias por registrarte.\n\nActiva tu cuenta aquí:\n${API_URL}/verify-email?token=${payload.token}\n\nO usa el código: ${payload.token}\n(Deep Link: driverflow://verify-email?token=${payload.token})`;
        } else if (payload.event_name === 'recovery_email') {
            subject = "Restablecer Contraseña - DriverFlow";
            const name = payload.name || 'Usuario';
            body = `Hola ${name},\n\nSolicitaste recuperar tu contraseña.\n\nHaz clic aquí:\n${API_URL}/reset-password-web?token=${payload.token}\n\n(Deep Link: driverflow://reset-password?token=${payload.token})`;
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
                from: { email: fromEmail || "no-reply@driverflow.app", name: fromName },
                subject,
                content: [{ type: "text/plain", value: body }]
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            // remove suppression to see errors in DB
            throw new Error(`SendGrid Error ${res.status}: ${errText}`);
        }
    },

    async realtime_push(payload) {
        // Placeholder for SSE/Push logic
    },

    // --- WEEKLY BILLING ---
    async generate_weekly_invoices(payload) {
        const { company_id, week_start, week_end } = payload;
        if (!company_id || !week_start || !week_end) {
            logger.error('Invalid Invoice Job Payload', payload);
            return;
        }

        try {
            logger.info(`[Billing] Generating for Co:${company_id} (${week_start} - ${week_end})`);

            // 1. Calculate Usage
            // 'solicitudes' table. Range: [start, end)
            // week_end + 1 day for upper bound (exclusive)
            let start = week_start;
            let endPlusOne;
            try {
                const d = new Date(week_end);
                d.setDate(d.getDate() + 1);
                endPlusOne = d.toISOString().split('T')[0];
            } catch (e) { endPlusOne = week_end; }

            const usage = await db.get(`
                SELECT count(*) as cnt, count(distinct driver_id) as drv 
                FROM solicitudes 
                WHERE empresa_id = ? AND created_at >= ? AND created_at < ?`,
                company_id, start, endPlusOne
            );

            const total = usage ? (usage.cnt || 0) : 0;
            const drivers = usage ? (usage.drv || 0) : 0;

            // 2. Pricing Logic (Placeholder: $10 MXN per request -> 1000 cents)
            const PRICE_PER_REQ_CENTS = 1000;
            const amount = total * PRICE_PER_REQ_CENTS;

            // 3. Insert Invoice (Idempotent: Skip if exists)
            try {
                await db.run(`INSERT INTO weekly_invoices (company_id, week_start, week_end, total_requests, active_drivers, amount_cents, status, created_at) VALUES (?,?,?,?,?,?,'pending',?)`,
                    company_id, week_start, week_end, total, drivers, amount, nowIso());

                logger.info(`[Billing] Created New Invoice`);

                // 4. Emit Event usage only on creation
                await db.run(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?)`,
                    'weekly_invoice_generated', nowIso(), company_id, JSON.stringify({ week_start, week_end, total, amount }));

            } catch (e) {
                if (e.message.includes('UNIQUE') || e.message.includes('constraint')) {
                    logger.warn(`[Billing] Skipped existing invoice for Co:${company_id} Week:${week_start}`);
                    return; // Graceful exit
                }
                throw e; // Rethrow other errors
            }

        } catch (e) {
            logger.error(`[Billing] Failed for Co:${company_id}`, e);
            throw e; // Retry job
        }
    },

    async charge_weekly_invoice(payload) {
        // payload: { invoice_id } OR { company_id, week_start }
        let invoice;
        if (payload.invoice_id) {
            invoice = await db.get("SELECT w.*, c.stripe_customer_id FROM weekly_invoices w JOIN companies c ON w.company_id = c.id WHERE w.id = ?", payload.invoice_id);
        } else if (payload.company_id && payload.week_start) {
            invoice = await db.get("SELECT w.*, c.stripe_customer_id FROM weekly_invoices w JOIN companies c ON w.company_id = c.id WHERE w.company_id = ? AND w.week_start = ?", payload.company_id, payload.week_start);
        }

        if (!invoice) {
            logger.error(`[Billing Charge] Invoice not found`, payload);
            return;
        }

        const logPrefix = `[Billing Charge #${invoice.id}]`;

        // 1. Idempotency Check
        if (invoice.status === 'paid' || invoice.status === 'charging') {
            logger.info(`${logPrefix} Skipped (Status: ${invoice.status})`);
            return;
        }

        // 2. Validate Stripe Customer
        if (!invoice.stripe_customer_id) {
            const err = "Missing stripe_customer_id";
            logger.error(`${logPrefix} ${err}`);
            await db.run("UPDATE weekly_invoices SET status='failed', failure_reason=?, updated_at=? WHERE id=?", err, nowIso(), invoice.id);
            return;
        }

        if (invoice.amount_cents <= 0) {
            logger.info(`${logPrefix} Skipped (Amount 0)`);
            await db.run("UPDATE weekly_invoices SET status='paid', paid_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), invoice.id);
            return;
        }

        try {
            // 3. Mark as Charging
            await db.run("UPDATE weekly_invoices SET status='charging', updated_at=?, attempt_count = COALESCE(attempt_count, 0) + 1 WHERE id=?", nowIso(), invoice.id);

            // 4. Init Stripe
            const stripeKey = process.env.STRIPE_SECRET_KEY;
            if (!stripeKey) throw new Error("Missing STRIPE_SECRET_KEY");
            const stripe = require('stripe')(stripeKey);

            // 5. Create PaymentIntent
            logger.info(`${logPrefix} Attempting Charge: $${invoice.amount_cents / 100} to ${invoice.stripe_customer_id}`);

            const idempotencyKey = `inv_${invoice.id}_attempt_${(invoice.attempt_count || 0) + 1}`;

            const paymentIntent = await stripe.paymentIntents.create({
                amount: invoice.amount_cents,
                currency: invoice.currency || 'mxn',
                customer: invoice.stripe_customer_id,
                confirm: true,
                off_session: true, // Important for background charge
                description: `Weekly Invoice ${invoice.week_start} - ${invoice.week_end}`,
                metadata: {
                    invoice_id: invoice.id,
                    company_id: invoice.company_id,
                    week_start: invoice.week_start
                }
            }, { idempotencyKey });

            // 6. Success
            if (paymentIntent.status === 'succeeded') {
                await db.run(`
                    UPDATE weekly_invoices 
                    SET status='paid', stripe_payment_intent_id=?, paid_at=?, failure_reason=NULL, updated_at=? 
                    WHERE id=?
                `, paymentIntent.id, nowIso(), nowIso(), invoice.id);

                logger.info(`${logPrefix} SUCCESS ${paymentIntent.id}`);

                await db.run(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?)`,
                    'invoice_paid', nowIso(), invoice.company_id, JSON.stringify({ invoice_id: invoice.id, amount: invoice.amount_cents }));

            } else {
                // Should catch in error block usually, but if status is pending/requires_action
                throw new Error(`Stripe Status: ${paymentIntent.status}`);
            }

        } catch (e) {
            // 7. Failure Handling
            let reason = e.message;
            if (e.type === 'StripeCardError') {
                reason = `Declined: ${e.code}`;
            }
            logger.error(`${logPrefix} FAILED: ${reason}`);

            await db.run(`
                UPDATE weekly_invoices 
                SET status='failed', failure_reason=?, updated_at=? 
                WHERE id=?
            `, reason, nowIso(), invoice.id);

            await db.run(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?)`,
                'invoice_payment_failed', nowIso(), invoice.company_id, JSON.stringify({ invoice_id: invoice.id, reason }));
        }
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

    // --- SCHEDULER (Mondays 00:10 UTC) ---
    // Runs every Monday at 00:10 to generate invoices for the previous week
    cron.schedule('10 0 * * 1', async () => {
        logger.info('[Scheduler] Starting Weekly Invoice Generation...');
        try {
            // Calculate previous week (Monday to Sunday)
            const now = new Date();
            const lastMonday = new Date(now);
            lastMonday.setDate(now.getDate() - 7);
            const lastSunday = new Date(now);
            lastSunday.setDate(now.getDate() - 1);

            const week_start = lastMonday.toISOString().split('T')[0];
            const week_end = lastSunday.toISOString().split('T')[0]; // Inclusive

            logger.info(`[Scheduler] Targeting Week: ${week_start} to ${week_end}`);

            // Fetch all active companies
            const companies = await db.all("SELECT id FROM companies WHERE status = 'active'");

            for (const c of companies) {
                await enqueueJob('generate_weekly_invoices', {
                    company_id: c.id,
                    week_start,
                    week_end
                });
            }
            logger.info(`[Scheduler] Enqueued generation for ${companies.length} companies.`);

        } catch (e) {
            logger.error('[Scheduler] Error triggering weekly invoices', e);
        }
    });

    // --- BILLING SCHEDULER (Mondays 19:00 UTC = 14:00 EST) ---
    // Attempt to charge pending invoices
    cron.schedule('0 19 * * 1', async () => {
        logger.info('[Scheduler] Starting Automatic Billing Execution...');
        try {
            // Select all PENDING invoices
            // Safety cap of 500 to avoid clogging, though we expect fewer active clients for MVP
            const pendingInvoices = await db.all("SELECT id FROM weekly_invoices WHERE status = 'pending' LIMIT 500");

            for (const inv of pendingInvoices) {
                await enqueueJob('charge_weekly_invoice', { invoice_id: inv.id });
            }
            logger.info(`[Scheduler] Enqueued charges for ${pendingInvoices.length} invoices.`);
        } catch (e) {
            logger.error('[Scheduler] Error triggering billing charges', e);
        }
    });

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

// --- SELF-EXECUTION ---
if (require.main === module) {
    require('./env_guard').validateEnv({ role: 'worker' });
    startQueueWorker().catch(err => {
        logger.error('FATAL: Worker Failed', err);
        process.exit(1);
    });
}

module.exports = { startQueueWorker, enqueueJob, bridgeOutbox };
