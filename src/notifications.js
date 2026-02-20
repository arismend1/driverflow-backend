const logger = require('./logger');

/**
 * Stub Notification System for Dunning (Phase 14)
 * Replace with SendGrid/AWS SES actual implementations in the future.
 */

async function notifyPaymentFailed(invoice, attempt, maxAttempts, errorMsg) {
    // TODO: Implement actual email sending
    logger.info(`[NOTIFY] PAYMENT FAILED (Attempt ${attempt}/${maxAttempts}): Invoice ${invoice.id} for Company ${invoice.company_id}. Reason: ${errorMsg}`);

    // Example Email Template structure:
    /*
    const subject = `Notice: Payment Failed (Invoice #${invoice.id})`;
    const body = `We attempted to process your weekly payment but the charge failed. 
        Reason: ${errorMsg}. 
        We will retry your payment shortly. If payment fails ${maxAttempts} times, your account will be suspended.
        Please update your payment method.`;
    // await emailClient.send(invoice.company_email, subject, body);
    */
}

async function notifyPaymentSuspended(invoice) {
    // TODO: Implement actual email sending
    logger.info(`[NOTIFY] ACCOUNT SUSPENDED: Invoice ${invoice.id} max retries reached. Company ${invoice.company_id} operations are now halted.`);

    // Example Email Template structure:
    /*
    const subject = `ACTION REQUIRED: Account Suspended due to Non-Payment`;
    const body = `Your weekly invoice #${invoice.id} is severely past due and all automatic retry attempts have failed.
        Your DriverFlow account has been temporarily suspended. You cannot create new requests or approve drivers.
        Please contact support or pay the outstanding balance immediately to restore services.`;
    // await emailClient.send(invoice.company_email, subject, body);
    */
}

module.exports = {
    notifyPaymentFailed,
    notifyPaymentSuspended
};
