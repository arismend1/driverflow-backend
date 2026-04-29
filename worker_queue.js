const cron = require('node-cron');
const crypto = require('crypto');
const db = require('./db_adapter'); // Async Adapter
const logger = require('./logger');
const time = require('./time_contract');
const { getStripe } = require('./stripe_client');
const { createInvoiceSchemaHelpers } = require('./invoice_schema_helpers');

const WORKER_ID = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const POLL_INTERVAL = 2000;
const BATCH_SIZE = 5;

// Wrapper for compatibility
const nowIso = () => time.nowIso({ ctx: 'worker_queue' });
const API_URL = process.env.API_URL || "https://driverflow-backend.onrender.com";
const FROM_NAME = "DriverFlow";
const {
    getTableColumns,
    ensureInvoiceDunningRescueColumns,
    updateInvoiceRetryState,
    markInvoiceCharged
} = createInvoiceSchemaHelpers({
    db,
    nowIso,
    warn: (message) => logger.warn(message),
    safeTables: ['invoices', 'empresas']
});

let billingNotifications = {};
try {
    billingNotifications = require('./src/notifications');
} catch (err) {
    logger.warn(`[Billing Notify] Notifications module unavailable: ${err.message}`);
}

async function notifyPaymentFailedSafe(invoice, attempt, maxAttempts, errorMsg) {
    if (typeof billingNotifications.notifyPaymentFailed !== 'function') {
        logger.warn(`[Billing Notify] notifyPaymentFailed unavailable for invoice ${invoice?.id || 'unknown'}`);
        return;
    }

    try {
        await billingNotifications.notifyPaymentFailed(invoice, attempt, maxAttempts, errorMsg);
    } catch (err) {
        logger.warn(`[Billing Notify] notifyPaymentFailed failed for invoice ${invoice?.id || 'unknown'}: ${err.message}`);
    }
}

async function notifyPaymentSuspendedSafe(invoice) {
    if (typeof billingNotifications.notifyPaymentSuspended !== 'function') {
        logger.warn(`[Billing Notify] notifyPaymentSuspended unavailable for invoice ${invoice?.id || 'unknown'}`);
        return;
    }

    try {
        await billingNotifications.notifyPaymentSuspended(invoice);
    } catch (err) {
        logger.warn(`[Billing Notify] notifyPaymentSuspended failed for invoice ${invoice?.id || 'unknown'}: ${err.message}`);
    }
}

async function getUsablePaymentMethodForCustomer(stripe, customerId) {
    if (!stripe || !customerId) return null;

    const customer = await stripe.customers.retrieve(customerId, {
        expand: ['invoice_settings.default_payment_method']
    });

    const defaultPm = customer?.invoice_settings?.default_payment_method;
    if (defaultPm) {
        return typeof defaultPm === 'string' ? defaultPm : defaultPm.id || null;
    }

    const paymentMethods = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
        limit: 1
    });

    return paymentMethods?.data?.[0]?.id || null;
}

async function resolveOffSessionPaymentMethod(stripe, invoice) {
    if (invoice?.company_stripe_payment_method_id) {
        return invoice.company_stripe_payment_method_id;
    }

    if (invoice?.stripe_customer_id) {
        return await getUsablePaymentMethodForCustomer(stripe, invoice.stripe_customer_id);
    }

    return null;
}

