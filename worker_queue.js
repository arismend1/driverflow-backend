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
            INSERT INTO jobs_queue (job_type, payload_json, run_at, max_attempts, created_at, idempotency_key, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
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

            if (ev.event_name === 'verification_email' || ev.event_name === 'recovery_email' || ev.event_name === 'lead_invitation_email') {
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
        const apiKey = process.env.RESEND_API_KEY;
        const fromEmail = process.env.EMAIL_FROM || "onboarding@resend.dev";
        const fromName = FROM_NAME;

        if (!apiKey) {
            if (dryRun) { logger.info('DRY RUN MISSING KEY', payload); return; }
            throw new Error('Missing RESEND_API_KEY');
        }

        const appBaseUrl = process.env.APP_BASE_URL || API_URL;

        let subject = "DriverFlow Notification";
        let textBody = "Notification";
        let htmlBody = "<p>Notification</p>";

        if (payload.event_name === 'verification_email') {
            subject = "Confirma tu correo - DriverFlow";
            const name = payload.name || 'Usuario';
            const verifyLink = `${appBaseUrl}/verify-email?token=${payload.token}`;

            textBody = `Hola ${name},\n\nGracias por registrarte.\n\nActiva tu cuenta aquí:\n${verifyLink}\n\nO usa el código: ${payload.token}\n(Deep Link: driverflow://verify-email?token=${payload.token})`;
            htmlBody = `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
                    <h2>¡Bienvenido a DriverFlow, ${name}!</h2>
                    <p>Gracias por registrarte. Para comenzar, por favor confirma tu dirección de correo electrónico.</p>
                    <a href="${verifyLink}" style="display: inline-block; padding: 12px 24px; background-color: #007BFF; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;">Confirmar Mi Correo</a>
                    <p>O ingresa este código manualmente: <strong>${payload.token}</strong></p>
                    <p style="font-size: 12px; color: #888;">Si no solicitaste esto, puedes ignorar este correo.</p>
                </div>
            `;
        } else if (payload.event_name === 'recovery_email') {
            subject = "Restablecer Contraseña - DriverFlow";
            const name = payload.name || 'Usuario';
            const resetLink = `${appBaseUrl}/reset-password-web?token=${payload.token}`;

            textBody = `Hola ${name},\n\nSolicitaste recuperar tu contraseña.\n\nHaz clic aquí:\n${resetLink}\n\n(Deep Link: driverflow://reset-password?token=${payload.token})`;
            htmlBody = `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
                    <h2>Restablecer Contraseña</h2>
                    <p>Hola ${name},</p>
                    <p>Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en DriverFlow.</p>
                    <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;">Restablecer Contraseña</a>
                    <p style="font-size: 12px; color: #888;">Si no solicitaste esto, no es necesario realizar ninguna acción.</p>
                </div>
            `;
        } else if (payload.event_name === 'lead_invitation_email') {
            const name = payload.name || 'Conductor';
            const company = payload.company_name || 'Una empresa';
            subject = 'Una empresa quiere trabajar contigo en DriverFlow';

            textBody = `Hola ${name},\n\n${company} en DriverFlow quiere contactarte para oportunidades de trabajo.\n\nRegístrate aquí para ver la oportunidad:\n\nhttps://driverflow.app/register\n\n¡Te esperamos!\n— Equipo DriverFlow`;
            htmlBody = `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
                    <h2>¡Nueva oportunidad en DriverFlow!</h2>
                    <p>Hola ${name},</p>
                    <p>La empresa <strong>${company}</strong> está interesada en contactarte para nuevas oportunidades de trabajo.</p>
                    <a href="https://driverflow.app/register" style="display: inline-block; padding: 12px 24px; background-color: #007BFF; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;">Ver Oportunidad y Registrarse</a>
                    <p style="font-size: 12px; color: #888;">¡Te esperamos!</p>
                </div>
            `;
        }

        if (dryRun) {
            logger.info(`[DRY RUN] Sending Email via Resend to ${payload.email}: ${subject}`);
            return;
        }

        const { Resend } = require('resend');
        const resend = new Resend(apiKey);

        const { data, error } = await resend.emails.send({
            from: `${fromName} <${fromEmail}>`,
            to: [payload.email],
            subject: subject,
            text: textBody,
            html: htmlBody,
        });

        if (error) {
            throw new Error(`Resend Error: ${error.message || JSON.stringify(error)}`);
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
                FROM tickets 
                WHERE company_id = ? AND created_at >= ? AND created_at < ? AND billing_status = 'billable'`,
                company_id, start, endPlusOne
            );

            const total = usage ? (usage.cnt || 0) : 0;
            const drivers = usage ? (usage.drv || 0) : 0;

            // 2. Pricing Logic (150 USD per ticket -> 15000 cents)
            const PRICE_PER_TICKET_CENTS = 15000;
            const amount = total * PRICE_PER_TICKET_CENTS;

            // 3. Insert Invoice (Idempotent by uniqueness constraints, though we should ideally use ON CONFLICT)
            try {
                const billing_week = `${week_start} to ${week_end}`;
                
                // Calculate due date (7 days from now)
                const issueDate = new Date();
                const dueDate = new Date(issueDate);
                dueDate.setDate(dueDate.getDate() + 7);
                
                await db.run(
                    `INSERT INTO invoices (
                        company_id, 
                        billing_week, 
                        issue_date, 
                        due_date, 
                        subtotal_cents, 
                        total_cents, 
                        currency, 
                        status, 
                        created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'USD', 'pending', ?)`,
                    company_id, 
                    billing_week, 
                    issueDate.toISOString(), 
                    dueDate.toISOString(), 
                    amount, 
                    amount, 
                    nowIso()
                );

                logger.info(`[Billing] Created New Invoice`);

                // 4. Emit Event usage only on creation
                await db.run(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?)`,
                    'weekly_invoice_generated', nowIso(), company_id, JSON.stringify({ billing_week, total_requests: total, amount, currency: 'USD' }));

                // --- HOOK: Push Notification ---
                try {
                    const { sendPush } = require('./notifications_service');
                    await sendPush(company_id, "New Invoice", "You have a new invoice ready to pay");
                } catch (pushErr) {
                    logger.error(`[Billing] Push fail for Co:${company_id}: ${pushErr.message}`);
                }
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
        const { invoice_id } = payload;

        // 1. Worker Startup & Config Validation (Fail Fast)
        // Note: Ideally this is checked once at startup, but doing it here ensures safety per job
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        // VALIDATION MOVED TO GLOBAL SCOPE FOR FATAL STARTUP, but checked here too just in case
        if (!stripeKey || !stripeKey.startsWith('sk_')) {
            throw new Error("FATAL: STRIPE_SECRET_KEY invalid in job execution");
        }

        // 2. Fetch Invoice
        // Support payload flexibility if rescheduled
        let invoice;
        if (invoice_id) {
            invoice = await db.get("SELECT w.*, c.stripe_customer_id FROM invoices w JOIN empresas c ON w.company_id = c.id WHERE w.id = ?", invoice_id);
        } else if (payload.company_id && payload.week_start) {
            invoice = await db.get("SELECT w.*, c.stripe_customer_id FROM invoices w JOIN empresas c ON w.company_id = c.id WHERE w.company_id = ? AND w.week_start = ?", payload.company_id, payload.week_start);
        }

        if (!invoice) {
            logger.error(`[Billing Charge] Invoice not found`, payload);
            return;
        }

        const logPrefix = `[Billing Charge #${invoice.id}]`;

        // 3. Strict Idempotency Check (DB Level)
        // Strict Dunning Check
        if (['charged', 'charging', 'suspended'].includes(invoice.status)) {
            logger.info(`${logPrefix} Skipped: Invoice status is ${invoice.status}`);
            return;
        }

        // Lock the row to prevent race conditions during retry/processing
        // Using basic optimistic update 
        const lockRes = await db.run(`
            UPDATE invoices 
            SET status='charging', updated_at=? 
            WHERE id=? AND status IN ('pending', 'retrying', 'failed')
        `, nowIso(), invoice.id);

        // Verification mechanism compatible with sqlite/pg adapter abstraction. 
        // We fetch again to confirm if we locked it (in generic adapters where CHANGES isn't universally surfaced)
        const lockedInvoice = await db.get("SELECT status FROM invoices WHERE id=?", invoice.id);
        if (!lockedInvoice || lockedInvoice.status !== 'charging') {
            logger.warn(`${logPrefix} Failed to lock invoice for charging. Race condition avoided.`);
            return;
        }

        // 4. Validate Data
        if (!invoice.stripe_customer_id) {
            const err = "Missing stripe_customer_id";
            logger.error(`${logPrefix} ${err}`);
            await db.run("UPDATE invoices SET status='failed', failure_reason=?, updated_at=? WHERE id=?", err, nowIso(), invoice.id);
            return;
        }

        if (invoice.amount_cents <= 0) {
            logger.info(`${logPrefix} Auto-closing $0 invoice`);
            await db.run("UPDATE invoices SET status='charged', paid_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), invoice.id);
            return;
        }

        const stripe = require('stripe')(stripeKey);
        const isLive = stripeKey.startsWith('sk_live_');
        logger.info(`${logPrefix} Processing Charge: $${invoice.amount_cents / 100} (Live: ${isLive})`);

        // 5. Idempotency Key & Create-or-Confirm Logic
        const idempotencyKey = `invoice_${invoice.id}_charge`;
        let paymentIntent;

        try {
            // Optimistic Lock - This was moved above to prevent race conditions earlier.
            // The status is already 'charging' from the lock mechanism.

            if (invoice.stripe_payment_intent_id) {
                logger.info(`${logPrefix} Retrieving existing PI: ${invoice.stripe_payment_intent_id}`);
                paymentIntent = await stripe.paymentIntents.retrieve(invoice.stripe_payment_intent_id, {
                    expand: ['latest_charge']
                });
            } else {
                logger.info(`${logPrefix} Creating new PI with key: ${idempotencyKey}`);
                paymentIntent = await stripe.paymentIntents.create({
                    amount: invoice.amount_cents,
                    currency: invoice.currency || 'usd',
                    customer: invoice.stripe_customer_id,
                    confirm: true, // Try to charge immediately
                    off_session: true,
                    expand: ['latest_charge'],
                    description: `Weekly Invoice ${invoice.week_start} - ${invoice.week_end}`,
                    metadata: {
                        invoice_id: invoice.id,
                        company_id: invoice.company_id,
                        week_start: invoice.week_start,
                        env: process.env.NODE_ENV
                    }
                }, { idempotencyKey });
            }

            // Save PI ID immediately if new to allow robust inverse reconciliation in Webhook
            if (!invoice.stripe_payment_intent_id && paymentIntent.id) {
                await db.run(
                    "UPDATE invoices SET stripe_payment_intent_id=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND stripe_payment_intent_id IS NULL",
                    paymentIntent.id, invoice.id
                );
                invoice.stripe_payment_intent_id = paymentIntent.id;
            }

            // Retry/Confirm if needed
            if (paymentIntent.status !== 'succeeded' && paymentIntent.status !== 'processing') {
                logger.info(`${logPrefix} PI ${paymentIntent.id} is ${paymentIntent.status}, attempting confirm...`);
                paymentIntent = await stripe.paymentIntents.confirm(paymentIntent.id, {
                    off_session: true
                });
            }

            // (PI Id saving was moved above for guaranteed bottom-up reconciliation)

        } catch (e) {
            // Capture PI ID from error if available
            if (e.raw && e.raw.payment_intent) {
                const piId = e.raw.payment_intent.id;
                await db.run("UPDATE invoices SET stripe_payment_intent_id=? WHERE id=?", piId, invoice.id);
            }
            const reason = e.message || 'Unknown Stripe Error';
            let isDecline = false;
            let stripeCode = 'unknown';

            if (e.type === 'StripeCardError') {
                isDecline = true;
                stripeCode = e.code || 'card_declined';
            } else if (e.type) {
                stripeCode = e.type;
            }

            logger.error(`${logPrefix} Stripe Error: ${reason} (Code: ${stripeCode})`);

            // DUNNING LOGIC: Increment attempt, determine next status and backoff
            const newAttemptCount = (invoice.attempt_count || 0) + 1;
            let nextStatus = 'failed';
            let nextRetryAt = null;
            let suspendedAt = null;

            if (newAttemptCount >= MAX_ATTEMPTS) {
                nextStatus = 'suspended';
                suspendedAt = nowIso();
                await notifyPaymentSuspended(invoice);
            } else {
                nextStatus = (isDecline || ['StripeConnectionError', 'StripeAPIError'].includes(e.type)) ? 'retrying' : 'failed';
                // Backoff logic: +24h, +48h... (simplified to 24 * attempt hours for now)
                const delayMs = 24 * 60 * 60 * 1000 * Math.pow(2, newAttemptCount - 1);
                nextRetryAt = new Date(Date.now() + delayMs).toISOString();
                await notifyPaymentFailed(invoice, newAttemptCount, MAX_ATTEMPTS, reason);
            }

            await db.run(`
                UPDATE invoices 
                SET status=? 
                WHERE id=?
            `, nextStatus, invoice.id);

            // Audit
            await db.run(`
                INSERT INTO invoice_attempts 
                (invoice_id, attempt_number, status, stripe_payment_intent_id, error_code, error_message, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, invoice.id, newAttemptCount, nextStatus, invoice.stripe_payment_intent_id, stripeCode, reason, nowIso());

            return;
        }

        // 6. Success
        if (paymentIntent && paymentIntent.status === 'succeeded') {
            let chargeId = null;
            let receiptUrl = null;

            if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object') {
                chargeId = paymentIntent.latest_charge.id;
                receiptUrl = paymentIntent.latest_charge.receipt_url;
            } else if (typeof paymentIntent.latest_charge === 'string') {
                // FALLBACK VITAL: Si Stripe ignoró el expand, pedir el objeto real directo de su SDK:
                chargeId = paymentIntent.latest_charge;
                try {
                    const fullCharge = await stripe.charges.retrieve(chargeId);
                    receiptUrl = fullCharge.receipt_url;
                } catch (e) { logger.warn(`${logPrefix} Failed to retrieve missing expanded charge ${chargeId}`); }
            } else if (paymentIntent.charges && paymentIntent.charges.data.length > 0) {
                chargeId = paymentIntent.charges.data[0].id;
                receiptUrl = paymentIntent.charges.data[0].receipt_url;
            }

            await db.run(`
                UPDATE invoices 
                SET status='charged', stripe_payment_intent_id=?, paid_at=?, failure_reason=NULL, 
                    stripe_charge_id=COALESCE(stripe_charge_id, ?), receipt_url=COALESCE(receipt_url, ?), updated_at=? 
                WHERE id=?
            `, paymentIntent.id, chargeId, receiptUrl, nowIso(), nowIso(), invoice.id);

            logger.info(`${logPrefix} SUCCESS: Charged ${paymentIntent.id}`);

            // Audit Success
            const successAttempt = (invoice.attempt_count || 0) + 1;
            await db.run(`
                INSERT INTO invoice_attempts 
                (invoice_id, attempt_number, status, stripe_payment_intent_id, created_at)
                VALUES (?, ?, ?, ?, ?)
            `, invoice.id, successAttempt, 'charged', paymentIntent.id, nowIso());

            await db.run(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?)`,
                'invoice_paid', nowIso(), invoice.company_id, JSON.stringify({ invoice_id: invoice.id, amount: invoice.amount_cents, stripe_pi: paymentIntent.id }));
        } else {
            // If we reach here, it means the paymentIntent was not 'succeeded' after creation/confirmation,
            // but also didn't throw an error. This is an unexpected state for a 'confirm: true' flow.
            // We should treat this as a failure and let the dunning logic handle retries.
            const status = paymentIntent ? paymentIntent.status : 'unknown';
            logger.warn(`${logPrefix} Unexpected PI Status: ${status}. Treating as failure.`);
            // Re-throw to trigger the catch block for dunning logic
            throw new Error(`Stripe PI in unexpected status: ${status}`);
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
    // --- SCHEDULER (Mondays 00:10 UTC -> 10:00 AM EST? No, user wants Lunes 14:00 EST for billing, maybe Lunes early for generation?)
    // Let's keep generation early Monday, but make it timezone aware just to be safe.
    // User only specified 14:00 EST for Billing. Generation can be earlier.
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
            const companies = await db.all("SELECT id FROM empresas WHERE account_state = 'ACTIVE'");

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
    // 2. Billing: Cobro principal
    cron.schedule('0 14 * * 1', async () => {
        logger.info('[Scheduler] Starting Automatic Billing Execution...');
        try {
            const invoices = await db.all("SELECT id FROM invoices WHERE status IN ('pending', 'failed') AND amount_cents > 0");
            for (const inv of invoices) {
                await enqueueJob('charge_weekly_invoice', { invoice_id: inv.id });
            }
            logger.info(`[Scheduler] Enqueued charges for ${invoices.length} invoices.`);
        } catch (e) {
            logger.error('[Scheduler] Error starting billing', e);
        }
    }, {
        scheduled: true,
        timezone: "America/New_York"
    });

    // 3. Dunning: Reintentos Inteligentes (Se revisa cada 1 hora)
    cron.schedule('0 * * * *', async () => {
        logger.info('[Scheduler] Checking Dunning / Retries...');
        try {
            // Reintentar 'retrying' o 'failed' (si se forzó) que ya hayan pasado la barrera de tiempo.
            // SQLite/PG compatible timestamp string compare
            const querySelect = `
                SELECT id FROM invoices 
                WHERE status IN ('failed', 'retrying') 
            `;
            console.log("[Scheduler][Dunning] Executing query:", querySelect);
            const invoices = await db.all(querySelect);

            for (const inv of invoices) {
                logger.info(`[Dunning] Enqueuing retry for invoice ${inv.id}`);
                await enqueueJob('charge_weekly_invoice', { invoice_id: inv.id });
            }
            if (invoices.length > 0) logger.info(`[Dunning] Enqueued ${invoices.length} invoices for retry.`);
        } catch (err) {
            console.error("[Scheduler][Dunning] PG ERROR", {
                message: err.message,
                code: err.code,
                column: err.column,
                table: err.table,
                schema: err.schema,
                position: err.position,
                detail: err.detail,
                where: err.where
            });
        }
    });

    // --- AUTO-MATCHMAKING SCHEDULER — DISABLED (now on-demand via lazy_matching.js) ---
    // Matches are generated lazily when users open /matches/opportunities or /matches/candidates.
    // cron.schedule('*/5 * * * *', () => {
    //     logger.info('[Scheduler] Triggering Auto-Matchmaking script...');
    //     const { exec } = require('child_process');
    //     exec('node run_matching.js', (error, stdout, stderr) => {
    //         if (error) { logger.error(`[Scheduler] Error: ${error.message}`); return; }
    //         if (stderr) { logger.warn(`[Scheduler] Warning: ${stderr}`); }
    //         logger.info(`[Scheduler] Success:\n${stdout}`);
    //     });
    // });

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

    // FATAL CHECK FOR STRIPE KEY
    const sk = process.env.STRIPE_SECRET_KEY;
    if (!sk || !sk.startsWith('sk_')) {
        console.error("FATAL: STRIPE_SECRET_KEY is missing or invalid (must start with 'sk_'). Worker refusing to start.");
        process.exit(1);
    }

    // Stripe payment reconciliation (every 15 minutes)
    const { reconcileStripePayments } = require('./reconcile_stripe_payments');
    const RECONCILE_INTERVAL = 15 * 60 * 1000; // 15 minutes

    setInterval(async () => {
        try {
            await reconcileStripePayments();
        } catch (e) {
            console.error('[Worker] Reconciler error:', e.message);
        }
    }, RECONCILE_INTERVAL);

    // Run once at startup after 30s delay
    setTimeout(() => reconcileStripePayments().catch(e => console.error('[Worker] Initial reconcile error:', e.message)), 30000);

    // Match expiration (every 1 hour)
    const { expireOldMatches } = require('./expire_old_matches');
    const EXPIRE_INTERVAL = 60 * 60 * 1000; // 1 hour

    setInterval(async () => {
        try {
            await expireOldMatches();
        } catch (e) {
            console.error('[Worker] Expirer error:', e.message);
        }
    }, EXPIRE_INTERVAL);

    // Run once at startup after 60s delay
    setTimeout(() => expireOldMatches().catch(e => console.error('[Worker] Initial expire error:', e.message)), 60000);

    // Match cleanup/retention (every 1 hour)
    const { cleanupOldMatches } = require('./cleanup_old_matches');
    const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

    setInterval(async () => {
        try {
            await cleanupOldMatches();
        } catch (e) {
            console.error('[Worker] Cleanup error:', e.message);
        }
    }, CLEANUP_INTERVAL);

    // Run once at startup after 90s delay
    setTimeout(() => cleanupOldMatches().catch(e => console.error('[Worker] Initial cleanup error:', e.message)), 90000);

    // Search expiration (every 10 minutes)
    const SEARCH_EXPIRE_INTERVAL = 10 * 60 * 1000; // 10 minutes

    async function expireSearches() {
        try {
            const r1 = await db.run(
                `UPDATE drivers SET search_status='OFF' WHERE search_status='ON' AND search_expires_at IS NOT NULL AND search_expires_at <= NOW()`
            );
            const r2 = await db.run(
                `UPDATE empresas SET search_status='OFF' WHERE search_status='ON' AND search_expires_at IS NOT NULL AND search_expires_at <= NOW()`
            );
            const d = (r1.rowCount || 0) + (r2.rowCount || 0);
            console.log(`[Programador][SearchExpiration] Expiration check executed${d > 0 ? ` — expired ${d}` : ''}`);
        } catch (e) {
            console.error('[Programador][SearchExpiration] Error:', e.message);
        }
    }

    setInterval(expireSearches, SEARCH_EXPIRE_INTERVAL);
    setTimeout(expireSearches, 120000); // Run once at startup after 2 min

    // Daily lead invitation (every 24 hours)
    const DAILY_INVITE_INTERVAL = 24 * 60 * 60 * 1000;

    async function runDailyLeadInvites() {
        try {
            console.log('[LeadInviteWorker] scanning leads');

            const leads = await db.all(
                `SELECT id, email, name, company_id FROM driver_leads
                 WHERE email IS NOT NULL AND email <> ''
                   AND status IN ('NEW','INVITED')
                   AND is_synthetic = false
                   AND (invite_count IS NULL OR invite_count < 5)
                   AND (invited_at IS NULL OR invited_at < NOW() - INTERVAL '7 days')
                 LIMIT 50`
            );

            if (leads.length === 0) {
                console.log('[LeadInviteWorker] no eligible leads found');
                return;
            }

            console.log(`[LeadInviteWorker] inviting ${leads.length} leads`);
            const now = new Date().toISOString();

            for (const lead of leads) {
                try {
                    await db.run(
                        `UPDATE driver_leads SET status='INVITED', invited_at=NOW(), invite_count=COALESCE(invite_count,0)+1, updated_at=NOW() WHERE id=?`,
                        lead.id
                    );

                    const { trackLeadFunnelEvent } = require('./analytics');
                    await trackLeadFunnelEvent('lead_invited', { lead_id: lead.id, company_id: lead.company_id, metadata: { source: "daily_worker" } });

                    // Fetch company name for email
                    let companyName = 'Una empresa';
                    if (lead.company_id) {
                        const co = await db.get('SELECT nombre FROM empresas WHERE id=?', lead.company_id);
                        if (co) companyName = co.nombre;
                    }

                    await db.run(
                        `INSERT INTO events_outbox (request_id, event_name, created_at, company_id, metadata) VALUES (?,?,?,?,?)`,
                        `daily_invite_${lead.id}`, 'lead_invitation_email', now, lead.company_id || 0,
                        JSON.stringify({ lead_id: lead.id, company_id: lead.company_id, company_name: companyName, email: lead.email, name: lead.name || 'Conductor' })
                    );
                } catch (e) {
                    console.error(`[LeadInviteWorker] Error inviting lead ${lead.id}:`, e.message);
                }
            }

            console.log(`[LeadInviteWorker] done invited=${leads.length}`);
        } catch (e) {
            console.error('[LeadInviteWorker] Fatal error:', e.message);
        }
    }

    setInterval(runDailyLeadInvites, DAILY_INVITE_INTERVAL);
    setTimeout(runDailyLeadInvites, 180000); // Run once at startup after 3 min

    startQueueWorker().catch(err => {
        logger.error('FATAL: Worker Failed', err);
        process.exit(1);
    });
}

module.exports = { startQueueWorker, enqueueJob, bridgeOutbox };
