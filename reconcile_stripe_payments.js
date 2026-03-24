require('dotenv').config();
const db = require('./db_adapter');
const { getStripe } = require('./stripe_client');
const { nowIso } = require('./time_provider');

const STALE_MINUTES = parseInt(process.env.RECONCILE_STALE_MINUTES) || 10;

async function reconcileStripePayments() {
    const stripe = getStripe();
    if (!stripe) {
        console.log('[Reconciler] STRIPE_SECRET_KEY not set. Skipping.');
        return { checked: 0, reconciled: 0, errors: 0, mismatches: 0 };
    }

    console.log(`[Reconciler] Starting — looking for tickets stuck in checkout_created > ${STALE_MINUTES}m`);

    const staleAt = new Date(Date.now() - STALE_MINUTES * 60000).toISOString();
    const query = `
        SELECT id, stripe_checkout_session_id, price_cents, currency
        FROM tickets
        WHERE billing_status = 'checkout_created'
          AND stripe_checkout_session_id IS NOT NULL
          AND created_at < ?
    `;
    staleTickets = await db.all(query, staleAt);

    console.log(`[Reconciler] Found ${staleTickets.length} stale ticket(s)`);

    let reconciled = 0;
    let errors = 0;
    let mismatches = 0;

    for (const ticket of staleTickets) {
        try {
            const session = await stripe.checkout.sessions.retrieve(ticket.stripe_checkout_session_id);

            if (session.payment_status === 'paid') {
                // Amount validation
                if (session.amount_total !== ticket.price_cents) {
                    console.error(`[Reconciler] ❌ AMOUNT MISMATCH Ticket #${ticket.id}: Stripe=${session.amount_total}, DB=${ticket.price_cents}. NOT marking as paid.`);
                    mismatches++;
                    continue;
                }

                // Currency validation
                if (session.currency && ticket.currency && session.currency.toLowerCase() !== ticket.currency.toLowerCase()) {
                    console.error(`[Reconciler] ❌ CURRENCY MISMATCH Ticket #${ticket.id}: Stripe=${session.currency}, DB=${ticket.currency}. NOT marking as paid.`);
                    mismatches++;
                    continue;
                }

                await db.run(
                    `UPDATE tickets
                     SET billing_status = 'paid',
                         paid_at = ?,
                         stripe_payment_intent_id = ?,
                         stripe_customer_id = ?
                     WHERE id = ? AND billing_status <> 'paid'`,
                    nowIso(),
                    session.payment_intent || null,
                    session.customer || null,
                    ticket.id
                );
                console.log(`[Reconciler] ✅ Ticket #${ticket.id} → PAID (amount: ${session.amount_total}, Session: ${ticket.stripe_checkout_session_id})`);
                reconciled++;
            } else {
                console.log(`[Reconciler] ⏳ Ticket #${ticket.id} still ${session.payment_status} (Session: ${ticket.stripe_checkout_session_id})`);
            }
        } catch (e) {
            console.error(`[Reconciler] ❌ Ticket #${ticket.id} error:`, e.message);
            errors++;
        }
    }

    const summary = { checked: staleTickets.length, reconciled, mismatches, errors, timestamp: nowIso() };
    console.log(`[Reconciler] Done:`, JSON.stringify(summary));
    return summary;
}

// --- Execution modes ---

// 1. Direct run: node reconcile_stripe_payments.js
if (require.main === module) {
    reconcileStripePayments()
        .then(r => {
            console.log('[Reconciler] Exit:', JSON.stringify(r));
            process.exit(0);
        })
        .catch(e => {
            console.error('[Reconciler] Fatal:', e);
            process.exit(1);
        });
}

// 2. Import for use in worker_queue.js cron
module.exports = { reconcileStripePayments };