async function finalizeChargeFailure(invoice, {
    reason,
    stripeCode = 'unknown',
    errorType = null,
    maxAttempts = 3,
    forceStatus = null
}) {
    const invoiceColumns = await getTableColumns('invoices');
    const newAttemptCount = (invoice.attempt_count || 0) + 1;
    const isRetryable = errorType === 'StripeCardError' ||
        ['StripeConnectionError', 'StripeAPIError'].includes(errorType);
    let nextStatus = 'failed';

    if (forceStatus) {
        nextStatus = forceStatus;
    } else if (newAttemptCount >= maxAttempts) {
        nextStatus = 'suspended';
    } else if (isRetryable) {
        nextStatus = 'retrying';
    }

    const delaySec = 5 * Math.pow(2, newAttemptCount - 1);
    const nowMs = time.nowMs({ ctx: 'invoice_retry_calc' });
    const nextRetryAt = nextStatus === 'retrying'
        ? new Date(nowMs + delaySec * 1000).toISOString()
        : null;

    const tx = await db.beginTransaction();
    try {
        await updateInvoiceRetryState(invoice.id, {
            status: nextStatus,
            failureReason: reason,
            attemptCount: newAttemptCount,
            lastAttemptAt: nowIso(),
            nextRetryAt,
            suspendedAt: nextStatus === 'suspended' ? nowIso() : null,
            updatedAt: nowIso()
        }, tx);

        const extraAssignments = [];
        const extraParams = [];
        if (invoiceColumns.last_error) {
            extraAssignments.push('last_error = ?');
            extraParams.push(reason);
        }
        if (invoiceColumns.last_error_code) {
            extraAssignments.push('last_error_code = ?');
            extraParams.push(stripeCode);
        }
        if (invoiceColumns.last_error_message) {
            extraAssignments.push('last_error_message = ?');
            extraParams.push(reason);
        }
        if (invoiceColumns.stripe_error_code) {
            extraAssignments.push('stripe_error_code = ?');
            extraParams.push(stripeCode);
        }
        if (extraAssignments.length > 0) {
            extraParams.push(invoice.id);
            await tx.run(`UPDATE invoices SET ${extraAssignments.join(', ')} WHERE id = ?`, ...extraParams);
        }

        if (nextStatus === 'suspended') {
            await tx.run("UPDATE empresas SET search_status = 'OFF', billing_suspended = true WHERE id = ?", invoice.company_id);
        }

        await tx.run(`
            INSERT INTO invoice_attempts 
            (invoice_id, attempt_number, status, stripe_payment_intent_id, error_code, error_message, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, invoice.id, newAttemptCount, nextStatus, invoice.stripe_payment_intent_id || null, stripeCode, reason, nowIso());

        await tx.commit();
    } catch (txErr) {
        await tx.rollback();
        throw txErr;
    }

    if (nextStatus === 'suspended') {
        await notifyPaymentSuspendedSafe(invoice);
    } else {
        await notifyPaymentFailedSafe(invoice, newAttemptCount, maxAttempts, reason);
    }
}

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
        if (e.code === '23505' || e.message.toUpperCase().includes('UNIQUE')) return false; // Idempotent ignore
        throw e;
    }
}

// --- BRIDGE: Outbox -> Queue ---
async function bridgeOutbox() {
    const now = nowIso();

    // Atomic Bridge Transaction using the official beginTransaction helper
    const tx = await db.beginTransaction();
    try {
        // Select pending (limit 50 to avoid big transactions)
        const rows = await tx.all(`
            SELECT id, event_name, metadata, audience_type, audience_id, event_key 
            FROM events_outbox 
            WHERE queue_status = 'pending' 
            LIMIT 50
        `);

        if (rows.length === 0) {
            await tx.commit();
            return;
        }

        const ids = rows.map(r => r.id);

        // Mark as 'queued' immediately with defensive check
        const idList = ids.join(',');
        await tx.run(`UPDATE events_outbox SET queue_status = 'queued', queued_at = ? WHERE id IN (${idList}) AND queue_status = 'pending'`, now);

        // Re-fetch only those successfully queued by this transaction to avoid duplicates
        // Note: For PG, we could use RETURNING, but for cross-compatibility we re-select
        const confirmedRows = await tx.all(`SELECT * FROM events_outbox WHERE id IN (${idList}) AND queue_status = 'queued' AND queued_at = ?`, now);

        for (const ev of confirmedRows) {
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
                    await tx.run(`
                        INSERT INTO jobs_queue (
                            job_type, payload_json, run_at, max_attempts, created_at, idempotency_key, source_event_id, status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
                    `, jobType, JSON.stringify(payload), now, 5, now, ev.event_key || null, ev.id);
                } catch (err) {
                    if (err.message.toUpperCase().includes('UNIQUE')) {
                        logger.warn(`Skip duplicate job for event ${ev.id}`);
                    } else {
                        throw err;
                    }
                }
            }
        }

        await tx.commit();

    } catch (e) {
        await tx.rollback();
        if (!e.message.includes('busy')) logger.error('Bridge Outbox Error', e);
        return;
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

    // --- BILLING GENERATION ---
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
                SELECT count(*) as cnt, count(distinct driver_id) as drv, SUM(price_cents) as total_price
                FROM tickets 
                WHERE company_id = ? AND created_at >= ? AND created_at < ? 
                  AND billing_status = 'unbilled'
                  AND price_cents IS NOT NULL AND price_cents > 0`,
                company_id, start, endPlusOne
            );

            const total = usage ? (usage.cnt || 0) : 0;
            const amount = usage ? (usage.total_price || 0) : 0;


            // 3. Insert Invoice (Idempotent by uniqueness constraints, though we should ideally use ON CONFLICT)
            try {
                const billing_week = `${week_start} to ${week_end}`;
                const issueDate = new Date();
                const dueDate = new Date(issueDate);
                dueDate.setDate(dueDate.getDate() + 7);

                const tx = await db.beginTransaction();
                let activeTx = true;

                try {
                    const insertInvoiceParams = [ company_id, week_start, week_end, billing_week, issueDate.toISOString(), dueDate.toISOString(), amount, amount, nowIso(), nowIso() ];
                    const insertResult = await tx.run(`
                        INSERT INTO invoices (
                            company_id, week_start, week_end, billing_week, issue_date, due_date, subtotal_cents, total_cents, currency, status, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'pending', ?, ?)
                    ` + (db.IS_POSTGRES ? ' RETURNING id' : ''), ...insertInvoiceParams);

                    const newInvoiceId = (insertResult.rows && insertResult.rows[0]) ? insertResult.rows[0].id : insertResult.lastInsertRowid;

                    if (newInvoiceId) {
                        await tx.run(`
                            INSERT INTO invoice_items (invoice_id, ticket_id, price_cents)
                            SELECT ?, id, price_cents
                            FROM tickets 
                            WHERE company_id = ? AND created_at >= ? AND created_at < ? 
                              AND billing_status = 'unbilled'
                               AND NOT EXISTS (
                                SELECT 1 FROM invoice_items ii WHERE ii.ticket_id = tickets.id
                              )
                        `, newInvoiceId, company_id, start, endPlusOne);

                        // Mark tickets as invoiced in the SAME transaction
                        await tx.run(`
                            UPDATE tickets SET billing_status = 'invoiced'
                            WHERE company_id = ? AND created_at >= ? AND created_at < ? 
                              AND billing_status = 'unbilled'
                              AND EXISTS (
                                SELECT 1 FROM invoice_items ii 
                                WHERE ii.ticket_id = tickets.id AND ii.invoice_id = ?
                              )
                        `, company_id, start, endPlusOne, newInvoiceId);

                        const itemsCount = await tx.get("SELECT COUNT(*) as c FROM invoice_items WHERE invoice_id = ?", newInvoiceId);
                        const count = itemsCount ? Number(itemsCount.c) : 0;


                        if (count === 0) {
                            await tx.run("DELETE FROM invoices WHERE id = ?", newInvoiceId);
                            await tx.commit();
                            activeTx = false;
                            logger.warn(`[Billing] Voided empty invoice ${newInvoiceId} for Co:${company_id} (tickets verified out of scope)`);
                            return;
                        }
                    }

                    await tx.commit();
                    activeTx = false;
                    logger.info(`[Billing] Created New Invoice ${newInvoiceId} successfully.`);

                } catch (txErr) {
                    if (activeTx) await tx.rollback();
                    throw txErr;
                }

                // 4. Emit Event usage only on creation
                await db.run(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?)`,
                    'weekly_invoice_generated', nowIso(), company_id, JSON.stringify({ billing_week, total_requests: total, amount, currency: 'USD' }));

                // --- HOOK: Push Notification ---
                try {
                    const { sendPush } = require('./notifications_service');
                    await sendPush(company_id, 'empresa', "New Invoice", "You have a new invoice ready to pay");
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
        const empresaColumns = await getTableColumns('empresas');
        const companyEmailExpr = db.IS_POSTGRES ? "COALESCE(c.email, c.contacto)" : "c.contacto";
        const companyPaymentMethodExpr = empresaColumns.stripe_payment_method_id
            ? "c.stripe_payment_method_id AS company_stripe_payment_method_id,"
            : "NULL AS company_stripe_payment_method_id,";
        if (invoice_id) {
            invoice = await db.get(`SELECT w.*, c.stripe_customer_id, ${companyPaymentMethodExpr} ${companyEmailExpr} AS company_email, c.nombre AS company_name FROM invoices w JOIN empresas c ON w.company_id = c.id WHERE w.id = ?`, invoice_id);
        } else if (payload.company_id && payload.week_start) {
            invoice = await db.get(`SELECT w.*, c.stripe_customer_id, ${companyPaymentMethodExpr} ${companyEmailExpr} AS company_email, c.nombre AS company_name FROM invoices w JOIN empresas c ON w.company_id = c.id WHERE w.company_id = ? AND w.week_start = ?`, payload.company_id, payload.week_start);
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

        const stripe = getStripe();
        if (!stripe) {
            throw new Error("FATAL: Stripe client unavailable in job execution");
        }
        const isLive = stripeKey.startsWith('sk_live_');
        logger.info(`${logPrefix} Processing Charge: $${invoice.total_cents / 100} (Live: ${isLive})`);

        if (!invoice.stripe_customer_id) {
            const customer = await stripe.customers.create({
                email: invoice.company_email || undefined,
                name: invoice.company_name || `Company #${invoice.company_id}`,
                metadata: { company_id: String(invoice.company_id), type: 'empresa' }
            }, { idempotencyKey: `cust_company_${invoice.company_id}` });

            await db.run(
                "UPDATE empresas SET stripe_customer_id=?, updated_at=? WHERE id=? AND stripe_customer_id IS NULL",
                customer.id, nowIso(), invoice.company_id
            );
            invoice.stripe_customer_id = customer.id;
        }

        if (invoice.total_cents <= 0) {
            logger.info(`${logPrefix} Auto-closing $0 invoice`);
            await db.run("UPDATE invoices SET status='charged', paid_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), invoice.id);
            return;
        }

        const paymentMethodId = await resolveOffSessionPaymentMethod(stripe, invoice);
        const MAX_ATTEMPTS = 3;

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
                if (!paymentMethodId) {
                    logger.warn(`${logPrefix} Missing payment method; skipping off-session charge`);
                    await finalizeChargeFailure(invoice, {
                        reason: 'Missing payment method for off-session charge.',
                        stripeCode: 'missing_payment_method',
                        errorType: 'missing_payment_method',
                        maxAttempts: MAX_ATTEMPTS,
                        forceStatus: 'suspended'
                    });
                    return;
                }

                logger.info(`${logPrefix} Creating new PI with key: ${idempotencyKey}`);
                paymentIntent = await stripe.paymentIntents.create({
                    amount: invoice.total_cents,
                    currency: invoice.currency || 'usd',
                    customer: invoice.stripe_customer_id,
                    payment_method: paymentMethodId,
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
                    "UPDATE invoices SET stripe_payment_intent_id=?, updated_at=? WHERE id=? AND stripe_payment_intent_id IS NULL",
                    paymentIntent.id, nowIso(), invoice.id
                );
                invoice.stripe_payment_intent_id = paymentIntent.id;
            }

            // Retry/Confirm if needed
            if (paymentIntent.status !== 'succeeded' && paymentIntent.status !== 'processing') {
                if (!paymentMethodId && !paymentIntent.payment_method) {
                    logger.warn(`${logPrefix} Missing payment method; skipping off-session charge`);
                    await finalizeChargeFailure(invoice, {
                        reason: 'Missing payment method for off-session charge.',
                        stripeCode: 'missing_payment_method',
                        errorType: 'missing_payment_method',
                        maxAttempts: MAX_ATTEMPTS,
                        forceStatus: 'suspended'
                    });
                    return;
                }

                logger.info(`${logPrefix} PI ${paymentIntent.id} is ${paymentIntent.status}, attempting confirm...`);
                const confirmPayload = {
                    off_session: true
                };
                if (paymentMethodId) {
                    confirmPayload.payment_method = paymentMethodId;
                }
                paymentIntent = await stripe.paymentIntents.confirm(paymentIntent.id, confirmPayload);
            }

            // (PI Id saving was moved above for guaranteed bottom-up reconciliation)

        } catch (e) {
            // Capture PI ID from error if available
            if (e.raw && e.raw.payment_intent) {
                const piId = e.raw.payment_intent.id;
                await db.run("UPDATE invoices SET stripe_payment_intent_id=? WHERE id=?", piId, invoice.id);
                invoice.stripe_payment_intent_id = piId;
            }
            const reason = e.message || 'Unknown Stripe Error';
            let stripeCode = 'unknown';

            if (e.type === 'StripeCardError') {
                stripeCode = e.code || 'card_declined';
            } else if (e.type) {
                stripeCode = e.type;
            }

            logger.error(`${logPrefix} Stripe Error: ${reason} (Code: ${stripeCode})`);
            await finalizeChargeFailure(invoice, {
                reason,
                stripeCode,
                errorType: e.type || null,
                maxAttempts: MAX_ATTEMPTS
            });

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
            const successAttempt = (invoice.attempt_count || 0) + 1;

            await markInvoiceCharged(invoice.id, {
                paymentIntentId: paymentIntent.id,
                chargeId,
                receiptUrl,
                paidAt: nowIso(),
                attemptCount: successAttempt,
                lastAttemptAt: nowIso(),
                updatedAt: nowIso()
            });

            await db.run(`
                UPDATE tickets
                SET billing_status='paid', paid_at=?, updated_at=?
                WHERE EXISTS (
                    SELECT 1 FROM invoice_items ii
                    WHERE ii.ticket_id = tickets.id AND ii.invoice_id = ?
                )
            `, nowIso(), nowIso(), invoice.id);

            logger.info(`${logPrefix} SUCCESS: Charged ${paymentIntent.id}`);

            // Audit Success
            await db.run(`
                INSERT INTO invoice_attempts 
                (invoice_id, attempt_number, status, stripe_payment_intent_id, created_at)
                VALUES (?, ?, ?, ?, ?)
            `, invoice.id, successAttempt, 'charged', paymentIntent.id, nowIso());

            await db.run(`INSERT INTO events_outbox (event_name, created_at, company_id, metadata) VALUES (?, ?, ?, ?)`,
                'invoice_paid', nowIso(), invoice.company_id, JSON.stringify({ invoice_id: invoice.id, amount: invoice.total_cents, stripe_pi: paymentIntent.id }));
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

    // 0. Auto-Rescue Dunning (Retrying Invoices)
    try {
        const { hasRequiredColumns } = await ensureInvoiceDunningRescueColumns();
        if (hasRequiredColumns) {
            const retryingInvoices = await db.all(`
                SELECT id FROM invoices 
                WHERE status = 'retrying'
                  AND (next_retry_at IS NULL OR next_retry_at <= ?)
            `, nowIso());

            for (const inv of retryingInvoices) {
                // Check if a job already exists to avoid duplicate flooding
                const matchQuery = db.IS_POSTGRES 
                    ? "CAST(payload_json::json->>'invoice_id' AS TEXT) = ?"
                    : "CAST(json_extract(payload_json, '$.invoice_id') AS TEXT) = ?";

                const existing = await db.get(`
                    SELECT id FROM jobs_queue 
                    WHERE job_type = 'charge_weekly_invoice' 
                      AND ${matchQuery} 
                      AND status IN ('pending', 'processing')
                `, String(inv.id));

                if (!existing) {
                    await enqueueJob('charge_weekly_invoice', { invoice_id: inv.id });
                }
            }
        }
    } catch (e) {
        logger.error('[Dunning Rescue] Error:', e.message);
    }

    // 1. Claim Batch (Atomic Transaction)
    const tx = await db.beginTransaction();
    try {
        // Simpler approach compatible with Generic Adapter:
        const candidates = await tx.all(`
            SELECT id FROM jobs_queue 
            WHERE status = 'pending' AND run_at <= ? 
            LIMIT ?
        `, now, BATCH_SIZE);

        if (candidates.length > 0) {
            const ids = candidates.map(c => c.id);
            const idList = ids.join(',');

            // Mark captured ONLY if still pending
            await tx.run(`
                UPDATE jobs_queue 
                SET status = 'processing', locked_by = ?, locked_at = ? 
                WHERE id IN (${idList}) AND status = 'pending'
            `, WORKER_ID, now);

            // Re-fetch ONLY jobs successfully claimed by THIS worker
            const claimed = await tx.all(`
                SELECT * FROM jobs_queue 
                WHERE id IN (${idList}) AND status = 'processing' AND locked_by = ? AND locked_at = ?
            `, WORKER_ID, now);
            jobsToProcess.push(...claimed);
        }

        await tx.commit();

    } catch (e) {
        await tx.rollback();
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
                }, { idempotency_key: `gen_${c.id}_${week_start}` });
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
            const invoices = await db.all("SELECT id FROM invoices WHERE status = 'pending' AND total_cents > 0");
            for (const inv of invoices) {
                await enqueueJob('charge_weekly_invoice', { invoice_id: inv.id }, { idempotency_key: `charge_${inv.id}` });
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
            // Reintentar solo facturas en retrying cuya ventana ya venció.
            // SQLite/PG compatible timestamp string compare
            const querySelect = `
                SELECT id FROM invoices 
                WHERE status = 'retrying'
                  AND (next_retry_at IS NULL OR next_retry_at <= ?)
            `;
            const { hasRequiredColumns } = await ensureInvoiceDunningRescueColumns();
            if (!hasRequiredColumns) return;

            console.log("[Scheduler][Dunning] Executing query:", querySelect);
            const invoices = await db.all(querySelect, nowIso());

            for (const inv of invoices) {
                logger.info(`[Dunning] Enqueuing retry for invoice ${inv.id}`);
                await enqueueJob('charge_weekly_invoice', { invoice_id: inv.id }, { idempotency_key: `charge_${inv.id}` });
            }
        } catch (err) {
            logger.error("[Scheduler][Dunning] Error", err);
        }
    });

    // 4. Janitor Job: Rescata facturas atascadas en 'charging' (Ejecución cada hora)
    cron.schedule('45 * * * *', async () => {
        logger.info('[Janitor] Checking for stuck invoices...');
        try {
            // Umbral: 1 hora de inactividad
            const threshold = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const stuck = await db.all(`
                SELECT id FROM invoices 
                WHERE status = 'charging' 
                  AND updated_at < ? 
                  AND paid_at IS NULL
            `, threshold);

            for (const inv of stuck) {
                await db.run(`UPDATE invoices SET status = 'retrying', updated_at = ? WHERE id = ?`, nowIso(), inv.id);
                logger.warn(`[Janitor] Recovered stuck invoice ${inv.id}`);
            }
        } catch (e) {
            logger.error('[Janitor] Fatal error in recovery loop', e);
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
    const HEARTBEAT_INTERVAL_MS = 15000;
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
    }, HEARTBEAT_INTERVAL_MS);

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
                `UPDATE drivers SET search_status='OFF' WHERE search_status='ON' AND search_expires_at IS NOT NULL AND search_expires_at <= ?`,
                nowIso()
            );
            const r2 = await db.run(
                `UPDATE empresas SET search_status='OFF' WHERE search_status='ON' AND search_expires_at IS NOT NULL AND search_expires_at <= ?`,
                nowIso()
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
                   AND (invited_at IS NULL OR invited_at < ?)
                 LIMIT 50`,
                new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
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
                        `UPDATE driver_leads SET status='INVITED', invited_at=?, invite_count=COALESCE(invite_count,0)+1, updated_at=? WHERE id=?`,
                        nowIso(), nowIso(), lead.id
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

    // Jobs Janitor (every 5 minutes) - Resets jobs stuck in 'processing' for > 60 mins
    const JOBS_JANITOR_INTERVAL = 5 * 60 * 1000;
    async function runJobsJanitor() {
        try {
            // Very conservative threshold (1 hour) to avoid interrupting heavy jobs
            const threshold = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const res = await db.run(`
                UPDATE jobs_queue
                SET status='pending', locked_by=NULL, locked_at=NULL
                WHERE status='processing' AND locked_at < ?
            `, threshold);
            const count = (res && res.rowCount) || (res && res.changes) || 0;
            if (count > 0) {
                logger.info(`[Janitor] Reset ${count} STUCK jobs (stale since < ${threshold}) to pending.`);
            }
        } catch (e) {
            logger.error('[Janitor] Job cleanup failed:', e.message);
        }
    }
    setInterval(runJobsJanitor, JOBS_JANITOR_INTERVAL);
    setTimeout(runJobsJanitor, 60000); // Run once at startup after 1 min

    startQueueWorker().catch(err => {
        logger.error('FATAL: Worker Failed', err);
        process.exit(1);
    });
}

module.exports = { startQueueWorker, enqueueJob, bridgeOutbox };
