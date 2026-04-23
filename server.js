require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
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
const { trackLeadFunnelEvent } = require('./analytics');
const { sendPush } = require('./notifications_service');
const runPushMigration = require('./init_push_db');
const { getDriverLockState } = require('./lazy_matching');
const { createInvoiceSchemaHelpers } = require('./invoice_schema_helpers');
const {
    hasDriverReactivationTable,
    canCreateDriverReactivationRequests,
    runDriverReactivationStartupCompatibilityBootstrap,
    isPendingReactivationDuplicateError,
    getDriverReactivationContext,
    closePriorEmploymentRelationship
} = require('./driver_reactivation_helpers');

// --- 1. BOOTSTRAP & SECURITY CHECKS ---
validateEnv({ role: 'api' }); // Checks env vars

const app = express();
const PORT = process.env.PORT || 3000;

async function ensureStripeCustomerForCompany(company) {
    if (company.stripe_customer_id) return company.stripe_customer_id;
    const stripe = getStripe();
    if (!stripe) throw new Error('Stripe Unavailable');
    const candidateEmail = [company.billing_email, company.email, company.contacto]
        .find(value => typeof value === 'string' && /\S+@\S+\.\S+/.test(value));

    const customer = await stripe.customers.create({
        email: candidateEmail ? candidateEmail.trim().toLowerCase() : undefined,
        name: company.nombre || `Company #${company.id}`,
        metadata: { company_id: String(company.id), type: 'empresa' }
    }, { idempotencyKey: `cust_company_${company.id}` });

    await db.run(
        "UPDATE empresas SET stripe_customer_id=?, updated_at=? WHERE id=? AND stripe_customer_id IS NULL",
        customer.id, nowIso(), company.id
    );

    return customer.id;
}

const {
    getTableColumns,
    updateInvoiceRetryState,
    markInvoiceCharged,
    markInvoiceChargedByWhereClause
} = createInvoiceSchemaHelpers({
    db,
    nowIso,
    warn: (message) => console.warn(message),
    safeTables: ['invoices', 'invoice_items', 'tickets', 'empresas']
});

function buildBillingHttpError(httpStatus, code, message, extras = {}) {
    const err = new Error(message);
    err.httpStatus = httpStatus;
    err.code = code;
    Object.assign(err, extras);
    return err;
}

function buildStripeMetadata(metadata = {}) {
    return Object.entries(metadata).reduce((acc, [key, value]) => {
        if (value !== undefined && value !== null) {
            acc[key] = String(value);
        }
        return acc;
    }, {});
}

function getStripePublishableKey() {
    return process.env.STRIPE_PUBLISHABLE_KEY || null;
}

function isReusablePayAndSharePaymentIntentStatus(status) {
    return [
        'requires_payment_method',
        'requires_confirmation',
        'requires_action',
        'processing',
        'requires_capture'
    ].includes(String(status || '').toLowerCase());
}

function getInstantInvoiceDateRange() {
    const today = nowIso().slice(0, 10);
    return {
        weekStart: today,
        weekEnd: today,
        billingWeek: `${today} to ${today}`
    };
}

async function fetchInvoiceByTicket(ticketId, runner = db, companyId = null) {
    if (!ticketId) return null;
    const params = [ticketId];
    let sql = `
        SELECT i.*
        FROM invoices i
        JOIN invoice_items ii ON ii.invoice_id = i.id
        WHERE ii.ticket_id = ?
    `;
    if (companyId !== null && companyId !== undefined) {
        sql += ' AND i.company_id = ?';
        params.push(companyId);
    }
    sql += ' ORDER BY i.id DESC';
    return runner.get(sql, ...params);
}

async function hasChargedInvoiceForTicket(ticketId, companyId, runner = db) {
    const invoice = await fetchInvoiceByTicket(ticketId, runner, companyId);
    return !!(invoice && invoice.status === 'charged');
}

async function isCompanyContactUnlockedForTicketContext(context, runner = db) {
    const ticketId = context && context.ticketId ? context.ticketId : null;
    const companyId = context && context.companyId ? context.companyId : null;
    const matchId = context && context.matchId ? context.matchId : null;
    const driverId = context && context.driverId ? context.driverId : null;

    if (!ticketId || !companyId) return false;

    const ticket = await runner.get(
        `SELECT id, company_id, match_id, driver_id, billing_status
         FROM tickets
         WHERE id = ? AND company_id = ?`,
        ticketId,
        companyId
    );
    if (!ticket) return false;
    if (matchId && String(ticket.match_id) !== String(matchId)) return false;
    if (driverId && String(ticket.driver_id) !== String(driverId)) return false;

    if (ticket.billing_status === 'free_share' || ticket.billing_status === 'paid') {
        return true;
    }

    return hasChargedInvoiceForTicket(ticketId, companyId, runner);
}

async function unlockPendingPaywallMatchByInvoice(invoiceId, runner = db) {
    if (!invoiceId) return null;

    const blockedMatch = await runner.get(
        `SELECT pm.id FROM potential_matches pm
         JOIN tickets t ON t.match_id = pm.id
         JOIN invoice_items ii ON ii.ticket_id = t.id
         WHERE ii.invoice_id = ? AND pm.status = 'PAYMENT_REQUIRED'
         LIMIT 1`,
        invoiceId
    );

    if (!blockedMatch) return null;

    await finalizeShare(blockedMatch.id, runner);
    return blockedMatch.id;
}

async function unlockPendingPaywallMatchByTicket(ticketId, runner = db) {
    if (!ticketId) return null;

    const blockedMatch = await runner.get(
        `SELECT pm.id FROM potential_matches pm
         JOIN tickets t ON t.match_id = pm.id
         WHERE t.id = ? AND pm.status = 'PAYMENT_REQUIRED'
         LIMIT 1`,
        ticketId
    );

    if (!blockedMatch) return null;

    await finalizeShare(blockedMatch.id, runner);
    return blockedMatch.id;
}

function buildLockedDriverPreviewName(row) {
    let opTypes = row?.op_types;
    if (typeof opTypes === 'string') {
        try { opTypes = JSON.parse(opTypes); } catch (_) { opTypes = []; }
    }
    if (!Array.isArray(opTypes)) opTypes = [];

    const years = parseInt(row?.experience_years, 10) || 0;
    const yearLabel = years >= 5 ? '5+ years' : (years > 0 ? `${years}+ years` : null);
    const hasOtr = opTypes.some(op => String(op || '').toUpperCase().includes('OTR'));

    if (hasOtr && yearLabel) return `OTR Driver (${yearLabel})`;
    if (row?.has_cdl && yearLabel) return `CDL Driver (${yearLabel})`;
    if (row?.has_cdl) return 'Experienced CDL Driver';
    if (yearLabel) return `Experienced Driver (${yearLabel})`;
    return 'Experienced Driver';
}

async function resolvePaymentIntentCharge(stripe, paymentIntent) {
    if (!paymentIntent) return { chargeId: null, receiptUrl: null };

    if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object') {
        return {
            chargeId: paymentIntent.latest_charge.id || null,
            receiptUrl: paymentIntent.latest_charge.receipt_url || null
        };
    }

    if (typeof paymentIntent.latest_charge === 'string') {
        try {
            const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
            return {
                chargeId: paymentIntent.latest_charge,
                receiptUrl: charge.receipt_url || null
            };
        } catch (_) {
            return {
                chargeId: paymentIntent.latest_charge,
                receiptUrl: null
            };
        }
    }

    if (paymentIntent.charges && Array.isArray(paymentIntent.charges.data) && paymentIntent.charges.data.length > 0) {
        return {
            chargeId: paymentIntent.charges.data[0].id || null,
            receiptUrl: paymentIntent.charges.data[0].receipt_url || null
        };
    }

    return { chargeId: null, receiptUrl: null };
}

function buildRequiresPaymentMethodError(invoiceId = null, paymentIntentId = null) {
    return buildBillingHttpError(
        402,
        'requires_payment_method',
        'This company must add a payment method before instant billing can continue.',
        { invoiceId, paymentIntentId }
    );
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

let resendClient = null;

function getResendClient() {
    if (!resendClient) {
        const { Resend } = require('resend');
        resendClient = new Resend(process.env.RESEND_API_KEY);
    }
    return resendClient;
}

function formatCurrency(cents, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency || 'USD'
    }).format((Number(cents) || 0) / 100);
}

function formatDate(value) {
    if (!value) return 'N/A';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return 'N/A';
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    }).format(dt);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isValidEmail(value) {
    return typeof value === 'string' && /\S+@\S+\.\S+/.test(value.trim());
}

function chooseExistingColumn(columns, candidates = []) {
    for (const candidate of candidates) {
        if (columns[candidate]) return candidate;
    }
    return null;
}

function getMutationCount(result) {
    if (!result) return 0;
    if (typeof result.rowCount === 'number') return result.rowCount;
    if (typeof result.changes === 'number') return result.changes;
    return 0;
}

async function runBestEffortSideEffect(logPrefix, effect) {
    try {
        await effect();
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.error(`${logPrefix} ${message}`);
    }
}

function getInvoiceEmailLockColumn(invoiceColumns) {
    return chooseExistingColumn(invoiceColumns, ['email_sending_at', 'email_send_locked_at', 'receipt_sending_at']);
}

function getInvoiceBillingSnapshotSelects(invoiceColumns) {
    return {
        billingNameSelect: invoiceColumns.billing_name ? 'billing_name' : 'NULL AS billing_name',
        billingEmailSelect: invoiceColumns.billing_email ? 'billing_email' : 'NULL AS billing_email',
        billingPhoneSelect: invoiceColumns.billing_phone ? 'billing_phone' : 'NULL AS billing_phone',
        billingAddressLine1Select: invoiceColumns.billing_address_line1 ? 'billing_address_line1' : 'NULL AS billing_address_line1',
        billingAddressLine2Select: invoiceColumns.billing_address_line2 ? 'billing_address_line2' : 'NULL AS billing_address_line2',
        billingCitySelect: invoiceColumns.billing_city ? 'billing_city' : 'NULL AS billing_city',
        billingStateSelect: invoiceColumns.billing_state ? 'billing_state' : 'NULL AS billing_state',
        billingPostalCodeSelect: invoiceColumns.billing_postal_code ? 'billing_postal_code' : 'NULL AS billing_postal_code',
        billingCountrySelect: invoiceColumns.billing_country ? 'billing_country' : 'NULL AS billing_country'
    };
}

function resolveInvoiceBillingContext(invoice, company = {}) {
    return {
        name: invoice.billing_name || company.legal_name || company.nombre || `Company #${invoice.company_id || company.id || 'unknown'}`,
        email: invoice.billing_email || company.company_email || null,
        phone: invoice.billing_phone || company.company_phone || null,
        addressLine1: invoice.billing_address_line1 || company.address_line1 || null,
        addressLine2: invoice.billing_address_line2 || company.address_line2 || null,
        city: invoice.billing_city || company.city || null,
        state: invoice.billing_state || company.state || null,
        postalCode: invoice.billing_postal_code || company.postal_code || null,
        country: invoice.billing_country || company.country || null
    };
}

async function getCompanyBillingRecipient(companyId, runner = db) {
    if (!companyId) return null;

    const companyColumns = await getTableColumns('empresas');
    const legalNameCol = chooseExistingColumn(companyColumns, ['legal_name']);
    const billingEmailCol = chooseExistingColumn(companyColumns, ['billing_email']);
    const emailCol = chooseExistingColumn(companyColumns, ['email']);
    const phoneCol = chooseExistingColumn(companyColumns, ['contact_phone', 'telefono', 'phone']);
    const addressLine1Col = chooseExistingColumn(companyColumns, ['address_line1']);
    const addressLine2Col = chooseExistingColumn(companyColumns, ['address_line2']);
    const cityCol = chooseExistingColumn(companyColumns, ['city', 'ciudad']);
    const stateCol = chooseExistingColumn(companyColumns, ['address_state', 'estado', 'state']);
    const postalCodeCol = chooseExistingColumn(companyColumns, ['postal_code', 'zip_code', 'zip', 'postal', 'postcode']);
    const countryCol = chooseExistingColumn(companyColumns, ['country']);
    const selectFields = [
        'id',
        'nombre',
        'contacto',
        legalNameCol ? `${legalNameCol} AS legal_name` : 'NULL AS legal_name',
        billingEmailCol ? `${billingEmailCol} AS billing_email` : 'NULL AS billing_email',
        emailCol ? `${emailCol} AS email` : 'NULL AS email',
        phoneCol ? `${phoneCol} AS company_phone` : 'NULL AS company_phone',
        addressLine1Col ? `${addressLine1Col} AS address_line1` : 'NULL AS address_line1',
        addressLine2Col ? `${addressLine2Col} AS address_line2` : 'NULL AS address_line2',
        cityCol ? `${cityCol} AS city` : 'NULL AS city',
        stateCol ? `${stateCol} AS state` : 'NULL AS state',
        postalCodeCol ? `${postalCodeCol} AS postal_code` : 'NULL AS postal_code',
        countryCol ? `${countryCol} AS country` : 'NULL AS country'
    ];
    const company = await runner.get(
        `SELECT ${selectFields.join(', ')} FROM empresas WHERE id = ?`,
        companyId
    );

    if (!company) return null;

    const companyEmail =
        (isValidEmail(company.billing_email) ? company.billing_email.trim() : null) ||
        (isValidEmail(company.email) ? company.email.trim() : null) ||
        (isValidEmail(company.contacto) ? company.contacto.trim() : null) ||
        null;
    const companyEmailSource =
        (isValidEmail(company.billing_email) && 'billing_email') ||
        (isValidEmail(company.email) && 'email') ||
        (isValidEmail(company.contacto) && 'contacto') ||
        null;

    return {
        ...company,
        company_email: companyEmail || null,
        company_email_source: companyEmailSource
    };
}

async function persistInvoiceHtmlContent(invoiceId, html, runner = db) {
    if (!invoiceId || !html) return false;

    const invoiceColumns = await getTableColumns('invoices');
    if (!invoiceColumns.html_content) return false;

    await runner.run('UPDATE invoices SET html_content = ? WHERE id = ?', html, invoiceId);
    return true;
}

function buildInvoiceEmailHtml(invoice, company) {
    const invoiceNumber = `DF-${String(invoice.id).padStart(6, '0')}`;
    const invoiceDate = formatDate(invoice.created_at);
    const paidDateValue = invoice.paid_at || invoice.charged_at;
    const paidDate = formatDate(paidDateValue);
    const amount = formatCurrency(invoice.total_cents, invoice.currency);
    const supportEmail = escapeHtml(process.env.BILLING_CONTACT_EMAIL || process.env.EMAIL_FROM || 'support@driverflow.app');
    const billing = resolveInvoiceBillingContext(invoice, company);
    const companyName = escapeHtml(billing.name);
    const companyEmail = escapeHtml(billing.email || 'N/A');
    const companyPhone = billing.phone ? escapeHtml(billing.phone) : null;
    const addressLine1 = billing.addressLine1 ? escapeHtml(billing.addressLine1) : null;
    const addressLine2 = billing.addressLine2 ? escapeHtml(billing.addressLine2) : null;
    const locationLine = [billing.city, billing.state, billing.postalCode].filter(Boolean).map(escapeHtml).join(', ');
    const countryLine = billing.country ? escapeHtml(billing.country) : null;
    const receiptUrl = invoice.receipt_url ? String(invoice.receipt_url) : '';

    return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f5f7fb;font-family:Arial,sans-serif;color:#1f2937;">
    <div style="max-width:720px;margin:0 auto;padding:24px;">
      <div style="background:#111827;color:#ffffff;padding:24px 28px;border-radius:16px 16px 0 0;">
        <div style="font-size:28px;font-weight:700;">DriverFlow</div>
        <div style="font-size:14px;opacity:0.9;margin-top:6px;">${supportEmail}</div>
      </div>
      <div style="background:#ffffff;padding:28px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 16px 16px;">
        <div style="display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:24px;">
          <div>
            <div style="font-size:12px;text-transform:uppercase;color:#6b7280;letter-spacing:0.08em;">Bill To</div>
            <div style="font-size:18px;font-weight:700;margin-top:8px;">${companyName}</div>
            <div style="font-size:14px;color:#4b5563;margin-top:4px;">${companyEmail}</div>
            ${companyPhone ? `<div style="font-size:14px;color:#4b5563;margin-top:4px;">${companyPhone}</div>` : ''}
            ${addressLine1 ? `<div style="font-size:14px;color:#4b5563;margin-top:4px;">${addressLine1}</div>` : ''}
            ${addressLine2 ? `<div style="font-size:14px;color:#4b5563;margin-top:4px;">${addressLine2}</div>` : ''}
            ${locationLine ? `<div style="font-size:14px;color:#4b5563;margin-top:4px;">${locationLine}</div>` : ''}
            ${countryLine ? `<div style="font-size:14px;color:#4b5563;margin-top:4px;">${countryLine}</div>` : ''}
          </div>
          <div>
            <div style="font-size:12px;text-transform:uppercase;color:#6b7280;letter-spacing:0.08em;">Invoice</div>
            <div style="font-size:22px;font-weight:700;margin-top:8px;">${escapeHtml(invoiceNumber)}</div>
            <div style="font-size:14px;color:#4b5563;margin-top:8px;">Invoice Date: ${escapeHtml(invoiceDate)}</div>
            <div style="font-size:14px;color:#4b5563;margin-top:4px;">Paid Date: ${escapeHtml(paidDate)}</div>
          </div>
        </div>

        <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin-bottom:24px;">
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f9fafb;">
                <th align="left" style="padding:14px 16px;font-size:12px;text-transform:uppercase;color:#6b7280;">Description</th>
                <th align="left" style="padding:14px 16px;font-size:12px;text-transform:uppercase;color:#6b7280;">Payment Method</th>
                <th align="left" style="padding:14px 16px;font-size:12px;text-transform:uppercase;color:#6b7280;">Status</th>
                <th align="right" style="padding:14px 16px;font-size:12px;text-transform:uppercase;color:#6b7280;">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="padding:16px;border-top:1px solid #e5e7eb;">Driver contact unlock</td>
                <td style="padding:16px;border-top:1px solid #e5e7eb;">Stripe</td>
                <td style="padding:16px;border-top:1px solid #e5e7eb;color:#166534;font-weight:700;">Paid</td>
                <td align="right" style="padding:16px;border-top:1px solid #e5e7eb;font-weight:700;">${escapeHtml(amount)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style="display:flex;justify-content:flex-end;margin-bottom:20px;">
          <div style="min-width:220px;">
            <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;">
              <span style="color:#6b7280;">Total</span>
              <span style="font-weight:700;">${escapeHtml(amount)}</span>
            </div>
          </div>
        </div>

        ${receiptUrl ? `<div style="margin-bottom:20px;"><a href="${escapeHtml(receiptUrl)}" style="color:#2563eb;text-decoration:none;">View Stripe receipt</a></div>` : ''}

        <div style="font-size:13px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:16px;">
          This payment has been successfully processed. Keep this email for your accounting records.
        </div>
      </div>
    </div>
  </body>
</html>`;
}

async function renderInvoicePdf(html) {
    const puppeteer = require('puppeteer');
    let browser = null;

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        return await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            margin: {
                top: '20px',
                right: '20px',
                bottom: '20px',
                left: '20px'
            }
        });
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

function getInvoicePdfFileName(invoiceId) {
    return `invoice-DF-${String(invoiceId).padStart(6, '0')}.pdf`;
}

const invoicePdfJobTimers = new Map();
const invoicePdfJobsInFlight = new Set();
const INVOICE_PDF_JOB_MAX_ATTEMPTS = 3;
const INVOICE_PDF_JOB_BASE_DELAY_MS = 2000;

function getInvoiceStorageRoot() {
    return process.env.INVOICE_STORAGE_DIR || process.env.PERSISTENT_STORAGE_DIR || os.tmpdir();
}

function isHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function getS3StorageConfig() {
    if ((process.env.STORAGE_PROVIDER || '').toLowerCase() !== 's3') return null;

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION;
    const bucket = process.env.AWS_S3_BUCKET;
    if (!accessKeyId || !secretAccessKey || !region || !bucket) return null;

    return {
        accessKeyId,
        secretAccessKey,
        region,
        bucket,
        publicBaseUrl: process.env.AWS_S3_PUBLIC_BASE_URL || null
    };
}

let s3Sdk = null;
let s3Client = null;

function getS3Sdk() {
    if (!s3Sdk) {
        const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
        s3Sdk = { S3Client, PutObjectCommand, GetObjectCommand };
    }
    return s3Sdk;
}

function getS3Client() {
    const s3Config = getS3StorageConfig();
    if (!s3Config) throw new Error('S3 storage not configured');

    if (!s3Client) {
        const { S3Client } = getS3Sdk();
        s3Client = new S3Client({
            region: s3Config.region,
            credentials: {
                accessKeyId: s3Config.accessKeyId,
                secretAccessKey: s3Config.secretAccessKey
            }
        });
    }

    return s3Client;
}

function getInvoicePdfObjectKey(invoiceId) {
    return `invoices/${invoiceId}/${getInvoicePdfFileName(invoiceId)}`;
}

function getS3Host(bucket, region) {
    return region === 'us-east-1' ? `${bucket}.s3.amazonaws.com` : `${bucket}.s3.${region}.amazonaws.com`;
}

function getS3ObjectUrl(bucket, region, key, publicBaseUrl = null) {
    if (publicBaseUrl) {
        return `${publicBaseUrl.replace(/\/+$/, '')}/${key}`;
    }
    return `https://${getS3Host(bucket, region)}/${String(key).split('/').map(encodeURIComponent).join('/')}`;
}

function getInvoicePdfStorageDir() {
    return path.join(getInvoiceStorageRoot(), 'driverflow-invoices', 'pdf');
}

function getInvoicePdfStoragePath(invoiceId) {
    return path.join(getInvoicePdfStorageDir(), getInvoicePdfFileName(invoiceId));
}

function getInvoicePdfJobStorageDir() {
    return path.join(getInvoiceStorageRoot(), 'driverflow-invoices', 'jobs');
}

function getInvoicePdfJobPath(invoiceId) {
    return path.join(getInvoicePdfJobStorageDir(), `invoice-${invoiceId}.json`);
}

async function readInvoicePdfJob(invoiceId) {
    try {
        const raw = await fs.promises.readFile(getInvoicePdfJobPath(invoiceId), 'utf8');
        return JSON.parse(raw);
    } catch (jobErr) {
        if (jobErr.code !== 'ENOENT') {
            console.warn(`[InvoicePDF] Unable to read job for invoice #${invoiceId}: ${jobErr.message}`);
        }
        return null;
    }
}

async function writeInvoicePdfJob(invoiceId, job) {
    await fs.promises.mkdir(getInvoicePdfJobStorageDir(), { recursive: true });
    await fs.promises.writeFile(getInvoicePdfJobPath(invoiceId), JSON.stringify(job, null, 2), 'utf8');
}

async function deleteInvoicePdfJob(invoiceId) {
    try {
        await fs.promises.unlink(getInvoicePdfJobPath(invoiceId));
    } catch (jobErr) {
        if (jobErr.code !== 'ENOENT') {
            console.warn(`[InvoicePDF] Unable to delete job for invoice #${invoiceId}: ${jobErr.message}`);
        }
    }
}

async function fileExists(filePath) {
    if (!filePath) return false;
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function storeInvoicePdfToFilesystem(invoiceId, pdfBuffer) {
    const pdfPath = getInvoicePdfStoragePath(invoiceId);
    await fs.promises.mkdir(path.dirname(pdfPath), { recursive: true });
    await fs.promises.writeFile(pdfPath, pdfBuffer);
    return pdfPath;
}

async function uploadInvoicePdfToS3(invoiceId, pdfBuffer) {
    const s3Config = getS3StorageConfig();
    if (!s3Config) return null;

    const objectKey = getInvoicePdfObjectKey(invoiceId);
    const { PutObjectCommand } = getS3Sdk();
    const client = getS3Client();

    await client.send(new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: objectKey,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
        ContentDisposition: `inline; filename="${getInvoicePdfFileName(invoiceId)}"`,
        Metadata: {
            filename: getInvoicePdfFileName(invoiceId)
        }
    }));

    return getS3ObjectUrl(s3Config.bucket, s3Config.region, objectKey, s3Config.publicBaseUrl);
}

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function downloadInvoicePdfFromS3(invoiceId) {
    const s3Config = getS3StorageConfig();
    if (!s3Config) return null;

    const objectKey = getInvoicePdfObjectKey(invoiceId);
    const { GetObjectCommand } = getS3Sdk();
    const client = getS3Client();
    const response = await client.send(new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: objectKey
    }));

    if (!response.Body) return null;
    return streamToBuffer(response.Body);
}

async function storeInvoicePdf(invoiceId, pdfBuffer) {
    const s3Config = getS3StorageConfig();
    if (s3Config) {
        try {
            return await uploadInvoicePdfToS3(invoiceId, pdfBuffer);
        } catch (s3Err) {
            console.warn(`[InvoicePDF] S3 upload failed for invoice #${invoiceId}: ${s3Err.message}. Falling back to filesystem.`);
        }
    }

    return storeInvoicePdfToFilesystem(invoiceId, pdfBuffer);
}

function resolveInvoicePdfPath(invoiceId, pdfReference = null) {
    if (typeof pdfReference === 'string' && pdfReference.trim()) {
        const trimmed = pdfReference.trim();
        if (/^file:\/\//i.test(trimmed)) {
            return trimmed.replace(/^file:\/\//i, '');
        }
        if (!/^https?:\/\//i.test(trimmed)) {
            return trimmed;
        }
    }
    return getInvoicePdfStoragePath(invoiceId);
}

async function getStoredInvoicePdfAttachment(invoiceId, pdfReference = null) {
    const pdfPath = resolveInvoicePdfPath(invoiceId, pdfReference);
    if (!pdfPath) return undefined;

    try {
        let pdfBuffer;
        if (isHttpUrl(pdfPath)) {
            const response = await axios.get(pdfPath, {
                responseType: 'arraybuffer',
                timeout: 30000,
                validateStatus: (status) => status >= 200 && status < 300
            });
            pdfBuffer = Buffer.from(response.data);
        } else {
            pdfBuffer = await fs.promises.readFile(pdfPath);
        }

        return [{
            filename: getInvoicePdfFileName(invoiceId),
            content: pdfBuffer,
            content_type: 'application/pdf'
        }];
    } catch (pdfErr) {
        if (isHttpUrl(pdfPath)) {
            try {
                const s3PdfBuffer = await downloadInvoicePdfFromS3(invoiceId);
                if (s3PdfBuffer) {
                    return [{
                        filename: getInvoicePdfFileName(invoiceId),
                        content: s3PdfBuffer,
                        content_type: 'application/pdf'
                    }];
                }
            } catch (s3Err) {
                console.warn(`[InvoicePDF] Unable to fetch remote PDF for invoice #${invoiceId}: ${s3Err.message}`);
                return undefined;
            }
        } else if (pdfErr.code !== 'ENOENT') {
            console.warn(`[InvoicePDF] Unable to read stored PDF for invoice #${invoiceId}: ${pdfErr.message}`);
        }
        return undefined;
    }
}

async function generateAndStoreInvoicePdf(invoiceId) {
    if (!invoiceId) return null;

    const invoiceColumns = await getTableColumns('invoices');
    const chargedAtSelect = invoiceColumns.charged_at ? 'charged_at' : 'NULL AS charged_at';
    const htmlContentSelect = invoiceColumns.html_content ? 'html_content' : 'NULL AS html_content';
    const pdfUrlSelect = invoiceColumns.pdf_url ? 'pdf_url' : 'NULL AS pdf_url';
    const {
        billingNameSelect,
        billingEmailSelect,
        billingPhoneSelect,
        billingAddressLine1Select,
        billingAddressLine2Select,
        billingCitySelect,
        billingStateSelect,
        billingPostalCodeSelect,
        billingCountrySelect
    } = getInvoiceBillingSnapshotSelects(invoiceColumns);
    const invoice = await db.get(`
        SELECT id, company_id, total_cents, currency, created_at, paid_at, ${chargedAtSelect}, receipt_url, status, ${htmlContentSelect}, ${pdfUrlSelect},
               ${billingNameSelect}, ${billingEmailSelect}, ${billingPhoneSelect}, ${billingAddressLine1Select}, ${billingAddressLine2Select},
               ${billingCitySelect}, ${billingStateSelect}, ${billingPostalCodeSelect}, ${billingCountrySelect}
        FROM invoices
        WHERE id = ?
    `, invoiceId);

    if (!invoice || invoice.status !== 'charged') return null;

    const existingPdfReference = resolveInvoicePdfPath(invoiceId, invoice.pdf_url);
    const existingPdfAttachment = await getStoredInvoicePdfAttachment(invoiceId, invoice.pdf_url);
    if (existingPdfAttachment) {
        if (invoiceColumns.pdf_url && invoice.pdf_url !== existingPdfReference) {
            await db.run('UPDATE invoices SET pdf_url = ? WHERE id = ?', existingPdfReference, invoiceId);
        }
        return existingPdfReference;
    }

    let html = invoice.html_content || null;
    if (!html) {
        const company = await getCompanyBillingRecipient(invoice.company_id, db) || {};
        html = buildInvoiceEmailHtml(invoice, company);
    }

    const pdfBuffer = await renderInvoicePdf(html);
    const pdfPath = await storeInvoicePdf(invoiceId, pdfBuffer);

    if (invoiceColumns.pdf_url) {
        await db.run('UPDATE invoices SET pdf_url = ? WHERE id = ?', pdfPath, invoiceId);
    }

    return pdfPath;
}

function scheduleInvoicePdfGeneration(invoiceId, delayMs = 0) {
    if (!invoiceId) return;

    const existingTimer = invoicePdfJobTimers.get(String(invoiceId));
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        invoicePdfJobTimers.delete(String(invoiceId));
        processInvoicePdfGenerationJob(invoiceId).catch((jobErr) => {
            console.warn(`[InvoicePDF] Job runner failed for invoice #${invoiceId}: ${jobErr.message}`);
        });
    }, Math.max(0, delayMs));

    invoicePdfJobTimers.set(String(invoiceId), timer);
}

async function processInvoicePdfGenerationJob(invoiceId) {
    const jobKey = String(invoiceId);
    if (invoicePdfJobsInFlight.has(jobKey)) return false;

    const job = await readInvoicePdfJob(invoiceId);
    if (!job) return false;

    const nowMs = nowEpochMs();
    const nextRunAtMs = Number(job.nextRunAt || 0);
    if (nextRunAtMs > nowMs) {
        scheduleInvoicePdfGeneration(invoiceId, nextRunAtMs - nowMs);
        return false;
    }

    invoicePdfJobsInFlight.add(jobKey);
    try {
        await generateAndStoreInvoicePdf(invoiceId);
        await deleteInvoicePdfJob(invoiceId);
        console.log(`[InvoicePDF] Job completed for invoice #${invoiceId}`);
        return true;
    } catch (pdfErr) {
        const attempts = Number(job.attempts || 0) + 1;
        if (attempts >= INVOICE_PDF_JOB_MAX_ATTEMPTS) {
            await writeInvoicePdfJob(invoiceId, {
                ...job,
                invoiceId,
                attempts,
                status: 'failed',
                lastError: pdfErr.message,
                updatedAt: nowIso()
            });
            console.warn(`[InvoicePDF] Job failed permanently for invoice #${invoiceId}: ${pdfErr.message}`);
            return false;
        }

        const delayMs = INVOICE_PDF_JOB_BASE_DELAY_MS * Math.pow(2, attempts - 1);
        const nextRunAt = nowEpochMs() + delayMs;
        await writeInvoicePdfJob(invoiceId, {
            ...job,
            invoiceId,
            attempts,
            status: 'queued',
            lastError: pdfErr.message,
            nextRunAt,
            updatedAt: nowIso()
        });
        console.warn(`[InvoicePDF] Job retry ${attempts}/${INVOICE_PDF_JOB_MAX_ATTEMPTS} scheduled for invoice #${invoiceId} in ${delayMs}ms`);
        scheduleInvoicePdfGeneration(invoiceId, delayMs);
        return false;
    } finally {
        invoicePdfJobsInFlight.delete(jobKey);
    }
}

async function enqueueInvoicePdfGeneration(invoiceId) {
    if (!invoiceId) return false;

    const existingJob = await readInvoicePdfJob(invoiceId);
    const nowMs = nowEpochMs();
    const job = {
        invoiceId: String(invoiceId),
        attempts: existingJob && existingJob.status === 'failed' ? 0 : Number(existingJob?.attempts || 0),
        status: 'queued',
        nextRunAt: nowMs,
        createdAt: existingJob?.createdAt || nowIso(),
        updatedAt: nowIso()
    };

    await writeInvoicePdfJob(invoiceId, job);
    scheduleInvoicePdfGeneration(invoiceId, 0);
    return true;
}

async function resumeInvoicePdfGenerationJobs() {
    try {
        await fs.promises.mkdir(getInvoicePdfJobStorageDir(), { recursive: true });
        const entries = await fs.promises.readdir(getInvoicePdfJobStorageDir());
        for (const entry of entries) {
            if (!entry.endsWith('.json')) continue;
            const match = entry.match(/^invoice-(.+)\.json$/);
            if (!match) continue;
            const invoiceId = match[1];
            const job = await readInvoicePdfJob(invoiceId);
            if (!job || job.status === 'failed') continue;
            const delayMs = Math.max(0, Number(job.nextRunAt || 0) - nowEpochMs());
            scheduleInvoicePdfGeneration(invoiceId, delayMs);
        }
    } catch (jobErr) {
        console.warn(`[InvoicePDF] Unable to resume queued jobs: ${jobErr.message}`);
    }
}

async function sendInvoiceReceiptEmail(invoiceId) {
    if (!invoiceId) return false;

    const invoiceColumns = await getTableColumns('invoices');
    const chargedAtSelect = invoiceColumns.charged_at ? 'charged_at' : 'NULL AS charged_at';
    const htmlContentSelect = invoiceColumns.html_content ? 'html_content' : 'NULL AS html_content';
    const pdfUrlSelect = invoiceColumns.pdf_url ? 'pdf_url' : 'NULL AS pdf_url';
    const emailSentAtSelect = invoiceColumns.email_sent_at ? 'email_sent_at' : 'NULL AS email_sent_at';
    const {
        billingNameSelect,
        billingEmailSelect,
        billingPhoneSelect,
        billingAddressLine1Select,
        billingAddressLine2Select,
        billingCitySelect,
        billingStateSelect,
        billingPostalCodeSelect,
        billingCountrySelect
    } = getInvoiceBillingSnapshotSelects(invoiceColumns);
    const emailLockColumn = invoiceColumns.email_sent_at ? getInvoiceEmailLockColumn(invoiceColumns) : null;
    const invoice = await db.get(`
        SELECT id, company_id, total_cents, currency, created_at, paid_at, ${chargedAtSelect}, receipt_url, status, ${htmlContentSelect}, ${pdfUrlSelect}, ${emailSentAtSelect},
               ${billingNameSelect}, ${billingEmailSelect}, ${billingPhoneSelect}, ${billingAddressLine1Select}, ${billingAddressLine2Select},
               ${billingCitySelect}, ${billingStateSelect}, ${billingPostalCodeSelect}, ${billingCountrySelect}
        FROM invoices
        WHERE id = ?
    `, invoiceId);

    if (!invoice || invoice.status !== 'charged') return false;
    if (invoiceColumns.email_sent_at && invoice.email_sent_at) {
        console.log(`[InvoiceEmail] Receipt already sent for invoice #${invoiceId}`);
        return false;
    }
    if (!invoiceColumns.email_sent_at) {
        console.warn(`[InvoiceEmail] email_sent_at column unavailable; duplicate receipt protection disabled for invoice #${invoiceId}`);
    } else if (!emailLockColumn) {
        console.warn(`[InvoiceEmail] Atomic duplicate protection unavailable for invoice #${invoiceId}; lock column missing`);
    }

    const company = await getCompanyBillingRecipient(invoice.company_id, db);
    if (!company || !company.company_email) {
        console.warn(`[InvoiceEmail] Missing valid billing email for company #${invoice?.company_id || 'unknown'} (invoice #${invoiceId})`);
        return false;
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        console.warn(`[InvoiceEmail] RESEND_API_KEY missing. Skipping invoice email for #${invoiceId}`);
        return false;
    }

    const invoiceNumber = `DF-${String(invoice.id).padStart(6, '0')}`;
    const paidDateValue = invoice.paid_at || invoice.charged_at;
    const amount = formatCurrency(invoice.total_cents, invoice.currency);
    const html = buildInvoiceEmailHtml(invoice, company);
    const billing = resolveInvoiceBillingContext(invoice, company);
    let emailLockClaimed = false;
    let emailSentSuccessfully = false;

    await persistInvoiceHtmlContent(invoiceId, html, db);

    const releaseEmailLockAfterFailure = async () => {
        if (!emailLockColumn || !emailLockClaimed) return;
        try {
            await db.run(`UPDATE invoices SET ${emailLockColumn} = NULL WHERE id = ?`, invoiceId);
            console.log(`[InvoiceEmail] Send lock released after failure for invoice #${invoiceId}`);
        } catch (unlockErr) {
            console.error(`[InvoiceEmail] Failed to release send lock for invoice #${invoiceId}: ${unlockErr.message}`);
        } finally {
            emailLockClaimed = false;
        }
    };

    if (invoiceColumns.email_sent_at && emailLockColumn) {
        const claimResult = await db.run(
            `UPDATE invoices
             SET ${emailLockColumn} = ?
             WHERE id = ?
               AND email_sent_at IS NULL
               AND ${emailLockColumn} IS NULL`,
            nowIso(),
            invoiceId
        );

        if (getMutationCount(claimResult) !== 1) {
            const claimState = await db.get(
                `SELECT email_sent_at, ${emailLockColumn} AS sending_lock FROM invoices WHERE id = ?`,
                invoiceId
            );
            if (claimState?.email_sent_at) {
                console.log(`[InvoiceEmail] Receipt already sent for invoice #${invoiceId}`);
            } else if (claimState?.sending_lock) {
                console.log(`[InvoiceEmail] Receipt send already claimed by another process for invoice #${invoiceId}`);
            } else {
                console.log(`[InvoiceEmail] Receipt send claim unavailable for invoice #${invoiceId}`);
            }
            return false;
        }

        emailLockClaimed = true;
        console.log(`[InvoiceEmail] Send lock acquired for invoice #${invoiceId} via ${emailLockColumn}`);
    }

    const attachments = await getStoredInvoicePdfAttachment(invoiceId, invoice.pdf_url);

    const textBody = [
        `DriverFlow Payment Receipt`,
        ``,
        `Invoice #: ${invoiceNumber}`,
        `Invoice Date: ${formatDate(invoice.created_at)}`,
        `Paid Date: ${formatDate(paidDateValue)}`,
        `Company: ${billing.name}`,
        `Company Email: ${billing.email || 'N/A'}`,
        `Payment Method: Stripe`,
        `Status: Paid`,
        `Description: Driver contact unlock`,
        `Amount: ${amount}`
    ].join('\n');

    const resend = getResendClient();
    const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';
    const fromName = process.env.EMAIL_FROM_NAME || 'DriverFlow';

    try {
        if (invoiceColumns.email_sent_at && !emailLockColumn) {
            const latest = await db.get('SELECT email_sent_at FROM invoices WHERE id = ?', invoiceId);
            if (latest?.email_sent_at) {
                console.log(`[InvoiceEmail] Receipt already sent for invoice #${invoiceId}`);
                return false;
            }
        }

        const { error } = await resend.emails.send({
            from: `${fromName} <${fromEmail}>`,
            to: [company.company_email],
            subject: 'Payment Receipt – DriverFlow',
            text: textBody,
            html,
            attachments
        });

        if (error) {
            throw new Error(`Resend Error: ${error.message || JSON.stringify(error)}`);
        }

        emailSentSuccessfully = true;

        if (invoiceColumns.email_sent_at) {
            if (emailLockColumn) {
                await db.run(
                    `UPDATE invoices
                     SET email_sent_at = COALESCE(email_sent_at, ?),
                         ${emailLockColumn} = NULL
                     WHERE id = ?`,
                    nowIso(),
                    invoiceId
                );
                emailLockClaimed = false;
            } else {
                await db.run('UPDATE invoices SET email_sent_at = COALESCE(email_sent_at, ?) WHERE id = ?', nowIso(), invoiceId);
            }
        }

        console.log(`[InvoiceEmail] Receipt sent successfully for invoice #${invoiceId}`);
        return true;
    } catch (sendErr) {
        if (!emailSentSuccessfully) {
            await releaseEmailLockAfterFailure();
        } else if (emailLockColumn && emailLockClaimed) {
            console.error(`[InvoiceEmail] Receipt sent but lock cleanup failed for invoice #${invoiceId}; lock retained`);
        }
        throw sendErr;
    }
}

async function markInvoiceFailed(invoiceId, message, paymentIntentId = null, runner = db) {
    if (!invoiceId) return;

    const invoiceColumns = await getTableColumns('invoices');
    const assignments = ['status = ?'];
    const params = ['failed'];

    if (invoiceColumns.failure_reason) {
        assignments.push('failure_reason = ?');
        params.push(message || 'Billing failed');
    }
    if (paymentIntentId && invoiceColumns.stripe_payment_intent_id) {
        assignments.push('stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?)');
        params.push(paymentIntentId);
    }
    if (invoiceColumns.updated_at) {
        assignments.push('updated_at = ?');
        params.push(nowIso());
    }

    params.push(invoiceId);
    await runner.run(`UPDATE invoices SET ${assignments.join(', ')} WHERE id = ?`, ...params);
}

function normalizeChargeError(error, invoiceId = null) {
    if (error.httpStatus) return error;

    const paymentIntentId = error.raw && error.raw.payment_intent ? error.raw.payment_intent.id : null;
    const paymentIntentStatus = error.raw && error.raw.payment_intent ? error.raw.payment_intent.status : null;
    const errorMessage = (error.message || '').toLowerCase();

    if (
        paymentIntentStatus === 'requires_payment_method' ||
        error.code === 'requires_payment_method' ||
        (error.code === 'payment_intent_unexpected_state' && errorMessage.includes('missing a payment method')) ||
        errorMessage.includes('missing a payment method')
    ) {
        return buildRequiresPaymentMethodError(invoiceId, paymentIntentId);
    }

    if (
        error.type === 'StripeAPIError' ||
        error.type === 'StripeConnectionError' ||
        error.code === 'rate_limit' ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('temporarily') ||
        errorMessage.includes('connection')
    ) {
        return buildBillingHttpError(
            503,
            'billing_retryable',
            'Temporary billing issue. Please retry.',
            { invoiceId, paymentIntentId }
        );
    }

    if (error.type === 'StripeCardError') {
        return buildBillingHttpError(402, error.code || 'card_declined', error.message || 'Card declined.', {
            invoiceId,
            paymentIntentId
        });
    }

    return buildBillingHttpError(500, 'billing_error', error.message || 'Billing failed.', {
        invoiceId,
        paymentIntentId
    });
}

async function markTicketPaid(ticketId, paymentInfo = {}, runner = db) {
    if (!ticketId) return;

    const ticketColumns = await getTableColumns('tickets');
    const assignments = ['billing_status = ?'];
    const params = ['paid'];

    if (ticketColumns.paid_at) {
        assignments.push('paid_at = ?');
        params.push(nowIso());
    }
    if (ticketColumns.updated_at) {
        assignments.push('updated_at = ?');
        params.push(nowIso());
    }
    if (paymentInfo.paymentIntentId && ticketColumns.stripe_payment_intent_id) {
        assignments.push('stripe_payment_intent_id = ?');
        params.push(paymentInfo.paymentIntentId);
    }
    if (paymentInfo.customerId && ticketColumns.stripe_customer_id) {
        assignments.push('stripe_customer_id = ?');
        params.push(paymentInfo.customerId);
    }

    params.push(ticketId);
    await runner.run(`UPDATE tickets SET ${assignments.join(', ')} WHERE id = ? AND billing_status <> 'paid'`, ...params);
}

async function ensurePendingInvoice({ companyId, amountCents, metadata = {}, runner = db }) {
    const normalizedAmount = parseInt(amountCents, 10);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw buildBillingHttpError(500, 'invalid_amount', 'Invalid billing amount.');
    }

    const ticketId = metadata.ticketId ? parseInt(metadata.ticketId, 10) : null;
    if (!ticketId) {
        throw buildBillingHttpError(500, 'missing_ticket_id', 'Ticket is required to ensure invoice.');
    }

    const lookupInvoice = async (readRunner) => fetchInvoiceByTicket(ticketId, readRunner, companyId);
    let invoice = await lookupInvoice(runner);
    const invoiceColumns = await getTableColumns('invoices');
    const invoiceItemColumns = await getTableColumns('invoice_items');

    if (invoice) {
        return invoice;
    }

    const ownsTransaction = runner === db;
    const writeRunner = ownsTransaction ? await db.beginTransaction() : runner;
    const savepointName = `sp_invoice_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    const isUniqueLikeError = (error) => (
        !!error && (
            error.code === '23505' ||
            (error.message && (error.message.includes('UNIQUE') || error.message.includes('duplicate')))
        )
    );
    const rollbackSavepoint = async () => {
        try { await writeRunner.run(`ROLLBACK TO SAVEPOINT ${savepointName}`); } catch (_) {}
        try { await writeRunner.run(`RELEASE SAVEPOINT ${savepointName}`); } catch (_) {}
    };

    try {
        const existing = await lookupInvoice(writeRunner);
        if (existing) {
            invoice = existing;
        } else {
            if (!ownsTransaction) {
                await writeRunner.run(`SAVEPOINT ${savepointName}`);
            }

            const createdAt = nowIso();
            const instantDateRange = getInstantInvoiceDateRange();
            const insertColumns = ['company_id', 'total_cents', 'status'];
            const insertValues = [companyId, normalizedAmount, 'pending'];
            const companyBilling = await getCompanyBillingRecipient(companyId, writeRunner);
            const billingSnapshot = companyBilling ? resolveInvoiceBillingContext({ company_id: companyId }, companyBilling) : null;

            if (invoiceColumns.currency) {
                insertColumns.push('currency');
                insertValues.push('USD');
            }
            if (invoiceColumns.subtotal_cents) {
                insertColumns.push('subtotal_cents');
                insertValues.push(normalizedAmount);
            }
            if (invoiceColumns.issue_date) {
                insertColumns.push('issue_date');
                insertValues.push(createdAt);
            }
            if (invoiceColumns.due_date) {
                insertColumns.push('due_date');
                insertValues.push(createdAt);
            }
            if (invoiceColumns.billing_week) {
                insertColumns.push('billing_week');
                insertValues.push(instantDateRange.billingWeek);
            }
            if (invoiceColumns.week_start) {
                insertColumns.push('week_start');
                insertValues.push(instantDateRange.weekStart);
            }
            if (invoiceColumns.week_end) {
                insertColumns.push('week_end');
                insertValues.push(instantDateRange.weekEnd);
            }
            if (invoiceColumns.created_at) {
                insertColumns.push('created_at');
                insertValues.push(createdAt);
            }
            if (invoiceColumns.updated_at) {
                insertColumns.push('updated_at');
                insertValues.push(createdAt);
            }
            if (billingSnapshot) {
                if (invoiceColumns.billing_name) {
                    insertColumns.push('billing_name');
                    insertValues.push(billingSnapshot.name || null);
                }
                if (invoiceColumns.billing_email) {
                    insertColumns.push('billing_email');
                    insertValues.push(billingSnapshot.email || null);
                }
                if (invoiceColumns.billing_phone) {
                    insertColumns.push('billing_phone');
                    insertValues.push(billingSnapshot.phone || null);
                }
                if (invoiceColumns.billing_address_line1) {
                    insertColumns.push('billing_address_line1');
                    insertValues.push(billingSnapshot.addressLine1 || null);
                }
                if (invoiceColumns.billing_address_line2) {
                    insertColumns.push('billing_address_line2');
                    insertValues.push(billingSnapshot.addressLine2 || null);
                }
                if (invoiceColumns.billing_city) {
                    insertColumns.push('billing_city');
                    insertValues.push(billingSnapshot.city || null);
                }
                if (invoiceColumns.billing_state) {
                    insertColumns.push('billing_state');
                    insertValues.push(billingSnapshot.state || null);
                }
                if (invoiceColumns.billing_postal_code) {
                    insertColumns.push('billing_postal_code');
                    insertValues.push(billingSnapshot.postalCode || null);
                }
                if (invoiceColumns.billing_country) {
                    insertColumns.push('billing_country');
                    insertValues.push(billingSnapshot.country || null);
                }
            }

            const placeholders = insertColumns.map(() => '?').join(', ');
            const result = await writeRunner.run(
                `INSERT INTO invoices (${insertColumns.join(', ')}) VALUES (${placeholders})` + (db.IS_POSTGRES ? ' RETURNING id' : ''),
                ...insertValues
            );

            const invoiceId = (result.rows && result.rows[0]) ? result.rows[0].id : result.lastInsertRowid;
            invoice = await writeRunner.get('SELECT * FROM invoices WHERE id = ?', invoiceId);

            if (ticketId) {
                const itemColumns = ['invoice_id', 'ticket_id'];
                const itemValues = [invoiceId, ticketId];

                if (invoiceItemColumns.price_cents) {
                    itemColumns.push('price_cents');
                    itemValues.push(normalizedAmount);
                }
                if (invoiceItemColumns.description) {
                    itemColumns.push('description');
                    itemValues.push(metadata.matchId ? `Match #${metadata.matchId}` : `Ticket #${ticketId}`);
                }
                if (invoiceItemColumns.created_at) {
                    itemColumns.push('created_at');
                    itemValues.push(createdAt);
                }

                await writeRunner.run(
                    `INSERT INTO invoice_items (${itemColumns.join(', ')}) VALUES (${itemColumns.map(() => '?').join(', ')})`,
                    ...itemValues
                );
            }

            invoice = await lookupInvoice(writeRunner) || invoice;
        }

        if (!invoice) {
            throw buildBillingHttpError(500, 'invoice_create_failed', 'Unable to create invoice.');
        }

        if (ownsTransaction) {
            await writeRunner.commit();
        } else {
            try { await writeRunner.run(`RELEASE SAVEPOINT ${savepointName}`); } catch (_) {}
        }
    } catch (error) {
        if (ownsTransaction) {
            await writeRunner.rollback().catch(() => {});
            if (isUniqueLikeError(error)) {
                invoice = await lookupInvoice(db);
                if (invoice) return invoice;
            }
        } else {
            await rollbackSavepoint();
            if (isUniqueLikeError(error)) {
                invoice = await lookupInvoice(writeRunner);
                if (invoice) return invoice;
            }
        }

        throw error;
    }

    return invoice;
}

async function reconcileChargedInvoiceForTicket(ticketId, paymentInfo = {}, runner = db, companyId = null) {
    if (!ticketId) return { invoice: null, changedToCharged: false };

    const invoice = await fetchInvoiceByTicket(ticketId, runner, companyId);
    if (!invoice) return { invoice: null, changedToCharged: false };

    if (invoice.status !== 'charged') {
        await markInvoiceCharged(invoice.id, paymentInfo, runner);
        return {
            invoice: await runner.get('SELECT * FROM invoices WHERE id = ?', invoice.id),
            changedToCharged: true
        };
    }

    return { invoice, changedToCharged: false };
}

async function createInvoiceAndCharge({ companyId, amountCents, metadata = {} }) {
    const stripe = getStripe();
    let invoice = null;
    let paymentIntent = null;

    try {
        if (!stripe) {
            return {
                status: 'failed',
                paymentIntentId: null,
                chargeId: null,
                receiptUrl: null,
                error: buildBillingHttpError(500, 'stripe_unavailable', 'Stripe unavailable.')
            };
        }

        const normalizedAmount = parseInt(amountCents, 10);
        if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
            return {
                status: 'failed',
                paymentIntentId: null,
                chargeId: null,
                receiptUrl: null,
                error: buildBillingHttpError(500, 'invalid_amount', 'Invalid billing amount.')
            };
        }

        const ticketId = metadata.ticketId ? parseInt(metadata.ticketId, 10) : null;
        const invoiceId = metadata.invoiceId ? parseInt(metadata.invoiceId, 10) : null;
        const empresaColumns = await getTableColumns('empresas');
        const emailExpr = empresaColumns.email ? 'email' : 'NULL';
        const billingEmailExpr = empresaColumns.email ? 'COALESCE(email, contacto)' : 'contacto';
        const company = await db.get(`
            SELECT id, nombre, contacto, stripe_customer_id, ${billingEmailExpr} AS billing_email, ${emailExpr} AS email
            FROM empresas
            WHERE id = ?
        `, companyId);

        if (!company) {
            return {
                status: 'failed',
                paymentIntentId: null,
                chargeId: null,
                receiptUrl: null,
                error: buildBillingHttpError(500, 'company_not_found', 'Company not found for billing.')
            };
        }

        const customerId = await ensureStripeCustomerForCompany(company);
        company.stripe_customer_id = customerId;
        const paymentMethodId = await getUsablePaymentMethodForCustomer(stripe, customerId);

        if (invoiceId) {
            invoice = await db.get('SELECT * FROM invoices WHERE id = ? AND company_id = ?', invoiceId, companyId);
        }
        if (!invoice && ticketId) {
            invoice = await fetchInvoiceByTicket(ticketId, db, companyId);
        }

        if (!invoice) {
            return {
                status: 'failed',
                paymentIntentId: null,
                chargeId: null,
                receiptUrl: null,
                error: buildBillingHttpError(500, 'invoice_create_failed', 'Unable to create invoice.')
            };
        }

        if (!paymentMethodId) {
            return {
                status: 'failed',
                paymentIntentId: invoice.stripe_payment_intent_id || null,
                chargeId: null,
                receiptUrl: null,
                error: buildRequiresPaymentMethodError(invoice.id, invoice.stripe_payment_intent_id || null)
            };
        }

        if (invoice.status === 'charged') {
            return {
                status: 'charged',
                paymentIntentId: invoice.stripe_payment_intent_id || null,
                chargeId: invoice.stripe_charge_id || null,
                receiptUrl: invoice.receipt_url || null,
                error: null
            };
        }

        const idempotencyKey = ticketId
            ? `instant_ticket_${ticketId}_charge`
            : `instant_invoice_${invoice.id}_charge`;
        const stripeMetadata = buildStripeMetadata({
            invoice_id: invoice.id,
            company_id: companyId,
            ticket_id: ticketId,
            match_id: metadata.matchId,
            driver_id: metadata.driverId,
            source: metadata.source || 'share_information'
        });

        if (invoice.stripe_payment_intent_id) {
            paymentIntent = await stripe.paymentIntents.retrieve(invoice.stripe_payment_intent_id, {
                expand: ['latest_charge']
            });
        } else {
            paymentIntent = await stripe.paymentIntents.create({
                amount: normalizedAmount,
                currency: (invoice.currency || 'USD').toLowerCase(),
                customer: company.stripe_customer_id,
                payment_method: paymentMethodId,
                confirm: true,
                off_session: true,
                expand: ['latest_charge'],
                description: ticketId ? `Instant share charge for ticket #${ticketId}` : `Instant charge for company #${companyId}`,
                metadata: stripeMetadata
            }, { idempotencyKey });
        }

        if (paymentIntent.status !== 'succeeded' && paymentIntent.status !== 'processing') {
            paymentIntent = await stripe.paymentIntents.confirm(paymentIntent.id, {
                off_session: true,
                payment_method: paymentMethodId,
                expand: ['latest_charge']
            });
        }

        if (paymentIntent.status === 'requires_payment_method') {
            return {
                status: 'failed',
                paymentIntentId: paymentIntent.id || null,
                chargeId: null,
                receiptUrl: null,
                error: buildRequiresPaymentMethodError(invoice.id, paymentIntent.id)
            };
        }

        if (paymentIntent.status !== 'succeeded') {
            return {
                status: 'failed',
                paymentIntentId: paymentIntent.id || null,
                chargeId: null,
                receiptUrl: null,
                error: buildBillingHttpError(500, 'payment_not_completed', `Unexpected payment status: ${paymentIntent.status}`, {
                    invoiceId: invoice.id,
                    paymentIntentId: paymentIntent.id
                })
            };
        }

        const { chargeId, receiptUrl } = await resolvePaymentIntentCharge(stripe, paymentIntent);
        return {
            status: 'charged',
            paymentIntentId: paymentIntent.id,
            chargeId,
            receiptUrl,
            error: null
        };
    } catch (error) {
        const normalizedError = normalizeChargeError(
            error,
            invoice ? invoice.id : (metadata.invoiceId ? parseInt(metadata.invoiceId, 10) || null : null)
        );
        return {
            status: 'failed',
            paymentIntentId: (paymentIntent && paymentIntent.id) || normalizedError.paymentIntentId || (error.raw && error.raw.payment_intent ? error.raw.payment_intent.id : null),
            chargeId: null,
            receiptUrl: null,
            error: normalizedError
        };
    }
}

// Trust Proxy (Render/Load Balancer)
app.set('trust proxy', 1);

// --- 2. MIGRATIONS (REPLACED BY CONSOLIDATED BLOCK AT END) ---

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

// 3.4 Static Files (Dashboard)
app.use(express.static(path.join(__dirname, 'public')));

// 3.5 Root Health Route (Ensure Render sees service)
app.get('/', (req, res) => {
    res.json({ 
        status: 'UP', 
        version: '1.4.0-atomic', 
        engine: db.IS_POSTGRES ? 'PostgreSQL' : 'SQLite' 
    });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

console.log("[SERVER] Starting Version: 1.4.0-atomic");

// --- 4. WEBHOOKS (BEFORE BODY PARSER) ---

// Unified Stripe Webhook Handler
const handleStripeWebhook = async (req, res) => {
    console.log('[WEBHOOK HIT]', req.path);
    if (!checkRateLimit(req.ip, 'webhook')) return res.status(429).json({ error: 'RATE_LIMITED' });

    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const stripe = getStripe();
    let event;

    try {
        if (!stripe || !endpointSecret) throw new Error('Config Missing');
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        const isTestKey = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.includes('test');
        if (process.env.NODE_ENV === 'production' && !event.livemode && !isTestKey) {
            console.warn('[Stripe] Test event ignored in PROD');
            return res.status(400).send('Livemode mismatch');
        }
    } catch (err) {
        console.error(`Webhook Signature Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const tx = await db.beginTransaction();
    const invoiceReceiptEmailQueue = new Set();
    try {
        // 1. Idempotent lock: INSERT ... ON CONFLICT DO NOTHING avoids 23505/25P02
        const insertResult = await tx.run(
            `INSERT INTO stripe_webhook_events (stripe_event_id, type, created_at, status) VALUES (?, ?, CURRENT_TIMESTAMP, 'pending') ON CONFLICT (stripe_event_id) DO NOTHING`,
            event.id, event.type
        );

        // If no row was inserted, event is a known duplicate
        if (insertResult.rowCount === 0) {
            console.log(`[Stripe Webhook] Duplicate event ${event.id} (${event.type}) — skipping`);
            await tx.commit();
            return res.json({ received: true });
        }

        // 3. Invoice Payment Interception
        if (event.type === 'payment_intent.succeeded') {
            const paymentIntent = event.data.object;
            const invoiceId = paymentIntent.metadata?.invoice_id || null;
            const ticketId = paymentIntent.metadata?.ticket_id || null;
            const companyId = paymentIntent.metadata?.company_id || null;
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
                const pre = await tx.get("SELECT status FROM invoices WHERE id=?", invoiceId);
                if (pre && pre.status !== 'charged') {
                    await markInvoiceCharged(invoiceId, {
                        paymentIntentId: piId,
                        chargeId,
                        receiptUrl
                    }, tx);

                    await tx.run(`
                        UPDATE tickets 
                        SET billing_status = 'paid'
                        WHERE EXISTS (
                            SELECT 1 FROM invoice_items ii 
                            WHERE ii.ticket_id = tickets.id AND ii.invoice_id = ?
                        )
                    `, invoiceId);
                    console.log(`[Stripe Webhook] Reconciled PAID via metadata ID: ${invoiceId}`);
                    const unlockedMatchId = await unlockPendingPaywallMatchByInvoice(invoiceId, tx);
                    if (unlockedMatchId) {
                        console.log(`[Paywall][Webhook] PAYMENT_REQUIRED -> INFO_SHARED match=${unlockedMatchId} on invoice=${invoiceId}`);
                    }
                    invoiceReceiptEmailQueue.add(String(invoiceId));
                }
            } else if (ticketId) {
                const { invoice, changedToCharged } = await reconcileChargedInvoiceForTicket(
                    ticketId,
                    { paymentIntentId: piId, chargeId, receiptUrl },
                    tx,
                    companyId
                );

                if (!invoice) {
                    console.error(`[Stripe Webhook] Invoice anomaly: no invoice found for Ticket #${ticketId} during payment_intent.succeeded (PI: ${piId})`);
                } else {
                    await markTicketPaid(ticketId, { paymentIntentId: piId }, tx);
                    console.log(`[Stripe Webhook] Reconciled PAID via Ticket Match: ticket=${ticketId}, invoice=${invoice.id}, PI=${piId}`);
                    const unlockedMatchId = await unlockPendingPaywallMatchByTicket(ticketId, tx);
                    if (unlockedMatchId) {
                        console.log(`[Paywall][Webhook] PAYMENT_REQUIRED -> INFO_SHARED match=${unlockedMatchId} on ticket=${ticketId}`);
                    }
                    if (changedToCharged) {
                        invoiceReceiptEmailQueue.add(String(invoice.id));
                    }
                }
            } else {
                // Inverse Reconciliation (Out-of-band manual dashboard capture)
                const pre = await tx.get("SELECT id, status FROM invoices WHERE stripe_payment_intent_id=?", piId);
                if (pre && pre.status !== 'charged') {
                    await markInvoiceChargedByWhereClause(
                        'stripe_payment_intent_id = ? AND status <> \'charged\'',
                        [piId],
                        { chargeId, receiptUrl },
                        tx
                    );

                    await tx.run(`
                        UPDATE tickets 
                        SET billing_status = 'paid'
                        WHERE EXISTS (
                            SELECT 1 FROM invoice_items ii 
                            WHERE ii.ticket_id = tickets.id AND ii.invoice_id = ?
                        )
                    `, pre.id);
                    console.log(`[Stripe Webhook] Reconciled PAID via Inverse PI Match: ${piId}`);
                    const unlockedMatchId = await unlockPendingPaywallMatchByInvoice(pre.id, tx);
                    if (unlockedMatchId) {
                        console.log(`[Paywall][Webhook] PAYMENT_REQUIRED -> INFO_SHARED match=${unlockedMatchId} on inverse_pi=${piId}`);
                    }
                    invoiceReceiptEmailQueue.add(String(pre.id));
                }
            }
        }

        // 4. Ticket Checkout Reconciliation
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const ticketId = session.metadata?.ticket_id || session.client_reference_id;
            if (ticketId) {
                // Load ticket from DB for amount validation
                const ticket = await tx.get('SELECT id, company_id, price_cents, currency FROM tickets WHERE id = ?', ticketId);
                if (!ticket) {
                    console.error(`[Stripe Webhook] Ticket #${ticketId} NOT FOUND in DB. Skipping.`);
                } else if (session.amount_total !== ticket.price_cents) {
                    console.error(`[Stripe Webhook] ❌ AMOUNT MISMATCH for Ticket #${ticketId}: Stripe=${session.amount_total}, DB=${ticket.price_cents}. NOT marking as paid.`);
                } else if (session.currency && ticket.currency && session.currency.toLowerCase() !== ticket.currency.toLowerCase()) {
                    console.error(`[Stripe Webhook] ❌ CURRENCY MISMATCH for Ticket #${ticketId}: Stripe=${session.currency}, DB=${ticket.currency}. NOT marking as paid.`);
                } else {
                    const piId = session.payment_intent || null;
                    const customerId = session.customer || null;
                    let chargeId = null;
                    let receiptUrl = null;

                    if (piId) {
                        try {
                            const paymentIntent = await stripe.paymentIntents.retrieve(piId, {
                                expand: ['latest_charge']
                            });
                            const chargeData = await resolvePaymentIntentCharge(stripe, paymentIntent);
                            chargeId = chargeData.chargeId;
                            receiptUrl = chargeData.receiptUrl;
                        } catch (chargeErr) {
                            console.error(`[Stripe Webhook] Charge resolution failed for Ticket #${ticketId} (PI: ${piId}): ${chargeErr.message}`);
                        }
                    }

                    const { invoice, changedToCharged } = await reconcileChargedInvoiceForTicket(
                        ticketId,
                        { paymentIntentId: piId, chargeId, receiptUrl },
                        tx,
                        ticket.company_id
                    );

                    if (!invoice) {
                        console.error(`[Stripe Webhook] Invoice anomaly: no invoice found for Ticket #${ticketId} during checkout.session.completed`);
                    }

                    await markTicketPaid(ticketId, { paymentIntentId: piId, customerId }, tx);
                    console.log(`[Stripe Webhook] ✅ Ticket #${ticketId} marked PAID (PI: ${piId}, amount: ${session.amount_total})`);
                    if (invoice) {
                        console.log(`[Stripe Webhook] ✅ Invoice #${invoice.id} marked CHARGED via ticket checkout (Ticket: ${ticketId}, PI: ${piId})`);
                    }
                    if (changedToCharged && invoice) {
                        invoiceReceiptEmailQueue.add(String(invoice.id));
                    }
                }
            } else if (session.metadata?.type === 'weekly_invoice' && session.metadata?.invoice_id) {
                const invoiceId = session.metadata.invoice_id;
                const piId = session.payment_intent || null;
                const pre = await tx.get("SELECT status FROM invoices WHERE id=?", invoiceId);
                await markInvoiceCharged(invoiceId, {
                    paymentIntentId: piId
                }, tx);

                await tx.run(`
                    UPDATE tickets 
                    SET billing_status = 'paid'
                    WHERE EXISTS (
                        SELECT 1 FROM invoice_items ii 
                        WHERE ii.ticket_id = tickets.id AND ii.invoice_id = ?
                    )
                `, invoiceId);
                console.log(`[Stripe Webhook] ✅ Invoice #${invoiceId} marked CHARGED via checkout.session.completed (PI: ${piId})`);
                if (pre && pre.status !== 'charged') {
                    invoiceReceiptEmailQueue.add(String(invoiceId));
                }

                // --- HOOK: Push Notification ---
                try {
                    await sendPush(session.metadata.company_id, 'empresa', "Payment Received", "Payment received successfully");
                } catch (pushErr) {
                    console.error("[Stripe Webhook] Push fail:", pushErr.message);
                }
            }
        }

        // Complete Event Lock
        await tx.run(`UPDATE stripe_webhook_events SET status='processed', processed_at=CURRENT_TIMESTAMP WHERE stripe_event_id=?`, event.id);
        
        await tx.commit();
        for (const invoiceId of invoiceReceiptEmailQueue) {
            try {
                await generateAndStoreInvoicePdf(invoiceId);
            } catch (pdfErr) {
                console.warn(`[InvoicePDF] Immediate generation failed for invoice #${invoiceId}: ${pdfErr.message}`);
                try {
                    await enqueueInvoicePdfGeneration(invoiceId);
                } catch (enqueueErr) {
                    console.warn(`[InvoicePDF] Failed to enqueue PDF generation for invoice #${invoiceId}: ${enqueueErr.message}`);
                }
            }
            try {
                await sendInvoiceReceiptEmail(invoiceId);
            } catch (emailErr) {
                console.error(`[InvoiceEmail] Failed for invoice #${invoiceId}: ${emailErr.message}`);
            }
        }
        res.json({ received: true });
    } catch (err) {
        await tx.rollback();
        console.error('[Stripe Processing Error]', err);
        res.status(500).send('Internal Server Error');
    }
};

app.post('/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
// Internal Webhook Aliases (No HTTP Redirects - Must be before global body parsers)
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post('/webhooks/payment', express.raw({ type: 'application/json' }), handleStripeWebhook);

// JSON & URL encoded body parsers (AFTER raw webhooks)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));


// --- 5. APP CONFIG & PUBLIC ROUTES ---
app.use(express.static('public'));

// Health Check
app.get('/', (req, res) => res.json({ status: 'ok', time: nowIso(), mode: process.env.NODE_ENV }));


// --- 5.1 LEGAL PUBLIC ENDPOINTS ---
app.get('/legal/privacy', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Privacy Policy - DriverFlow</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:2rem;max-width:800px;margin:auto;line-height:1.6;color:#333;}h1,h2{color:#1a1a1a;}</style></head><body>
    <h1>Privacy Policy</h1><p><strong>Last Updated: March 2026</strong></p>
    <h2>1. Data Collection & Usage</h2><p>DriverFlow strictly collects the necessary data (Name, Email, Phone, Company details, and CDL Licensing info) to operate our platform and facilitate direct matches between logistics carriers and truck drivers. We maintain strict access controls and do no sell identifying information to data brokers.</p>
    <h2>2. Authentication & Core Infrastructure</h2><p>We process your application data locally within encrypted databases. Authentication payloads and verification workflows are handled with robust cryptographic standards.</p>
    <h2>3. External Third Parties</h2><p><strong>Stripe:</strong> Payment processes are fully isolated. DriverFlow never stores or intercepts credit card credentials natively. <strong>Firebase:</strong> Used exclusively for push notifications regarding match availability.</p>
    <h2>4. Deletion & Contact</h2><p>You may request the permanent deletion of your profile and data by contacting support. Log data is rotated and automatically voided.</p>
    </body></html>`);
});

app.get('/legal/terms', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Terms of Service - DriverFlow</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:2rem;max-width:800px;margin:auto;line-height:1.6;color:#333;}h1,h2{color:#1a1a1a;}</style></head><body>
    <h1>Terms of Service</h1><p><strong>Last Updated: March 2026</strong></p>
    <h2>1. Marketplace Role & Scope</h2><p>DriverFlow acts solely as a technological matching intermediary between independent Transport Companies and CDL Drivers. DriverFlow is NOT a motor carrier, broker, or employer, and does not dictate work conditions or guarantee employment.</p>
    <h2>2. Payments & Billing</h2><p>Companies utilizing the matching engine are billed according to their usage. Delinquent accounts (outstanding invoices via Stripe) will face immediate platform suspension and matching restrictions.</p>
    <h2>3. Acceptable Use</h2><p>Users must submit accurate identification and licensing info. Fraudulent activity, false document uploads, or attempting to circumvent the DriverFlow billing systems will result in immediate permanent termination.</p>
    <h2>4. Limitations of Liability</h2><p>DriverFlow accepts no legal liability for any physical, reputational, or financial damages arising directly from the interactions, employment agreements, or road incidents involving the matched entities.</p>
    </body></html>`);
});



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
        const ticketsUnbilled = await fetchCount('tickets', "WHERE billing_status='unbilled'");
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
                    <div style="background: #fdd; padding: 1rem; border-radius: 4px;"><strong>Unbilled Tickets:</strong> ${ticketsUnbilled}</div>
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

// 5.3 Funnel Analytics (JSON / Admin)
app.get('/admin/analytics/funnel', async (req, res) => {
    const secret = req.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden: Invalid Admin Secret' });

    try {
        const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
        const baseQuery = `SELECT event_type, COUNT(*) as count FROM lead_funnel_events`;
        const filter = !isNaN(days) && days > 0 ? `WHERE created_at > ?` : '';
        const params = !isNaN(days) && days > 0 ? [cutoff] : [];

        const results = await db.all(`${baseQuery} ${filter} GROUP BY event_type`, ...params);

        // Convert array to object
        const counts = {
            lead_created: 0,
            lead_invited: 0,
            driver_registered: 0,
            lead_claimed: 0,
            match_generated: 0
        };

        results.forEach(r => {
            if (counts[r.event_type] !== undefined) {
                counts[r.event_type] = parseInt(r.count);
            }
        });

        const totals = {
            leads_created: counts.lead_created,
            leads_invited: counts.lead_invited,
            drivers_registered: counts.driver_registered,
            leads_claimed: counts.lead_claimed,
            matches_generated: counts.match_generated
        };

        const conversion_rates = {
            invite_rate: totals.leads_created > 0 ? totals.leads_invited / totals.leads_created : 0,
            registration_rate: totals.leads_invited > 0 ? totals.drivers_registered / totals.leads_invited : 0,
            claim_rate: totals.drivers_registered > 0 ? totals.leads_claimed / totals.drivers_registered : 0,
            match_rate: totals.leads_claimed > 0 ? totals.matches_generated / totals.leads_claimed : 0
        };

        res.json({ ok: true, totals, conversion_rates });
    } catch (e) {
        console.error('Analytics Error:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- PUBLIC LEGAL PAGES (Google Play Requirements) ---
app.get('/terms', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8">
            <title>Terms of Service - DriverFlow</title>
            <style>body { font-family: sans-serif; padding: 40px 20px; line-height: 1.6; max-width: 800px; margin: auto; color: #333; }</style>
        </head>
        <body>
            <h1>Terms of Service</h1>
            <p><strong>DriverFlow</strong></p>
            <p><strong>Last Updated:</strong> ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>

            <h2>1. ACCEPTANCE OF TERMS</h2>
            <p>By registering as a "Company" or "Driver" on the DriverFlow platform ("Service"), you agree to be bound by these Terms of Service. If you do not agree, you may not use the Service.</p>

            <h2>2. SERVICE DESCRIPTION</h2>
            <p>DriverFlow is a marketplace connection platform.</p>
            <ul>
                <li><strong>The Product:</strong> We sell <strong>Contact Access</strong> ("Matches").</li>
                <li><strong>Not an Employment Agency:</strong> We do not hire, screen for employment suitability, or employ drivers. We provide the technical ability to connect two interested parties.</li>
                <li><strong>Scope:</strong> Our obligation is fulfilled completely at the moment Driver contact information is revealed to the Company.</li>
            </ul>

            <h2>3. ACCOUNT STATUS & ELIGIBILITY</h2>
            <h3>3.1 Company States</h3>
            <ul>
                <li><strong>REGISTERED:</strong> You have created an account.</li>
                <li><strong>ACTIVE:</strong> You have verified credentials and may search for drivers.</li>
                <li><strong>BLOCKED:</strong> Your access is revoked due to non-payment or violation of terms.</li>
            </ul>

            <h2>4. MATCHING & FEES</h2>
            <h3>4.1 The Match Process</h3>
            <ol>
                <li><strong>Discovery:</strong> Companies view anonymous driver profiles (Experience, Location, etc.).</li>
                <li><strong>Request:</strong> Identifying information is hidden until a Match is confirmed and paid for.</li>
                <li><strong>Approval:</strong> When a Company selects "Approve" on a Driver application, a <strong>Ticket</strong> is strictly generated.</li>
            </ol>

            <h3>4.2 Payment Obligation</h3>
            <p>Trigger: The payment obligation generally arises immediately upon Company Approval. Unlock: Driver contact details (Name, Phone, Email) are LOCKED until the specific Ticket associated with that match is PAID.</p>

            <h2>5. NO REFUNDS OR GUARANTEES</h2>
            <h3>5.1 No Hiring Guarantee</h3>
            <p>We do not guarantee that a Driver will answer your phone call, accept your job offer, or pass your internal background checks.</p>

            <h3>5.2 Refund Policy</h3>
            <p><strong>ALL SALES ARE FINAL.</strong> DriverFlow does not issue refunds for "unsuccessful hires" or "unresponsive drivers". The fee pays for the connection, which is delivered instantly upon unlocking.</p>

            <h2>8. LIMITATION OF LIABILITY</h2>
            <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, DRIVERFLOW SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES. OUR TOTAL LIABILITY IS LIMITED TO THE AMOUNT PAID BY YOU FOR THE SPECIFIC MATCH GIVING RISE TO THE CLAIM.</p>

            <h2>9. GOVERNING LAW</h2>
            <p>These Terms are governed by the laws of the United States, without regard to conflict of law principles.</p>

            <h2>10. CONTACT</h2>
            <p>For legal inquiries or support, please contact: <a href="mailto:admindriverflow@gmail.com">admindriverflow@gmail.com</a>.</p>
        </body>
        </html>
    `);
});

app.get('/privacy', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8">
            <title>Privacy Policy - DriverFlow</title>
            <style>body { font-family: sans-serif; padding: 40px 20px; line-height: 1.6; max-width: 800px; margin: auto; color: #333; }</style>
        </head>
        <body>
            <h1>Privacy Policy</h1>
            <p><strong>DriverFlow</strong></p>
            <p><strong>Last Updated:</strong> ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>

            <h2>1. DATA COLLECTION</h2>
            <p>We collect:</p>
            <ul>
                <li><strong>Registration Data:</strong> Name, Email, Phone, Company Details.</li>
                <li><strong>Match Data:</strong> Interaction history, Match Approvals, Ticket generation.</li>
                <li><strong>Financial Data:</strong> Processed securely via our payment provider (we do not store full card numbers).</li>
            </ul>

            <h2>2. THE "CONTACT REVEAL" MECHANISM</h2>
            <p>A core feature of DriverFlow is the conditional sharing of Personal Information.</p>
            <ul>
                <li><strong>Drivers:</strong> Your Contact Information (Name, Phone, Email) is <strong>HIDDEN</strong> by default.</li>
                <li><strong>Companies:</strong> You cannot view Driver Contact Information during the SEARCH or MATCH phase.</li>
            </ul>
            <p>Driver Contact Information is shared with a Company ONLY when Mutual Interest exists AND the Ticket is PAID.</p>

            <h2>3. DATA RETENTION</h2>
            <p>We retain transaction records (Tickets) for tax and legal compliance (minimum 7 years).</p>

            <h2>4. USER RIGHTS & DELETION</h2>
            <p>You may request deletion of your account. However, we cannot delete Ticket records for completed transactions where service was rendered (i.e., Contact Information was already revealed to a commercial party).</p>

            <h2>5. SECURITY</h2>
            <p>We use industry-standard encryption. Access to "Locked" data is restricted at the database level and cleared only by verified payment events.</p>

            <h2>6. CONTACT</h2>
            <p>To exercise your privacy rights, request data deletion, or clarify doubts, write to us at: <a href="mailto:admindriverflow@gmail.com">admindriverflow@gmail.com</a>.</p>
        </body>
        </html>
    `);
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
        const secret = req.headers['x-admin-secret'];
        if (!secret || secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

        await db.run("UPDATE jobs_queue SET status='pending', attempts=0 WHERE status = 'failed'");
        // Also reset stuck outbox events
        await db.run("UPDATE events_outbox SET queue_status='pending' WHERE queue_status = 'failed'");
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Temporary Diagnostic for Match Scope Fix
app.get('/sys/debug/lux-check', async (req, res) => {
    try {
        const email = 'luxuryservicesfl@gmail.com';
        const rows = await db.all(`SELECT id, nombre, contacto, created_at, account_state, verified FROM empresas WHERE LOWER(TRIM(contacto)) = LOWER(TRIM(?)) ORDER BY id ASC`, email);
        const matchId = 136252;
        const match = await db.get(`SELECT id, company_id, driver_id, status FROM potential_matches WHERE id = ?`, matchId);
        res.json({
            timestamp: nowIso(),
            duplicate_companies: rows,
            match_136252: match,
            analysis: {
                found_count: rows.length,
                match_company_id: match ? match.company_id : null,
                is_match_id_in_duplicates: match ? rows.some(r => r.id === match.company_id) : false
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 6. AUTHENTICATION ---

// STRICT TOKEN SECRET
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is required.');
    process.exit(1);
}

const LEGAL_VERSION = 'v1';

// Auth Middleware (GLOBAL DEFAULT)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access token required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.warn(`[Auth] JWT Verify Failed - Name: ${err.name}, Message: ${err.message}. Auth header present: ${!!authHeader}`);
            return res.status(403).json({ error: 'Invalid or expired token', is_expired: true, reason: err.name || 'InvalidToken' });
        }

        user.type = user.type || user.tipo;

        if (req.path !== '/api/legal/accept' && req.path !== '/login') {
            if (user.legal_accepted !== true || user.legal_version !== LEGAL_VERSION) {
                return res.status(403).json({
                    error: 'Legal terms update required',
                    requires_legal_acceptance: true
                });
            }
        }

        req.user = user;
        next();
    });
};

// --- 5.1 PUSH NOTIFICATIONS ---
app.post('/api/push/register', authenticateToken, async (req, res) => {
    console.log(`[PUSH_REG] Entry: user_id=${req.user?.id}, type=${req.user?.type}, body_keys=${Object.keys(req.body)}`);
    const { token, platform } = req.body;
    if (!token) {
        console.warn(`[PUSH_REG] Missing token in body`);
        return res.status(400).json({ error: 'Missing token' });
    }
    try {
        const userType = req.user.type === 'empresa' ? 'empresa' : 'driver';
        console.log(`[PUSH_REG] Before INSERT: user=${req.user.id}, type=${userType}, token=${token.substring(0, 8)}...`);
        const result = await db.run(
            `INSERT INTO push_tokens (user_id, user_type, token, platform) VALUES (?, ?, ?, ?) 
             ON CONFLICT (user_id, user_type, token) DO UPDATE SET platform = EXCLUDED.platform`,
            req.user.id, userType, token, platform || 'android'
        );
        
        // Clean up legacy push tokens that had "unknown" user_type to prevent duplicates
        await db.run(
            `DELETE FROM push_tokens WHERE user_id = ? AND token = ? AND user_type = 'unknown'`,
            req.user.id, token
        );
        
        console.log(`[PUSH_REG] After INSERT: success`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[PUSH_REGISTER_FAIL]', e.message);
        res.status(500).json({ error: 'Failed to register token' });
    }
});

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
        // Duplicate Resolution Policy (Surgical Fix)
        const queryField = db.IS_POSTGRES ? 'email' : 'contacto';
        const rows = await db.all(`SELECT * FROM ${table} WHERE LOWER(TRIM(${queryField})) = LOWER(TRIM(?)) ORDER BY id ASC`, contacto);
        let row = null;

        if (rows.length > 1 && type === 'empresa') {
            const matchId = req.body.match_id || req.body.matchId;
            let matchCompanyId = null;

            console.log(`[CompanyLoginScope] contacto_normalizado=${contacto.toLowerCase().trim()}`);
            console.log(`[CompanyLoginScope] duplicate_companies_found=${rows.length} [${rows.map(r => r.id).join(', ')}]`);

            if (matchId) {
                const matchData = await db.get(`SELECT company_id FROM potential_matches WHERE id = ?`, matchId);
                matchCompanyId = matchData ? matchData.company_id : null;
                console.log(`[CompanyLoginScope] match_company_id=${matchCompanyId || 'NOT_FOUND_FOR_ID_' + matchId}`);

                if (matchCompanyId) {
                    row = rows.find(r => r.id === matchCompanyId);
                }
            }

            if (!row) {
                // Policy: Try to resolve by ACTIVE + verified
                const activeVerified = rows.filter(r =>
                    (r.account_state === 'ACTIVE' || r.estado === 'ACTIVO' || r.status === 'active') &&
                    (r.verified == 1 || r.verified == true || r.verified == 'true')
                );

                console.log(`[CompanyLoginScope] filtered_active_verified=${activeVerified.length}`);

                if (activeVerified.length === 1) {
                    row = activeVerified[0];
                } else if (activeVerified.length > 1) {
                    console.error(`[CompanyLoginScope] AMBIGUITY_ERROR: Multiple active/verified accounts for "${contacto}".`);
                    return res.status(401).json({
                        error: 'Account resolution failed',
                        code: 'AMBIGUOUS_ACCOUNT',
                        message: 'Múltiples cuentas activas encontradas. Seleccione la correcta.',
                        candidates: activeVerified.map(r => ({ id: r.id, nombre: r.nombre }))
                    });
                }
            }

            if (!row) {
                console.error(`[CompanyLoginScope] RESOLUTION_FAILED: No unique active/verified account found for "${contacto}" among ${rows.length} duplicates.`);
                return res.status(401).json({
                    error: 'Account resolution failed',
                    code: 'LOGIN_DUPLICATE_ERROR',
                    message: 'No se pudo determinar la cuenta correcta.'
                });
            }

            console.log(`[CompanyLoginScope] chosen_company_id=${row.id}`);
            console.log(`[CompanyLoginScope] scope_mismatch=${(matchCompanyId && row.id !== matchCompanyId) ? 'true' : 'false'}`);
        } else if (rows.length > 1 && type === 'driver') {
            console.error(`[Login] AMBIGUITY_ERROR: Multiple accounts for driver "${contacto}".`);
            return res.status(401).json({
                error: 'Account resolution failed',
                code: 'AMBIGUOUS_ACCOUNT',
                message: 'Múltiples cuentas encontradas para conductor.',
                candidates: rows.map(r => ({ id: r.id, nombre: r.nombre }))
            });
        } else {
            row = rows.length > 0 ? rows[0] : null;
        }

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

        // Mandatory Verification Check
        if (row.verified == 0 || row.verified === false || row.verified === 'false' || row.verified === null) {
            console.warn(`[Login] Fail: ${contacto} - UNVERIFIED`);
            return res.status(403).json({ error: 'Debes confirmar tu correo antes de iniciar sesión' });
        }

        const match = await bcrypt.compare(password, row.password_hash);
        if (match) {
            // Success
            if (row.failed_attempts > 0) {
                await db.run(`UPDATE ${table} SET failed_attempts=0, lockout_until=NULL, updated_at=? WHERE id=?`, nowIso(), row.id);
            }
            
            // LEGAL ENFORCEMENT & TOKEN SCOPE
            const legalAccepted = !!(row.accepted_terms_at && row.accepted_privacy_at && row.legal_version === LEGAL_VERSION);
            
            const token = jwt.sign({ 
                id: row.id, 
                type: type === 'empresa' ? 'empresa' : 'driver',
                legal_accepted: legalAccepted,
                legal_version: row.legal_version || null
            }, JWT_SECRET, { expiresIn: '24h' });

            if (!legalAccepted) {
                console.warn(`[Login] Needs legal acceptance: ${contacto}`);
                return res.status(403).json({ 
                    requires_legal_acceptance: true, 
                    name: row.nombre,
                    search_status: row.search_status || 'ON',
                    token, 
                    type, 
                    id: row.id, 
                    message: 'Debes aceptar los Términos y Privacidad actualizados.' 
                });
            }

            await auditLog('login_success', row.id, table, {}, req);

            // Auto-claim lead on driver login
            if (type === 'driver') {
                const driverEmail = db.IS_POSTGRES ? row.email : row.contacto;
                try { await claimLeadForDriver(row.id, driverEmail, null); } catch (ce) { console.error('[LeadClaim] login error:', ce.message); }
            }

            res.json({ ok: true, token, type, id: row.id, name: row.nombre, search_status: row.search_status || 'ON' });
        } else {
            // Bad Password
            const fails = (row.failed_attempts || 0) + 1;
            let sql = `UPDATE ${table} SET failed_attempts = ?, updated_at = ?`;
            const args = [fails, nowIso()];
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
    const { type, nombre, password, accept_terms, accept_privacy, ...extras } = req.body;
    const contacto = (req.body.contacto || '').toString().trim().toLowerCase();
    const phone = (req.body.phone || req.body.telefono || extras.contact_phone || '').toString().trim();

    if (!['driver', 'empresa'].includes(type)) return res.status(400).json({ error: 'Bad type' });
    // Stronger validation: ensure phone is also provided
    if (!nombre || !contacto || !password || !phone) {
        return res.status(400).json({ error: 'Missing fields (nombre, contacto, password, and phone are required)' });
    }
    if (accept_terms !== true || accept_privacy !== true) {
        return res.status(400).json({ error: 'Debes aceptar explícitamente los Términos de Servicio y la Política de Privacidad.' });
    }
    if (!isStrongPassword(password)) return res.status(400).json({ error: 'Weak Password' });

    try {
        // 1. Strict Uniqueness Check (Email OR Phone) across BOTH tables
        // Note: Using a query that works for both engines by checking the adapter
        let checkSql;
        let checkParams;
        if (db.IS_POSTGRES) {
            checkSql = `
                SELECT id, 'driver' as type FROM drivers WHERE email = ? OR phone = ?
                UNION ALL
                SELECT id, 'empresa' as type FROM empresas WHERE email = ? OR telefono = ?
            `;
            checkParams = [contacto, phone, contacto, phone];
        } else {
            checkSql = `
                SELECT id, 'driver' as type FROM drivers WHERE contacto = ? OR phone = ?
                UNION ALL
                SELECT id, 'empresa' as type FROM empresas WHERE contacto = ? OR contact_phone = ?
            `;
            checkParams = [contacto, phone, contacto, phone];
        }

        const existing = await db.get(checkSql, ...checkParams);

        if (existing) {
            console.log(`[Register] Conflict found: ${contacto} / ${phone}. Existing ID: ${existing.id} (${existing.type})`);
            return res.status(409).json({ error: 'EMAIL_OR_PHONE_ALREADY_REGISTERED' });
        }

        const hash = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(32).toString('hex');
        const now = nowIso();
        const expires = new Date(nowEpochMs() + 24 * 3600 * 1000).toISOString(); // 24h

        console.log(`[Register] Generated new verify token (trace) for ${contacto}: ${token.substring(0,8)}... (len: ${token.length})`);

        let newId;
        if (type === 'driver') {
            // Drivers: Create UNVERIFIED (false/0) AND atomically insert legal consent
            if (db.IS_POSTGRES) {
                const result = await db.run(`INSERT INTO drivers (nombre, email, phone, password_hash, tipo_licencia, status, created_at, verified, verify_token_hash, verify_token_expires_at, accepted_terms_at, accepted_privacy_at, legal_version) VALUES (?,?,?,?,?,'active',?,false,?,?,?,?,?) RETURNING id`,
                    nombre, contacto, phone, hash, extras.tipo_licencia || 'B', now, token, expires, now, now, LEGAL_VERSION);
                newId = result.rows ? result.rows[0].id : (result.id || result.lastInsertRowid);
            } else {
                const result = await db.run(`INSERT INTO drivers (nombre, contacto, phone, password_hash, tipo_licencia, status, created_at, verified, verification_token, verification_expires, accepted_terms_at, accepted_privacy_at, legal_version) VALUES (?,?,?,?,?,'active',?,0,?,?,?,?,?)`,
                    nombre, contacto, phone, hash, extras.tipo_licencia || 'B', now, token, expires, now, now, LEGAL_VERSION);
                newId = result.lastInsertRowid;
            }

            // Auto-claim lead if driver email matches
            try { await claimLeadForDriver(newId, contacto, phone); } catch (ce) { console.error('[LeadClaim] register error:', ce.message); }

            // await trackLeadFunnelEvent('driver_registered', {
            //     driver_id: newId,
            //     metadata: { registration_method: "signup" }
            // });

            await db.run(`INSERT INTO events_outbox (request_id, event_name, created_at, driver_id, metadata) VALUES (?,?,?,?,?)`,
                null, 'verification_email', now, newId, JSON.stringify({ token, email: contacto, name: nombre, user_type: 'driver' }));
        } else {
            // Empresas: Create UNVERIFIED (false/0) AND atomically insert legal consent
            if (db.IS_POSTGRES) {
                const result = await db.run(`INSERT INTO empresas (nombre, email, contacto, telefono, password_hash, legal_name, address_line1, city, ciudad, verified, account_state, verify_token_hash, verify_token_expires_at, created_at, contact_person, contact_phone, accepted_terms_at, accepted_privacy_at, legal_version) VALUES (?,?,?,?,?,?,?,?,?,false,'ACTIVE',?,?,?,?,?,?,?,?) RETURNING id`,
                    nombre, contacto, contacto, phone, hash, extras.legal_name || nombre, extras.address_line1 || '', extras.address_city || '', extras.address_city || '', token, expires, now, extras.contact_person || '', extras.contact_phone || phone, now, now, LEGAL_VERSION);
                newId = result.rows ? result.rows[0].id : (result.id || result.lastInsertRowid);
            } else {
                const result = await db.run(`INSERT INTO empresas (nombre, contacto, contact_phone, password_hash, legal_name, address_line1, city, ciudad, verified, account_state, verification_token, verification_expires, created_at, contact_person, accepted_terms_at, accepted_privacy_at, legal_version) VALUES (?,?,?,?,?,?,?,?,0,'ACTIVE',?,?,?,?,?,?,?)`,
                    nombre, contacto, phone, hash, extras.legal_name || nombre, extras.address_line1 || '', extras.address_city || '', extras.address_city || '', token, expires, now, extras.contact_person || '', now, now, LEGAL_VERSION);
                newId = result.lastInsertRowid;
            }

            await db.run(`INSERT INTO events_outbox (request_id, event_name, created_at, company_id, metadata) VALUES (?,?,?,?,?)`,
                null, 'verification_email', now, newId, JSON.stringify({ token, email: contacto, name: nombre, user_type: 'empresa' }));
        }

        console.log(`[Register] Saved verify token for ID ${newId} (type: ${type})`);
        res.json({ ok: true, message: 'Registered successfully.' });
    } catch (e) {
        // Unique constraint check (Fallback if SQL above missed it somehow)
        if (e.message && (e.message.includes('unique') || e.message.includes('duplicate'))) {
            return res.status(409).json({ error: 'User already exists' });
        }
        console.error('Register Error', e);
        res.status(500).json({ error: `Server Error: ${e.message}`, stack: e.stack });
    }
});

app.post('/api/legal/accept', authenticateToken, async (req, res) => {
    const { accept_terms, accept_privacy } = req.body;
    if (accept_terms !== true || accept_privacy !== true) {
        return res.status(400).json({ error: 'Consentimiento explícito requerido para ambos (terms y privacy).' });
    }
    try {
        const table = req.user.type === 'driver' ? 'drivers' : 'empresas';
        const now = nowIso();
        
        await db.run(`UPDATE ${table} SET accepted_terms_at=?, accepted_privacy_at=?, legal_version=?, updated_at=? WHERE id=?`, now, now, LEGAL_VERSION, now, req.user.id);
        
        await auditLog('user_accept_legal', req.user.id, req.user.id, { terms: true, privacy: true, version: LEGAL_VERSION }, req);
        
        // Issue fresh unlocked JWT with legal_accepted flag enabled
        const freshToken = jwt.sign({ 
            id: req.user.id, 
            type: req.user.type,
            legal_accepted: true,
            legal_version: LEGAL_VERSION
        }, JWT_SECRET, { expiresIn: '24h' });

        res.json({ ok: true, message: 'Legal accepted successfully', token: freshToken });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// RESEND VERIFICATION
app.post('/resend-verification', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    try {
        const queryField = db.IS_POSTGRES ? 'email' : 'contacto';
        let u = await db.get(`SELECT id, nombre, status, verified, 'driver' as type FROM drivers WHERE ${queryField}=?`, email);
        if (!u) u = await db.get(`SELECT id, nombre, 'empresa' as type, verified FROM empresas WHERE ${queryField}=?`, email);

        if (!u) return res.status(404).json({ error: 'User not found' });

        // Loose check for verification
        const isVerified = u.verified == 1 || u.verified == true || u.verified == 'true';
        if (isVerified) {
            return res.status(400).json({ error: 'Account already verified' });
        }

        const table = u.type === 'driver' ? 'drivers' : 'empresas';
        const tokenCol = db.IS_POSTGRES ? 'verify_token_hash' : 'verification_token';
        const expCol = db.IS_POSTGRES ? 'verify_token_expires_at' : 'verification_expires';

        // Check for existing valid token — reuse if not expired
        const existing = await db.get(`SELECT ${tokenCol} as token, ${expCol} as expires FROM ${table} WHERE id=?`, u.id);
        let token;

        if (existing && existing.token && existing.expires && new Date(existing.expires) > new Date(nowEpochMs())) {
            // Reuse existing valid token — do NOT overwrite
            token = existing.token;
            console.log(`[Resend] Reusing existing valid token for ${email} (expires ${existing.expires})`);
        } else {
            // Generate new token only if none exists or expired
            token = crypto.randomBytes(32).toString('hex');
            const expires = new Date(nowEpochMs() + 24 * 3600 * 1000).toISOString();
            console.log(`[Resend] Generated new token (trace) for ${email}: ${token.substring(0,8)}... (len: ${token.length})`);

            if (db.IS_POSTGRES) {
                await db.run(`UPDATE ${table} SET verify_token_hash=?, verify_token_expires_at=?, updated_at=? WHERE id=?`, token, expires, nowIso(), u.id);
            } else {
                await db.run(`UPDATE ${table} SET verification_token=?, verification_expires=?, updated_at=? WHERE id=?`, token, expires, nowIso(), u.id);
            }
            console.log(`[Resend] Generated new token for ${email} (old was missing or expired)`);
        }

        await db.run(`INSERT INTO events_outbox (event_name, created_at, driver_id, company_id, metadata) VALUES (?, ?, ?, ?, ?)`,
            'verification_email', nowIso(), u.type === 'driver' ? u.id : null, u.type === 'empresa' ? u.id : null, JSON.stringify({ token, email, name: u.nombre, user_type: u.type }));

        res.json({ ok: true, message: 'Verification email resent.' });
    } catch (e) {
        console.error('Resend Error', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// VERIFY EMAIL
app.all('/verify-email', async (req, res) => {
    const rawToken = req.query.token || req.body.token || '';
    const token = rawToken.toString().trim();
    
    // Detección robusta: Click desde email es un GET con token en la URL
    const isBrowserGet = req.method === 'GET' && !!req.query.token;

    const safeTokenLog = token ? `${token.substring(0,8)}... (len: ${token.length})` : 'EMPTY';
    console.log(`[Verify] Received token trace: ${safeTokenLog}`);
    
    if (!token) {
        if (isBrowserGet) return res.status(400).send('<h1>Error</h1><p>Token missing</p>');
        return res.status(400).json({ error: 'Token missing' });
    }

    try {
        // Search in both tables with expiration check (plain-text comparison)
        const idCol = 'id';
        const typeCol = "'driver' as type";
        const expCol = db.IS_POSTGRES ? 'verify_token_expires_at' : 'verification_expires';
        const tokenCol = db.IS_POSTGRES ? 'verify_token_hash' : 'verification_token';

        let u = await db.get(`SELECT ${idCol}, ${typeCol}, ${expCol} as expires FROM drivers WHERE ${tokenCol}=?`, token);
        if (!u) {
            u = await db.get(`SELECT ${idCol}, 'empresa' as type, ${expCol} as expires FROM empresas WHERE ${tokenCol}=?`, token);
        }

        console.log(`[Verify] Search result for token trace ${safeTokenLog}:`, u ? `Found ID ${u.id} (${u.type})` : 'NOT_FOUND');

        if (!u) {
            console.warn(`[Verify] Token NOT_FOUND: ${safeTokenLog}`);
            if (isBrowserGet) return res.status(404).send('<div style="font-family: sans-serif; text-align: center; padding: 40px;"><h1 style="color: #dc3545;">❌ Error</h1><p style="font-size: 18px;">Token inválido o no encontrado.</p></div>');
            return res.status(404).json({ error: 'Token invalido o no encontrado.' });
        }

        if (u.expires && new Date(u.expires) < new Date(nowEpochMs())) {
            console.warn(`[Verify] Token EXPIRED: ${safeTokenLog} at ${u.expires}`);
            if (isBrowserGet) return res.status(400).send('<div style="font-family: sans-serif; text-align: center; padding: 40px;"><h1 style="color: #dc3545;">❌ Error</h1><p style="font-size: 18px;">Token inválido o expirado.</p></div>');
            return res.status(400).json({ error: 'El token de verificacion ha expirado.' });
        }

        const table = u.type === 'driver' ? 'drivers' : 'empresas';
        if (db.IS_POSTGRES) {
            await db.run(`UPDATE ${table} SET verified=true, verify_token_hash=NULL, verify_token_expires_at=NULL, updated_at=? WHERE id=?`, nowIso(), u.id);
        } else {
            await db.run(`UPDATE ${table} SET verified=1, verification_token=NULL, verification_expires=NULL, updated_at=? WHERE id=?`, nowIso(), u.id);
        }
        
        console.log(`[Verify] Successfully verified ID ${u.id} (${u.type}). Token cleared.`);

        if (isBrowserGet) {
            return res.send(`
                <div style="font-family: sans-serif; text-align: center; padding: 40px;">
                    <h1 style="color: #28a745;">✅ Cuenta verificada</h1>
                    <p style="font-size: 18px; color: #555;">Tu correo ha sido verificado exitosamente. Ya puedes cerrar esta ventana e iniciar sesión en la aplicación.</p>
                </div>
            `);
        } else {
            return res.json({ ok: true, message: 'Tu correo ha sido verificado exitosamente. Ya puedes iniciar sesion.' });
        }
    } catch (e) {
        console.error('Verify Error', e);
        if (isBrowserGet) return res.status(500).send('<h1>Error</h1><p>Server Error</p>');
        res.status(500).json({ error: 'Server Error' });
    }
});

// FORGOT PASSWORD
app.post('/forgot_password', async (req, res) => {
    if (!checkRateLimit(req.ip, 'forgot')) return res.status(429).json({ error: 'RATE_LIMITED' });
    const email = req.body.email || req.body.contacto;

    try {
        const queryField = db.IS_POSTGRES ? 'email' : 'contacto';
        let u = await db.get(`SELECT id, nombre, 'driver' as type FROM drivers WHERE ${queryField}=?`, email);
        if (!u) u = await db.get(`SELECT id, nombre, 'empresa' as type FROM empresas WHERE ${queryField}=?`, email);

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
        const now = nowIso();
        let u = await db.get("SELECT id, 'driver' as type FROM drivers WHERE reset_token=? AND reset_expires > ?", token, now);
        if (!u) u = await db.get("SELECT id, 'empresa' as type FROM empresas WHERE reset_token=? AND reset_expires > ?", token, now);

        if (!u) return res.status(400).json({ error: 'Invalid or Expired Link' });

        const hash = await bcrypt.hash(newPassword, 10);
        const table = u.type === 'driver' ? 'drivers' : 'empresas';

        await db.run(`UPDATE ${table} SET password_hash=?, reset_token=NULL, reset_expires=NULL, updated_at=? WHERE id=?`, hash, nowIso(), u.id);
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
        await db.run("UPDATE solicitudes SET estado='EN_REVISION', driver_id=?, updated_at=? WHERE id=?", req.user.id, nowIso(), request_id);
        await db.run("UPDATE drivers SET estado='OCUPADO', updated_at=? WHERE id=?", nowIso(), req.user.id);

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
        await db.run("UPDATE solicitudes SET estado='ACEPTADA', updated_at=? WHERE id=?", nowIso(), request_id);

        // Create Ticket
        const price_cents = parseInt(process.env.WEEKLY_FEE_CENTS);
        if (isNaN(price_cents) || price_cents <= 0) {
            throw new Error(`[Billing] Missing or invalid WEEKLY_FEE_CENTS: ${process.env.WEEKLY_FEE_CENTS}. Ticket generation aborted.`);
        }

        const t = await db.run("INSERT INTO tickets (company_id, driver_id, request_id, price_cents, currency, created_at, billing_status) VALUES (?,?,?,?,'USD',?,'unbilled')",
            req.user.id, r.driver_id, request_id, price_cents, nowIso());
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
            "UPDATE tickets SET stripe_checkout_session_id=?, billing_status='checkout_created', updated_at=? WHERE id=? AND billing_status <> 'paid'",
            session.id, nowIso(), tid
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
        await db.run("UPDATE tickets SET billing_status='void', updated_at=? WHERE id=?", nowIso(), req.params.id);
        await auditLog('ticket_voided', 'admin', req.params.id, {}, req);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 7.0 SYSTEM MONITORING ---
app.get('/admin/health', async (req, res) => {
    const adminParam = req.headers['x-admin-secret'];
    if (!adminParam || adminParam !== process.env.ADMIN_SECRET) return res.sendStatus(403);

    try {
        const [invoices, tickets, invoiceItems, jobs, janitor] = await Promise.all([
            db.all("SELECT status, count(*) as count FROM invoices GROUP BY status"),
            db.get("SELECT count(*) as count FROM tickets WHERE billing_status = 'unbilled'"),
            db.get("SELECT count(*) as count FROM invoice_items"),
            db.all("SELECT status, count(*) as count FROM jobs_queue GROUP BY status"),
            db.get(`
                SELECT count(*) as count 
                FROM invoices 
                WHERE status = 'charging' 
                AND updated_at < ? 
                AND paid_at IS NULL
            `, new Date(Date.now() - 3600 * 1000).toISOString())
        ]);

        const invSummary = { pending: 0, charging: 0, retrying: 0, charged: 0, other: 0 };
        const invRaw = {};
        (invoices || []).forEach(r => {
            const s = r.status || 'unknown';
            const c = parseInt(r.count) || 0;
            invRaw[s] = c;
            if (s === 'pending') invSummary.pending = c;
            else if (s === 'charging') invSummary.charging = c;
            else if (s === 'retrying') invSummary.retrying = c;
            else if (s === 'charged' || s === 'paid') invSummary.charged += c;
            else invSummary.other += c;
        });

        const jobSummary = { pending: 0, processing: 0, failed: 0, other: 0 };
        const jobRaw = {};
        (jobs || []).forEach(r => {
            const s = r.status || 'unknown';
            const c = parseInt(r.count) || 0;
            jobRaw[s] = c;
            if (s === 'pending') jobSummary.pending = c;
            else if (s === 'processing') jobSummary.processing = c;
            else if (s === 'failed') jobSummary.failed = c;
            else jobSummary.other += c;
        });

        const totalInvoicedCount = (invoices || []).reduce((acc, curr) => acc + (parseInt(curr.count) || 0), 0);

        const response = {
            invoices: { ...invSummary, raw_statuses: invRaw },
            tickets: { unbilled: parseInt(tickets?.count) || 0 },
            invoice_items: parseInt(invoiceItems?.count) || 0,
            jobs: { ...jobSummary, raw_statuses: jobRaw },
            janitor: { stuck_invoices: parseInt(janitor?.count) || 0 }
        };

        console.log(`[HEALTH_CHECK] ${new Date().toISOString()} | Total Invoices DB: ${totalInvoicedCount} | Stuck: ${response.janitor.stuck_invoices}`);
        res.json(response);

    } catch (e) {
        console.error('[HEALTH_CHECK ERR]', e);
        res.status(500).json({ error: e.message });
    }
});

// --- 7.1 WEEKLY BILLING ADMIN ---

app.get('/admin/invoices', async (req, res) => {
    const adminParam = req.headers['x-admin-secret'];
    if (!adminParam || adminParam !== process.env.ADMIN_SECRET) return res.sendStatus(403);

    try {
        const rows = await db.all(`
            SELECT w.*, c.nombre as company_name 
            FROM invoices w 
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
            }, { idempotency_key: `gen_${c.id}_${week_start}` });
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
        const invoice = await db.get("SELECT * FROM invoices WHERE id = ?", invoiceId);
        if (!invoice) return res.status(404).json({ error: 'Not Found' });

        if (['charged', 'charging', 'suspended'].includes(invoice.status)) {
            return res.status(400).json({ error: `Cannot retry invoice in status: ${invoice.status}` });
        }

        // Set to retrying and reset next_retry_at to now for immediate pickup by Dunning loop or direct queue
        await updateInvoiceRetryState(invoiceId, {
            status: 'retrying',
            clearFailureReason: true,
            nextRetryAt: nowIso(),
            updatedAt: nowIso(),
            lastAttemptAt: nowIso()
        });

        const { enqueueJob } = require('./worker_queue');
        await enqueueJob('charge_weekly_invoice', { invoice_id: invoiceId }, { idempotency_key: `charge_${invoiceId}` });

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
        const invoice = await db.get("SELECT * FROM invoices WHERE id = ?", invoiceId);
        if (!invoice) return res.status(404).json({ error: 'Not Found' });

        if (invoice.status === 'charged') return res.status(400).json({ error: 'Cannot suspend a charged invoice' });

        await updateInvoiceRetryState(invoiceId, {
            status: 'suspended',
            suspendedAt: nowIso(),
            updatedAt: nowIso()
        });
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
        const invoice = await db.get("SELECT * FROM invoices WHERE id = ?", invoiceId);
        if (!invoice) return res.status(404).json({ error: 'Not Found' });

        if (invoice.status !== 'suspended') return res.status(400).json({ error: `Invoice is not suspended (Status: ${invoice.status})` });

        // Set to failed/retrying with next_retry_at to NOW() so Dunning loop can pick it up
        await updateInvoiceRetryState(invoiceId, {
            status: 'retrying',
            clearSuspendedAt: true,
            nextRetryAt: nowIso(),
            attemptCount: 0,
            updatedAt: nowIso()
        });

        // Also enqueue it immediately just in case
        const { enqueueJob } = require('./worker_queue');
        await enqueueJob('charge_weekly_invoice', { invoice_id: invoiceId }, { idempotency_key: `charge_${invoiceId}` });

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
                await trackLeadFunnelEvent('lead_created', { company_id: companyId, metadata: { source: "csv_import", is_synthetic: false } });
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
            SELECT id, week_start, week_end, billing_week, issue_date, due_date, subtotal_cents, total_cents, currency, status, created_at, paid_at, paid_method, receipt_url
            FROM invoices 
            WHERE company_id=? 
            ORDER BY issue_date DESC 
            LIMIT ? OFFSET ?
        `, req.user.id, limit, offset);
        res.json((rows || []).map(row => ({
            ...row,
            billing_week: row.billing_week || ((row.week_start && row.week_end) ? `${row.week_start} to ${row.week_end}` : null)
        })));
    } catch (e) {
        console.error('Invoices List Error', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/billing/invoices/:id', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    try {
        const inv = await db.get(`
            SELECT id, week_start, week_end, billing_week, issue_date, due_date, subtotal_cents, total_cents, currency, status, created_at, paid_at, paid_method, receipt_url
            FROM invoices 
            WHERE id=? AND company_id=?
        `, req.params.id, req.user.id);

        if (!inv) return res.status(404).json({ error: 'Not Found' });
        res.json({
            ...inv,
            billing_week: inv.billing_week || ((inv.week_start && inv.week_end) ? `${inv.week_start} to ${inv.week_end}` : null)
        });
    } catch (e) {
        console.error('Invoice Detail Error', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/billing/invoice/:id', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    try {
        const invoiceColumns = await getTableColumns('invoices');
        const chargedAtSelect = invoiceColumns.charged_at ? 'charged_at' : 'NULL AS charged_at';
        const htmlContentSelect = invoiceColumns.html_content ? 'html_content' : 'NULL AS html_content';
        const {
            billingNameSelect,
            billingEmailSelect,
            billingPhoneSelect,
            billingAddressLine1Select,
            billingAddressLine2Select,
            billingCitySelect,
            billingStateSelect,
            billingPostalCodeSelect,
            billingCountrySelect
        } = getInvoiceBillingSnapshotSelects(invoiceColumns);
        const invoice = await db.get(`
            SELECT id, company_id, total_cents, currency, created_at, paid_at, ${chargedAtSelect}, receipt_url, status, ${htmlContentSelect},
                   ${billingNameSelect}, ${billingEmailSelect}, ${billingPhoneSelect}, ${billingAddressLine1Select}, ${billingAddressLine2Select},
                   ${billingCitySelect}, ${billingStateSelect}, ${billingPostalCodeSelect}, ${billingCountrySelect}
            FROM invoices
            WHERE id = ?
        `, req.params.id);

        if (!invoice) return res.status(404).json({ error: 'Not Found' });
        if (String(invoice.company_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (invoice.status !== 'charged') {
            return res.status(400).json({ error: 'Invoice not paid' });
        }

        const format = String(req.query.format || 'html').toLowerCase();
        console.log(`[InvoiceAccess] company=${req.user.id} invoice=${invoice.id} format=${format}`);

        let html = invoice.html_content || null;
        if (!html) {
            const company = await getCompanyBillingRecipient(invoice.company_id, db);
            if (!company) return res.status(404).json({ error: 'Company Not Found' });

            html = buildInvoiceEmailHtml(invoice, company);
        }

        const extension = format === 'pdf' ? 'pdf' : 'html';
        const invoiceFileName = `invoice-DF-${String(invoice.id).padStart(6, '0')}.${extension}`;
        if (format === 'pdf') {
            try {
                const pdfBuffer = await renderInvoicePdf(html);
                res.setHeader('Content-Type', 'application/pdf');
                if (req.query.download === 'true') {
                    res.setHeader('Content-Disposition', `attachment; filename=${invoiceFileName}`);
                }
                return res.send(pdfBuffer);
            } catch (pdfErr) {
                console.error(`[InvoicePDF] Failed for invoice #${invoice.id}: ${pdfErr.message}`);
                return res.status(500).json({ error: 'Failed to generate PDF invoice' });
            }
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (req.query.download === 'true') {
            res.setHeader('Content-Disposition', `attachment; filename=${invoiceFileName}`);
        }
        return res.send(html);
    } catch (e) {
        console.error('Invoice HTML Error', e);
        res.status(500).json({ error: e.message });
    }
});

// Checkout for Weekly Invoice (Escape Hatch / Manual Payment)
app.post('/api/billing/invoices/:id/checkout', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });
    const invId = req.params.id;

    try {
        const companyEmailExpr = db.IS_POSTGRES ? "COALESCE(c.email, c.contacto)" : "c.contacto";
        const companyRawEmailExpr = db.IS_POSTGRES ? "c.email" : "NULL";
        const invoice = await db.get(`
            SELECT w.*, c.stripe_customer_id, ${companyEmailExpr} AS billing_email, ${companyRawEmailExpr} AS email, c.contacto, c.nombre
            FROM invoices w 
            JOIN empresas c ON w.company_id = c.id 
            WHERE w.id=? AND w.company_id=?
        `, invId, req.user.id);

        if (!invoice) return res.status(404).json({ error: 'Invoice Not Found' });

        // Allowed statuses for manual checkout
        const allowedStatuses = ['pending', 'failed', 'retrying', 'suspended'];
        if (!allowedStatuses.includes(invoice.status)) {
            return res.status(409).json({ error: `Checkout not allowed for status: ${invoice.status}` });
        }

        if (invoice.total_cents <= 0) {
            return res.status(400).json({ error: 'Invoice has no amount to pay' });
        }

        const stripe = getStripe();
        if (!stripe) return res.status(503).json({ error: 'Stripe Unavailable' });
        const customerId = await ensureStripeCustomerForCompany({
            id: req.user.id,
            stripe_customer_id: invoice.stripe_customer_id,
            billing_email: invoice.billing_email,
            email: invoice.email,
            contacto: invoice.contacto,
            nombre: invoice.nombre
        });

        // Idempotency: avoid creating too many sessions for the same attempt
        const idempotencyKey = `inv_checkout_${invoice.id}_${Date.now()}`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer: customerId,
            line_items: [{
                price_data: {
                    currency: (invoice.currency || 'usd').toLowerCase(),
                    product_data: {
                        name: `Weekly Invoice (${invoice.billing_week})`,
                        description: `Usage for Company #${invoice.company_id}`
                    },
                    unit_amount: invoice.total_cents
                },
                quantity: 1
            }],
            mode: 'payment',
            metadata: {
                invoice_id: invoice.id,
                company_id: req.user.id,
                type: 'weekly_invoice'
            },
            payment_intent_data: {
                metadata: {
                    invoice_id: invoice.id,
                    company_id: req.user.id,
                    type: 'weekly_invoice'
                }
            },
            success_url: 'https://driverflow.app',
            cancel_url: 'https://driverflow.app',
        }, { idempotencyKey });
        // Save reference for tracking (removed missing columns stripe_checkout_session_id and updated_at)

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
        const defaults = {
            req_cdl: true,
            req_license_types: [],
            req_endorsements: [],
            req_operation_types: [],
            req_modalities: [],
            req_truck: false,
            offered_payment_methods: [],
            req_relationships: [],
            availability: 'Immediate',
            req_experience_years: 0,
            pay_per_mile_min: null,
            pay_per_mile_max: null,
            company_logo: null,
            company_bio: null,
            requires_travel_interview: false,
            home_time: 'Flexible',
            offered_freight_types: '',
            contact_person: '',
            contact_phone: ''
        };

        const row = await db.get(`
            SELECT cr.*, 
                   COALESCE(cr.requires_travel_interview, ${db.IS_POSTGRES ? 'FALSE' : '0'}) AS requires_travel_interview, 
                   e.company_logo, e.company_bio, e.contact_person, e.contact_phone 
            FROM empresas e
            LEFT JOIN company_requirements cr ON e.id = cr.company_id 
            WHERE e.id = ?`, req.user.id);

        console.log(`[COMPANY_PROFILE][LOAD] returning company profile for company ${req.user.id} - found: ${!!row}`);

        if (!row) return res.json(defaults);

        const parseArrayField = (value) => {
            if (Array.isArray(value)) return value;
            if (typeof value === 'string' && value.trim()) {
                try {
                    const parsed = JSON.parse(value);
                    return Array.isArray(parsed) ? parsed : [];
                } catch {
                    return [];
                }
            }
            return [];
        };

        const normalizeAvailability = (value) =>
            value === 'Inmediata' ? 'Immediate' : (value || defaults.availability);

        const readDbBoolean = (value) =>
            db.IS_POSTGRES ? !!value : Number(value) === 1;

        const result = {
            ...defaults,
            ...row,
            req_license_types: parseArrayField(row.req_license_types),
            req_endorsements: parseArrayField(row.req_endorsements),
            req_operation_types: parseArrayField(row.req_operation_types),
            req_modalities: parseArrayField(row.req_modalities),
            offered_payment_methods: parseArrayField(row.offered_payment_methods),
            req_relationships: parseArrayField(row.req_relationships),
            availability: normalizeAvailability(row.availability),
            req_experience_years: row.req_experience_years ?? defaults.req_experience_years,
            pay_per_mile_min: row.pay_per_mile_min ?? defaults.pay_per_mile_min,
            pay_per_mile_max: row.pay_per_mile_max ?? defaults.pay_per_mile_max,
            requires_travel_interview: readDbBoolean(row.requires_travel_interview),
            home_time: row.home_time || defaults.home_time,
            offered_freight_types: row.offered_freight_types || defaults.offered_freight_types,
            company_logo: row.company_logo || defaults.company_logo,
            company_bio: row.company_bio || defaults.company_bio,
            contact_person: row.contact_person || defaults.contact_person,
            contact_phone: row.contact_phone || defaults.contact_phone
        };

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
        availability, req_experience_years,
        pay_per_mile_min, pay_per_mile_max, company_logo, company_bio, requires_travel_interview,
        home_time, offered_freight_types, contact_person, contact_phone
    } = req.body;

    const parseArrayField = (value) => {
        if (Array.isArray(value)) return value;
        if (typeof value === 'string' && value.trim()) {
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        }
        return [];
    };

    const serializeArrayField = (value) => JSON.stringify(parseArrayField(value));
    const normalizeAvailability = (value) =>
        value === 'Inmediata' ? 'Immediate' : value;
    const readDbBoolean = (value) =>
        db.IS_POSTGRES ? !!value : Number(value) === 1;
    const toDbBoolean = (value) =>
        db.IS_POSTGRES ? !!value : (!!value ? 1 : 0);
    const toIntOr = (value, fallback) => {
        if (value === undefined || value === null || value === '') return fallback;
        const num = Number(value);
        return Number.isFinite(num) ? Math.trunc(num) : fallback;
    };
    const toNullableNumber = (value, fallback) => {
        if (value === undefined) return fallback;
        if (value === null || value === '') return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    };

    console.log(`[COMPANY_PROFILE][SAVE] updating fields for company ${companyId}`);
    console.log(`[COMPANY_REQUIREMENTS][PUT] RECEIVED PAYLOAD for company ${companyId}:`, Object.keys(req.body));

    try {
        const current = await db.get(
            `SELECT * FROM company_requirements WHERE company_id = ?`,
            companyId
        );

        const nextReqCdl =
            req_cdl !== undefined ? !!req_cdl :
            current ? readDbBoolean(current.req_cdl) : true;
        const nextReqLicenseTypes =
            req_license_types !== undefined ? parseArrayField(req_license_types) : parseArrayField(current?.req_license_types);
        const nextReqEndorsements =
            req_endorsements !== undefined ? parseArrayField(req_endorsements) : parseArrayField(current?.req_endorsements);
        const nextReqOperationTypes =
            req_operation_types !== undefined ? parseArrayField(req_operation_types) : parseArrayField(current?.req_operation_types);
        const nextReqModalities =
            req_modalities !== undefined ? parseArrayField(req_modalities) : parseArrayField(current?.req_modalities);
        const nextReqTruck =
            req_truck !== undefined ? !!req_truck :
            current ? readDbBoolean(current.req_truck) : false;
        const nextOfferedPaymentMethods =
            offered_payment_methods !== undefined ? parseArrayField(offered_payment_methods) : parseArrayField(current?.offered_payment_methods);
        const nextReqRelationships =
            req_relationships !== undefined ? parseArrayField(req_relationships) : parseArrayField(current?.req_relationships);
        const nextAvailability =
            normalizeAvailability(
                availability !== undefined ? availability : current?.availability
            ) || 'Immediate';
        const nextReqExperienceYears =
            toIntOr(req_experience_years, current?.req_experience_years ?? 0);
        const nextPayPerMileMin =
            toNullableNumber(pay_per_mile_min, current?.pay_per_mile_min ?? null);
        const nextPayPerMileMax =
            toNullableNumber(pay_per_mile_max, current?.pay_per_mile_max ?? null);
        const nextRequiresTravelInterview =
            requires_travel_interview !== undefined ? !!requires_travel_interview :
            current ? readDbBoolean(current.requires_travel_interview) : false;
        const nextHomeTime =
            home_time !== undefined ? home_time : (current?.home_time ?? 'Flexible');
        const nextOfferedFreightTypes =
            offered_freight_types !== undefined ? offered_freight_types : (current?.offered_freight_types ?? '');

        const sql = db.IS_POSTGRES
            ? `INSERT INTO company_requirements (
                company_id, req_cdl, req_license_types, req_endorsements, req_operation_types, 
                req_modalities, req_truck, offered_payment_methods, req_relationships, 
                availability, req_experience_years, 
                pay_per_mile_min, pay_per_mile_max, requires_travel_interview, 
                home_time, offered_freight_types, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP)
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
                pay_per_mile_min=EXCLUDED.pay_per_mile_min,
                pay_per_mile_max=EXCLUDED.pay_per_mile_max,
                requires_travel_interview=EXCLUDED.requires_travel_interview,
                home_time=EXCLUDED.home_time,
                offered_freight_types=EXCLUDED.offered_freight_types,
                updated_at=CURRENT_TIMESTAMP`
            : `INSERT INTO company_requirements (
                company_id, req_cdl, req_license_types, req_endorsements, req_operation_types, 
                req_modalities, req_truck, offered_payment_methods, req_relationships, 
                availability, req_experience_years, 
                pay_per_mile_min, pay_per_mile_max, requires_travel_interview, 
                home_time, offered_freight_types, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;

        const params = [
            companyId,
            toDbBoolean(nextReqCdl),
            serializeArrayField(nextReqLicenseTypes),
            serializeArrayField(nextReqEndorsements),
            serializeArrayField(nextReqOperationTypes),
            serializeArrayField(nextReqModalities),
            toDbBoolean(nextReqTruck),
            serializeArrayField(nextOfferedPaymentMethods),
            serializeArrayField(nextReqRelationships),
            nextAvailability,
            nextReqExperienceYears,
            nextPayPerMileMin,
            nextPayPerMileMax,
            toDbBoolean(nextRequiresTravelInterview),
            nextHomeTime,
            nextOfferedFreightTypes
        ];

        if (!db.IS_POSTGRES) {
            await db.run('DELETE FROM company_requirements WHERE company_id = ?', companyId);
        }
        await db.run(sql, ...params);

        // Update company fields in empresas table
        if (company_logo !== undefined || company_bio !== undefined || contact_person !== undefined || contact_phone !== undefined) {
            let empSql = 'UPDATE empresas SET ';
            let empParams = [];
            if (company_logo !== undefined) {
                empSql += 'company_logo = ?, ';
                empParams.push(company_logo);
            }
            if (company_bio !== undefined) {
                empSql += 'company_bio = ?, ';
                empParams.push(company_bio);
            }
            if (contact_person !== undefined) {
                empSql += 'contact_person = ?, ';
                empParams.push(contact_person);
            }
            if (contact_phone !== undefined) {
                empSql += 'contact_phone = ?, ';
                empParams.push(contact_phone);
            }
            empSql += 'updated_at = ?';
            empParams.push(nowIso());
            empSql += ' WHERE id = ?';
            empParams.push(companyId);
            await db.run(empSql, ...empParams);
        }

        // --- NEW: Insert into normalized bridge tables for lazy matching engine ---

        // 1. Clear old bridge entries
        await db.run('DELETE FROM company_req_operation_types WHERE company_id = ?', companyId);
        await db.run('DELETE FROM company_req_license_types WHERE company_id = ?', companyId);

        // 2. Insert new operation_types
        const arrOpTypes = nextReqOperationTypes;
        if (arrOpTypes.length > 0) {
            console.log(`[COMPANY_REQUIREMENTS] INSERT operation_types: ${arrOpTypes.length}`);
            for (const v of arrOpTypes) {
                if (v && v.trim()) {
                    await db.run(`INSERT INTO company_req_operation_types (company_id, value) VALUES (?, ?) ON CONFLICT DO NOTHING`, companyId, v.trim().toLowerCase());
                }
            }
        }

        // 3. Insert new license_types
        const arrLicTypes = nextReqLicenseTypes;
        if (arrLicTypes.length > 0) {
            console.log(`[COMPANY_REQUIREMENTS] INSERT license_types: ${arrLicTypes.length}`);
            for (const v of arrLicTypes) {
                if (v && v.trim()) {
                    await db.run(`INSERT INTO company_req_license_types (company_id, value) VALUES (?, ?) ON CONFLICT DO NOTHING`, companyId, v.trim().toLowerCase());
                }
            }
        }

        // Set search status ON instantly
        await db.run(`UPDATE empresas SET search_status = 'ON', updated_at = ? WHERE id = ?`, nowIso(), companyId);

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
        await db.run("UPDATE empresas SET search_status = ?, updated_at = ? WHERE id = ?", status, nowIso(), req.user.id);
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
        const context = await getDriverReactivationContext(db, req.user.id);
        res.json(buildDriverReactivationPayload(status, context));
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
        const current = await db.get("SELECT search_status FROM drivers WHERE id = ?", req.user.id);
        const persistedStatus = current ? (current.search_status || 'ON') : 'ON';
        const context = await getDriverReactivationContext(db, req.user.id);

        if (status === 'ON' && context.isCurrentlyHired) {
            return res.status(409).json({
                ...buildDriverReactivationPayload(persistedStatus, context),
                error: 'reactivation_confirmation_required',
                message: !context.featureAvailable
                    ? 'Driver reactivation is unavailable until the required schema updates are applied.'
                    : context.reactivationStatus === 'denied_by_company'
                    ? 'Your last hiring company reported that you still work there.'
                    : 'Your last hiring company must confirm that you no longer work there before matching can resume.'
            });
        }
        const now = nowIso();
        if (status === 'ON') {
            // Atomic guard against races with concurrent company denial/hiring state changes.
            const updateResult = await db.run(`
                UPDATE drivers
                SET search_status = ?, updated_at = ?
                WHERE id = ?
                  AND NOT EXISTS (
                    SELECT 1
                    FROM potential_matches pm
                    WHERE pm.driver_id = drivers.id
                      AND pm.status = 'HIRED'
                  )
            `, status, now, req.user.id);

            if (getMutationCount(updateResult) !== 1) {
                const refreshedContext = await getDriverReactivationContext(db, req.user.id);
                const refreshedStatusRow = await db.get("SELECT search_status FROM drivers WHERE id = ?", req.user.id);
                const refreshedStatus = refreshedStatusRow ? (refreshedStatusRow.search_status || 'ON') : 'ON';
                return res.status(409).json({
                    ...buildDriverReactivationPayload(refreshedStatus, refreshedContext),
                    error: 'reactivation_confirmation_required',
                    message: refreshedContext.reactivationStatus === 'denied_by_company'
                        ? 'Your last hiring company reported that you still work there.'
                        : 'Your last hiring company must confirm that you no longer work there before matching can resume.'
                });
            }
            return res.json(await getFreshDriverReactivationPayload(req.user.id));
        }

        await db.run("UPDATE drivers SET search_status = ?, updated_at = ? WHERE id = ?", status, now, req.user.id);
        res.json(await getFreshDriverReactivationPayload(req.user.id));
    } catch (e) {
        console.error('Error updating driver search_status:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.post('/api/driver/reactivation-requests', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Only drivers can request reactivation' });
    try {
        const currentStatus = await db.get("SELECT search_status FROM drivers WHERE id = ?", req.user.id);
        const persistedStatus = currentStatus ? (currentStatus.search_status || 'ON') : 'ON';
        const context = await getDriverReactivationContext(db, req.user.id);

        if (!context.lastHire || !context.isCurrentlyHired) {
            return res.status(409).json({
                ...buildDriverReactivationPayload(persistedStatus, context),
                error: 'no_current_hiring_company',
                message: 'No active hiring company was found for this driver.'
            });
        }

        if (context.reactivationStatus === 'pending_company_confirmation') {
            return res.json({
                ...buildDriverReactivationPayload(persistedStatus, context),
                message: 'Your request is already waiting for company confirmation.'
            });
        }

        if (context.reactivationStatus === 'denied_by_company') {
            return res.status(409).json({
                ...buildDriverReactivationPayload(persistedStatus, context),
                error: 'reactivation_denied',
                message: 'Your last hiring company reported that you still work there.'
            });
        }

        if (!(await canCreateDriverReactivationRequests(db))) {
            return res.status(503).json({
                ...buildDriverReactivationPayload(persistedStatus, context),
                ...buildDriverReactivationFeatureUnavailableError()
            });
        }

        const requestedAt = nowIso();
        const driverNotes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : null;
        const tx = await db.beginTransaction();
        let requestId = null;
        try {
            const insert = await tx.run(`
                INSERT INTO driver_reactivation_requests (
                    driver_id, company_id, match_id, status, requested_at, responded_at, company_response,
                    driver_notes, company_notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)
            `, req.user.id, context.lastHire.company_id, context.lastHire.match_id, 'pending_company_confirmation', requestedAt, driverNotes, requestedAt, requestedAt);
            requestId = insert.lastInsertRowid || null;

            await tx.run("UPDATE drivers SET search_status = 'OFF', updated_at = ? WHERE id = ?", requestedAt, req.user.id);
            await tx.commit();
        } catch (txErr) {
            await tx.rollback();
            if (isPendingReactivationDuplicateError(txErr)) {
                const refreshedContext = await getDriverReactivationContext(db, req.user.id);
                return res.json({
                    ...buildDriverReactivationPayload(persistedStatus, refreshedContext),
                    message: 'Your request is already waiting for company confirmation.'
                });
            }
            throw txErr;
        }

        await runBestEffortSideEffect('[ReactivationPush][Company]', async () => {
            await sendPush(
                context.lastHire.company_id,
                'empresa',
                'Driver reactivation request',
                'A hired driver asked to appear again for new job opportunities.'
            );
        });

        await runBestEffortSideEffect('[ReactivationAudit][Request]', async () => {
            await auditLog(
                'driver_reactivation_requested',
                req.user.id,
                requestId || context.lastHire.match_id || req.user.id,
                {
                    driver_id: req.user.id,
                    company_id: context.lastHire.company_id,
                    match_id: context.lastHire.match_id
                },
                req
            );
        });

        res.json({
            ...(await getFreshDriverReactivationPayload(req.user.id)),
            message: 'Your request was sent to the last hiring company for confirmation.'
        });
    } catch (e) {
        console.error('Error creating driver reactivation request:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.get('/api/company/reactivation-requests', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies can access reactivation requests' });
    try {
        if (!(await hasDriverReactivationTable(db))) {
            return res.status(503).json(buildDriverReactivationFeatureUnavailableError());
        }
        const scopeIds = await getCompanyScopeIds(req.user.id);
        const scopeIn = scopeIds.map(() => '?').join(',');
        const rows = await db.all(`
            SELECT
                r.id,
                r.driver_id,
                r.company_id,
                r.match_id,
                r.status,
                r.requested_at,
                r.responded_at,
                r.company_response,
                r.driver_notes,
                d.nombre AS driver_name
            FROM driver_reactivation_requests r
            LEFT JOIN drivers d ON d.id = r.driver_id
            WHERE r.company_id IN (${scopeIn})
              AND r.status = 'pending_company_confirmation'
            ORDER BY r.requested_at ASC, r.id ASC
        `, ...scopeIds);

        res.json({ ok: true, requests: rows || [] });
    } catch (e) {
        console.error('Error fetching company reactivation requests:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.post('/api/company/reactivation-requests/:id/respond', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies can respond to reactivation requests' });
    const requestId = parseInt(req.params.id, 10);
    const response = String(req.body?.response || '').trim();
    const validResponses = ['still_employed', 'no_longer_employed'];
    if (!Number.isFinite(requestId)) return res.status(400).json({ error: 'Invalid request id' });
    if (!validResponses.includes(response)) return res.status(400).json({ error: 'Invalid response' });

    try {
        if (!(await hasDriverReactivationTable(db))) {
            return res.status(503).json(buildDriverReactivationFeatureUnavailableError());
        }
        const scopeIds = await getCompanyScopeIds(req.user.id);
        const scopeIn = scopeIds.map(() => '?').join(',');
        const requestRow = await db.get(`
            SELECT
                r.id,
                r.driver_id,
                r.company_id,
                r.match_id,
                r.status,
                r.requested_at,
                d.nombre AS driver_name
            FROM driver_reactivation_requests r
            LEFT JOIN drivers d ON d.id = r.driver_id
            WHERE r.id = ?
              AND r.company_id IN (${scopeIn})
        `, requestId, ...scopeIds);

        if (!requestRow) return res.status(404).json({ error: 'Reactivation request not found' });

        const respondedAt = nowIso();
        const nextStatus = response === 'no_longer_employed' ? 'approved_by_company' : 'denied_by_company';
        const companyNotes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : null;

        const tx = await db.beginTransaction();
        try {
            const resolveResult = await tx.run(`
                UPDATE driver_reactivation_requests
                SET status = ?, responded_at = ?, company_response = ?, company_notes = ?, updated_at = ?
                WHERE id = ?
                  AND status = 'pending_company_confirmation'
            `, nextStatus, respondedAt, response, companyNotes, respondedAt, requestId);

            if (getMutationCount(resolveResult) !== 1) {
                await tx.rollback();
                return res.status(409).json({ error: 'Reactivation request already resolved' });
            }

            if (response === 'no_longer_employed') {
                await closePriorEmploymentRelationship(db, requestRow.match_id, respondedAt, tx);
                await tx.run("UPDATE drivers SET search_status = 'ON', updated_at = ? WHERE id = ?", respondedAt, requestRow.driver_id);
            } else {
                await tx.run("UPDATE drivers SET search_status = 'OFF', updated_at = ? WHERE id = ?", respondedAt, requestRow.driver_id);
            }

            await tx.commit();
        } catch (txErr) {
            await tx.rollback();
            throw txErr;
        }

        await runBestEffortSideEffect('[ReactivationPush][Driver]', async () => {
            await sendPush(
                requestRow.driver_id,
                'driver',
                response === 'no_longer_employed' ? 'Reactivation approved' : 'Reactivation denied',
                response === 'no_longer_employed'
                    ? 'Your last hiring company confirmed that you can receive new matches again.'
                    : 'Your last hiring company reported that you still work there.'
            );
        });

        await runBestEffortSideEffect('[ReactivationAudit][Response]', async () => {
            await auditLog(
                response === 'no_longer_employed' ? 'driver_reactivation_approved' : 'driver_reactivation_denied',
                req.user.id,
                requestId,
                {
                    driver_id: requestRow.driver_id,
                    company_id: requestRow.company_id,
                    match_id: requestRow.match_id,
                    response
                },
                req
            );
        });

        res.json({
            ok: true,
            request: {
                id: requestId,
                status: nextStatus,
                responded_at: respondedAt,
                company_response: response
            },
            driver_status: await getFreshDriverReactivationPayload(requestRow.driver_id)
        });
    } catch (e) {
        console.error('Error responding to reactivation request:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// GET active banner for drivers
app.get('/api/driver/banner', authenticateToken, async (req, res) => {
    try {
        const banner = await db.get(`
            SELECT image_url, is_active
            FROM driver_banner
            WHERE is_active = true
            ORDER BY updated_at DESC
            LIMIT 1
        `);
        res.json(banner || null);
    } catch (e) {
        // fail silently as per requirements
        res.json(null);
    }
});

// --- DRIVER PROFILE ---
app.get('/api/drivers/profile', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Only drivers can access' });

    try {
        const row = await db.get("SELECT *, COALESCE(willing_travel_interview, false) AS willing_travel_interview FROM drivers WHERE id = ?", req.user.id);
        if (!row) return res.status(404).json({ error: 'Driver not found' });

        const jsonFields = [
            'license_types', 'endorsements', 'operation_types',
            'job_preferences', 'payment_methods', 'work_relationships',
            'trailer_experience'
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

        // Phase 6: Attach driver media (photos)
        try {
            const media = await db.get("SELECT profile_photo_base64, license_front_base64, license_back_base64, photo_consent_at FROM driver_media WHERE driver_id = ?", req.user.id);
            if (media) {
                result.profile_photo_base64 = media.profile_photo_base64 || null;
                result.license_front_base64 = media.license_front_base64 || null;
                result.license_back_base64 = media.license_back_base64 || null;
                result.photo_consent_at = media.photo_consent_at || null;
            }
        } catch (mediaErr) {
            console.warn('[DRIVER_PROFILE] driver_media table may not exist yet:', mediaErr.message);
        }

        res.json(result);
    } catch (e) {
        console.error('Error fetching driver profile:', e.message);
        res.status(500).json({ error: 'Server Error' });
    }
});

// --- INTERNAL ADMIN / BANNER CONTROL ---

const BANNER_TOKEN = process.env.SECURE_BANNER_TOKEN || 'DF_INTERNAL_2026';

app.get('/internal/banner-control', async (req, res) => {
    const { token } = req.query;
    if (token !== BANNER_TOKEN) return res.status(403).send('Forbidden: Invalid Token');

    try {
        const current = await db.get(`SELECT image_url FROM driver_banner WHERE is_active = true ORDER BY updated_at DESC LIMIT 1`);
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Banner Control</title>
                <style>
                    body { font-family: sans-serif; padding: 40px; background: #0d1117; color: #c9d1d9; }
                    .card { background: #161b22; padding: 20px; border-radius: 8px; border: 1px solid #30363d; max-width: 500px; }
                    input { width: 100%; padding: 10px; margin: 10px 0; background: #0d1117; color: white; border: 1px solid #30363d; border-radius: 4px; box-sizing: border-box; }
                    button { background: #238636; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; }
                    img { max-width: 100%; border-radius: 8px; margin-top: 10px; }
                    .status { margin-bottom: 20px; font-size: 0.9rem; color: #8b949e; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>DF Banner Control</h2>
                    <div class="status">Current Banner:</div>
                    ${current ? `<img src="${current.image_url}" />` : '<p>No active banner</p>'}
                    <hr style="border: 0; border-top: 1px solid #30363d; margin: 20px 0;">
                    <form action="/api/admin/banner?token=${token}" method="POST">
                        <label>New Image URL:</label>
                        <input type="text" name="imageUrl" placeholder="https://..." required>
                        <button type="submit">Activate Banner</button>
                    </form>
                </div>
            </body>
            </html>
        `);
    } catch (e) {
        res.status(500).send('Server Error');
    }
});

// Endpoint to process banner update
app.post('/api/admin/banner', async (req, res) => {
    const { token } = req.query;
    if (token !== BANNER_TOKEN) return res.status(403).json({ error: 'Forbidden' });

    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'Image URL required' });

    try {
        await db.run('UPDATE driver_banner SET is_active = false, updated_at = ?', nowIso());
        await db.run('INSERT INTO driver_banner (image_url, is_active, updated_at) VALUES (?, true, ?)', imageUrl, nowIso());
        res.send(`
            <div style="font-family: sans-serif; padding: 40px; background: #0d1117; color: white; text-align: center;">
                <h2>✅ Banner Updated</h2>
                <p>The new banner is now active in the driver app.</p>
                <a href="/internal/banner-control?token=${token}" style="color: #58a6ff;">Return to control</a>
            </div>
        `);
    } catch (e) {
        res.status(500).json({ error: e.message });
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
    console.log("[DRIVER_PROFILE][PUT] RECEIVED PAYLOAD:", JSON.stringify(safePayload).slice(0, 500));

    const {
        has_cdl, license_types, endorsements, operation_types,
        experience_years, job_preferences,
        has_truck, payment_methods, work_relationships, availability,
        // Phase 6 new fields
        city, state, weekly_miles, longest_otr, trailer_experience,
        accidents_3y, tickets_3y, home_time, preferred_freight,
        preferred_region, willing_to_relocate, driver_bio, willing_travel_interview,
        // Phase 6 media
        profile_photo_base64, license_front_base64, license_back_base64, photo_consent_at
    } = body;

    try {
        let sql, params;

        if (db.IS_POSTGRES) {
            sql = `UPDATE drivers SET 
                has_cdl = ?, license_types = ?::jsonb, endorsements = ?::jsonb, operation_types = ?::jsonb,
                experience_years = ?, job_preferences = ?::jsonb,
                has_truck = ?, payment_methods = ?::jsonb, work_relationships = ?::jsonb, availability = ?,
                city = ?, state = ?, weekly_miles = ?, longest_otr = ?,
                trailer_experience = ?::jsonb, accidents_3y = ?, tickets_3y = ?,
                home_time = ?, preferred_freight = ?, preferred_region = ?,
                willing_to_relocate = ?, driver_bio = ?, willing_travel_interview = ?,
                updated_at = ?
                WHERE id = ?`;
            params = [
                !!has_cdl,
                JSON.stringify(safeJson(license_types, [])),
                JSON.stringify(safeJson(endorsements, [])),
                JSON.stringify(safeJson(operation_types, [])),
                experience_years || 0,
                JSON.stringify(safeJson(job_preferences, [])),
                !!has_truck,
                JSON.stringify(safeJson(payment_methods, [])),
                JSON.stringify(safeJson(work_relationships, [])),
                availability || 'Immediate',
                city || null, state || null,
                weekly_miles || null, longest_otr || null,
                JSON.stringify(safeJson(trailer_experience, [])),
                accidents_3y || 0, tickets_3y || 0,
                home_time || null, preferred_freight || null, preferred_region || null,
                !!willing_to_relocate, driver_bio || null, !!willing_travel_interview,
                nowIso(),
                driverId
            ];
        } else {
            sql = `UPDATE drivers SET 
                has_cdl = ?, license_types = ?, endorsements = ?, operation_types = ?,
                experience_years = ?, job_preferences = ?,
                has_truck = ?, payment_methods = ?, work_relationships = ?, availability = ?,
                city = ?, state = ?, weekly_miles = ?, longest_otr = ?,
                trailer_experience = ?, accidents_3y = ?, tickets_3y = ?,
                home_time = ?, preferred_freight = ?, preferred_region = ?,
                willing_to_relocate = ?, driver_bio = ?, willing_travel_interview = ?,
                updated_at = ?
                WHERE id = ?`;
            params = [
                +!!has_cdl,
                JSON.stringify(safeJson(license_types, [])),
                JSON.stringify(safeJson(endorsements, [])),
                JSON.stringify(safeJson(operation_types, [])),
                experience_years || 0,
                JSON.stringify(safeJson(job_preferences, [])),
                +!!has_truck,
                JSON.stringify(safeJson(payment_methods, [])),
                JSON.stringify(safeJson(work_relationships, [])),
                availability || 'Immediate',
                city || null, state || null,
                weekly_miles || null, longest_otr || null,
                JSON.stringify(safeJson(trailer_experience, [])),
                accidents_3y || 0, tickets_3y || 0,
                home_time || null, preferred_freight || null, preferred_region || null,
                +!!willing_to_relocate, driver_bio || null, +!!willing_travel_interview,
                nowIso(),
                driverId
            ];
        }

        console.log("[DRIVER_PROFILE][PUT] EXECUTING SQL:", sql);
        console.log("[DRIVER_PROFILE][PUT] WITH PARAMS (count):", params.length);

        await db.run(sql, ...params);

        // --- Phase 6: Upsert driver_media for photos ---
        if (profile_photo_base64 || license_front_base64 || license_back_base64) {
            try {
                const existingMedia = await db.get('SELECT driver_id FROM driver_media WHERE driver_id = ?', driverId);
                if (existingMedia) {
                    const mediaSql = `UPDATE driver_media SET 
                        profile_photo_base64 = COALESCE(?, profile_photo_base64),
                        license_front_base64 = COALESCE(?, license_front_base64),
                        license_back_base64 = COALESCE(?, license_back_base64),
                        photo_consent_at = COALESCE(?, photo_consent_at),
                        updated_at = ?
                        WHERE driver_id = ?`;
                    await db.run(mediaSql,
                        profile_photo_base64 || null,
                        license_front_base64 || null,
                        license_back_base64 || null,
                        photo_consent_at || null,
                        nowIso(),
                        driverId
                    );
                } else {
                    await db.run(
                        `INSERT INTO driver_media (driver_id, profile_photo_base64, license_front_base64, license_back_base64, photo_consent_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        driverId,
                        profile_photo_base64 || null,
                        license_front_base64 || null,
                        license_back_base64 || null,
                        photo_consent_at || null,
                        nowIso(), nowIso()
                    );
                }
                console.log('[DRIVER_PROFILE] Media saved for driver', driverId);
            } catch (mediaErr) {
                console.warn('[DRIVER_PROFILE] driver_media save failed (table may not exist):', mediaErr.message);
            }
        }

        // --- NEW: Insert into normalized bridge tables for lazy matching engine ---

        // 1. Clear old bridge entries
        await db.run('DELETE FROM driver_operation_types WHERE driver_id = ?', driverId);
        await db.run('DELETE FROM driver_license_types WHERE driver_id = ?', driverId);
        await db.run('DELETE FROM driver_endorsements WHERE driver_id = ?', driverId);
        await db.run('DELETE FROM driver_payment_methods WHERE driver_id = ?', driverId);
        await db.run('DELETE FROM driver_work_relationships WHERE driver_id = ?', driverId);
        await db.run('DELETE FROM driver_job_preferences WHERE driver_id = ?', driverId);

        // Helper for bridge inserts
        const insertBridge = async (table, arr) => {
            const arrSafe = Array.isArray(arr) ? arr : [];
            for (const v of arrSafe) {
                if (v && v.trim()) {
                    await db.run(`INSERT INTO ${table} (driver_id, value) VALUES (?, ?) ON CONFLICT DO NOTHING`, driverId, v.trim().toLowerCase());
                }
            }
        };

        // 2. Insert new bridge entries
        await insertBridge('driver_operation_types', operation_types);
        await insertBridge('driver_license_types', license_types);
        await insertBridge('driver_endorsements', endorsements);
        await insertBridge('driver_payment_methods', payment_methods);
        await insertBridge('driver_work_relationships', work_relationships);
        await insertBridge('driver_job_preferences', job_preferences);

        console.log(`[DRIVER_PROFILE] Bridge tables updated`);

        // Keep hired drivers blocked from casually re-entering matching until company reactivation is approved.
        const reactivationContext = await getDriverReactivationContext(db, driverId);
        const nextSearchStatus = reactivationContext.isCurrentlyHired ? 'OFF' : 'ON';
        await db.run(`UPDATE drivers SET search_status = ?, updated_at = ? WHERE id = ?`, nextSearchStatus, nowIso(), driverId);

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
            JOIN potential_matches pm ON t.match_id = pm.id
        `;
        if (isDriver) {
            sql += ` WHERE t.driver_id = ? AND (pm.status = 'HIRED' OR (pm.status = 'CLOSED' AND (pm.resolution_company = 'HIRED' OR pm.resolution_driver = 'HIRED')))`;
        } else if (isEmpresa) {
            sql += ` WHERE t.company_id = ? AND (pm.status = 'HIRED' OR (pm.status = 'CLOSED' AND (pm.resolution_company = 'HIRED' OR pm.resolution_driver = 'HIRED')))`;
        } else {
            return res.status(403).json({ error: 'Forbidden' });
        }
        sql += ` ORDER BY t.created_at DESC LIMIT 100`;

        const rows = await db.all(sql, req.user.id);
        console.log(`[TicketScope] actor=${isDriver ? 'driver' : 'company'} count=${rows.length} visible=true`);

        if (isEmpresa) {
            const sanitized = await Promise.all((rows || []).map(async (row) => {
                const unlocked = await isCompanyContactUnlockedForTicketContext({
                    ticketId: row.id,
                    companyId: req.user.id,
                    matchId: row.match_id,
                    driverId: row.driver_id
                }, db);
                if (!unlocked) {
                    return {
                        ...row,
                        driver_name: null,
                        locked: true,
                        preview: true
                    };
                }
                return {
                    ...row,
                    locked: false,
                    preview: false
                };
            }));
            return res.json(sanitized);
        }

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
// startQueueWorker() is now invoked inside startServer() to ensure schema readiness

const STARTUP_TIME = new Date().toISOString();
console.log(`[ConsentFlow] Production startup at: ${STARTUP_TIME}`);

app.get('/api/diagnostics/version', (req, res) => {
    res.json({ version: '1.3.8-consent-fix-verified', status: 'deploy-verified', startup_at: STARTUP_TIME });
});

app.get('/api/diagnostics/uptime', (req, res) => {
    res.json({ startup_at: STARTUP_TIME, now: new Date().toISOString() });
});

app.get('/api/diagnostics/debug-duplicates', async (req, res) => {
    try {
        const sqlCompanies = `
            SELECT id, nombre, contacto, created_at, account_state, verified 
            FROM empresas 
            WHERE contacto = 'luxuryservicesfl@gmail.com' 
            ORDER BY id
        `;
        const sqlMatch = `
            SELECT id, company_id, driver_id, status 
            FROM potential_matches 
            WHERE id = 136252
        `;

        const companies = await db.all(sqlCompanies);
        const match = await db.get(sqlMatch);

        res.json({
            match_136252: match,
            duplicate_companies: companies
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
        `UPDATE driver_leads SET status='CLAIMED', claimed_driver_id=?, updated_at=?
         WHERE id=? AND status IN ('NEW','INVITED')`,
        driverId, nowIso(), lead.id
    );
    console.log(`[LeadClaim] driver_id=${driverId} lead_id=${lead.id} company_id=${lead.company_id}`);
    await trackLeadFunnelEvent('lead_claimed', { lead_id: lead.id, driver_id: driverId, company_id: lead.company_id, metadata: { claim_method: "auto_email_match" } });
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
        await trackLeadFunnelEvent('lead_created', { lead_id: result.lastInsertRowid, company_id: req.user.id, metadata: { source: "manual", is_synthetic: false } });
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
                const res = await db.run(
                    `INSERT INTO driver_leads (company_id, name, phone, email, notes) VALUES (?, ?, ?, ?, ?)`,
                    req.user.id, name, phone, email, notes
                );
                await trackLeadFunnelEvent('lead_created', { lead_id: res?.lastInsertRowid || null, company_id: req.user.id, metadata: { source: "manual_bulk", is_synthetic: false } });
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
                last_generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
             VALUES (?, ?, ?)
             ON CONFLICT (user_type, user_id)
             DO UPDATE SET last_generated_at = ?`,
            userType, userId, nowIso(), nowIso()
        );
    } catch (e) {
        if (String(e.message || "").includes("does not exist") || e.code === "42P01") {
            await ensureUserMatchGenerationLogTable();
            try {
                await db.run(
                    `INSERT INTO user_match_generation_log (user_type, user_id, last_generated_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT (user_type, user_id)
                     DO UPDATE SET last_generated_at = ?`,
                    userType, userId, nowIso(), nowIso()
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

async function getCompanyScopeIds(companyId) {
    try {
        const queryField = db.IS_POSTGRES ? 'email' : 'contacto';
        const row = await db.get(`SELECT ${queryField} AS auth_email FROM empresas WHERE id = ?`, companyId);
        if (!row || !row.auth_email) return [companyId];
        const normalized = row.auth_email.trim().toLowerCase();

        const duplicates = await db.all(`SELECT id FROM empresas WHERE LOWER(TRIM(${queryField})) = ?`, normalized);
        if (duplicates && duplicates.length > 0) {
            const scopeIds = duplicates.map(d => d.id);
            console.log(`[CompanyScope] login_id=${companyId} -> normalized_contact="${normalized}" -> total_duplicates=${scopeIds.length} -> scope_ids=[${scopeIds.join(',')}]`);
            return scopeIds;
        }
    } catch (e) {
        console.error('[CompanyScope] error:', e.message);
    }
    return [companyId];
}

function buildDriverReactivationFeatureUnavailableError() {
    return {
        ok: false,
        error: 'reactivation_feature_unavailable',
        message: 'Driver reactivation is unavailable until the required schema updates are applied.'
    };
}

async function getFreshDriverReactivationPayload(driverId) {
    const statusRow = await db.get("SELECT search_status FROM drivers WHERE id = ?", driverId);
    const persistedStatus = statusRow ? (statusRow.search_status || 'ON') : 'ON';
    const context = await getDriverReactivationContext(db, driverId);
    return buildDriverReactivationPayload(persistedStatus, context);
}

function buildDriverReactivationPayload(searchStatus, context) {
    const effectiveStatus = context.isCurrentlyHired ? 'OFF' : (searchStatus || 'ON');
    const request = context.latestRequest
        ? {
            id: context.latestRequest.id,
            status: context.latestRequest.status,
            requested_at: context.latestRequest.requested_at,
            responded_at: context.latestRequest.responded_at,
            company_response: context.latestRequest.company_response,
            driver_notes: context.latestRequest.driver_notes || null,
            company_notes: context.latestRequest.company_notes || null
        }
        : null;

    return {
        ok: true,
        status: effectiveStatus,
        persisted_status: searchStatus || effectiveStatus,
        reactivation_feature_available: context.featureAvailable === true,
        is_currently_hired: context.isCurrentlyHired,
        can_request_reactivation: context.canRequestReactivation,
        reactivation_status: context.reactivationStatus,
        last_hiring_company: context.lastHire
            ? {
                id: context.lastHire.company_id,
                name: context.lastHire.company_name || `Company #${context.lastHire.company_id}`,
                match_id: context.lastHire.match_id
            }
            : null,
        reactivation_request: request
    };
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

        const scopeIds = await getCompanyScopeIds(req.user.id);
        const scopeIn = scopeIds.map(() => '?').join(',');

        // 1) Count fresh active matches
        const recentRow = await db.get(
            `SELECT COUNT(*) AS c FROM potential_matches
             WHERE company_id IN (${scopeIn}) AND status NOT IN ('DECLINED','EXPIRED','HIRED_ELSEWHERE','CLOSED') AND created_at >= ?`,
            ...scopeIds, cutoff
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
                        const genCount = await generateMatchesForCompany(req.user.id);
                        if (genCount > 0) {
                            await writeGenerationLog('empresa', req.user.id);
                        } else {
                            console.log(`[matches/candidates] generation produced 0 new matches — skipping cooldown write for company=${req.user.id}`);
                        }
                    } finally {
                        await unlockUserAdvisoryLock(lockKey);
                    }
                }
            }
        }

        // 2.5) Auto-invite matching leads
        try {
            const MAX_INVITE_COUNT = 5;
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
            const leads = await db.all(
                `SELECT id, name, email FROM driver_leads
                 WHERE company_id = ? AND status IN ('NEW','INVITED')
                   AND email IS NOT NULL AND email <> ''
                   AND is_synthetic = false
                   AND (invited_at IS NULL OR invited_at < ?)
                   AND (invite_count IS NULL OR invite_count < ?)
                 LIMIT 10`,
                req.user.id, sevenDaysAgo, MAX_INVITE_COUNT
            );

            if (leads.length > 0) {
                const companyRow = await db.get('SELECT nombre FROM empresas WHERE id = ?', req.user.id);
                const companyName = companyRow ? companyRow.nombre : 'Una empresa';

                for (const lead of leads) {
                    const now = nowIso();
                    await db.run(
                        `UPDATE driver_leads SET invited_at = ?, invite_count = COALESCE(invite_count, 0) + 1, status = 'INVITED', updated_at = ? WHERE id = ?`,
                        now, now, lead.id
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

        // 3) Return matches (existing query + Phase 6 expanded profile)
        const rows = await db.all(`
            SELECT
                pm.id           AS match_id,
                pm.match_score,
                pm.status,
                pm.ticket_id,
                pm.created_at,
                pm.driver_step1_accepted_at,
                pm.company_step1_accepted_at,
                pm.driver_share_consent_at,
                pm.company_share_consent_at,
                d.id            AS driver_id,
                COALESCE(d.nombre, '') AS driver_name,
                COALESCE(d.nombre, '') AS display_name,
                ${db.IS_POSTGRES ? "COALESCE(d.email, '')" : "COALESCE(d.contacto, '')"} AS driver_email,
                COALESCE(d.experience_years, 0) AS experience_years,
                COALESCE(d.license_types, ${db.IS_POSTGRES ? "'[]'::jsonb" : "'[]'"}) AS license_summ,
                COALESCE(d.operation_types, ${db.IS_POSTGRES ? "'[]'::jsonb" : "'[]'"}) AS op_types,
                COALESCE(d.payment_methods, ${db.IS_POSTGRES ? "'[]'::jsonb" : "'[]'"}) AS pay_methods,
                COALESCE(d.availability, '') AS availability,
                d.city AS driver_city,
                d.state AS driver_state,
                d.phone AS driver_phone,
                d.weekly_miles,
                d.longest_otr,
                COALESCE(d.trailer_experience, ${db.IS_POSTGRES ? "'[]'::jsonb" : "'[]'"}) AS trailer_experience,
                COALESCE(d.accidents_3y, 0) AS accidents_3y,
                COALESCE(d.tickets_3y, 0) AS tickets_3y,
                d.home_time,
                d.preferred_freight,
                d.preferred_region,
                ${db.IS_POSTGRES ? 'd.willing_to_relocate' : 'COALESCE(d.willing_to_relocate, 0)'} AS willing_to_relocate,
                d.driver_bio,
                COALESCE(d.has_cdl, ${db.IS_POSTGRES ? 'false' : '0'}) AS has_cdl,
                COALESCE(d.endorsements, ${db.IS_POSTGRES ? "'[]'::jsonb" : "'[]'"}) AS endorsements,
                dm.profile_photo_base64,
                dm.license_front_base64,
                dm.license_back_base64
            FROM potential_matches pm
            JOIN drivers d ON d.id = pm.driver_id
            LEFT JOIN driver_media dm ON dm.driver_id = d.id
            WHERE pm.company_id IN (${scopeIn})
              AND pm.status NOT IN ('DECLINED','EXPIRED','HIRED_ELSEWHERE','CLOSED')
            ORDER BY pm.created_at DESC
        `, ...scopeIds);

        const lockDriverRow = (row) => {
            return {
                ...row,
                locked: true,
                preview: true,
                display_name: buildLockedDriverPreviewName(row),
                driver_name: null,
                driver_email: null,
                driver_phone: null,
                driver_city: null,
                driver_state: null,
                driver_bio: null,
                profile_photo_base64: null,
                license_front_base64: null,
                license_back_base64: null
            };
        };

        const sanitized = await Promise.all(rows.map(async (r) => {
            if (r.status !== 'INFO_SHARED' && r.status !== 'HIRED') {
                return lockDriverRow(r);
            }

            const unlocked = await isCompanyContactUnlockedForTicketContext({
                ticketId: r.ticket_id,
                companyId: req.user.id,
                matchId: r.match_id,
                driverId: r.driver_id
            }, db);
            if (!unlocked) {
                return lockDriverRow(r);
            }

            return { ...r, locked: false, preview: false };
        }));

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
        console.log(`[matches/opportunities] 1. START: Retrieving for ${userType} #${userId}`);
        const freshHours = Number(process.env.MATCH_FRESH_HOURS || 24);
        const minActive = Number(process.env.MATCH_MIN_ACTIVE || 5);
        const cooldownMin = Number(process.env.MATCH_COOLDOWN_MINUTES || 10);
        const cutoff = new Date(Date.now() - freshHours * 3600 * 1000).toISOString();

        const filterColumn = userType === 'driver' ? 'driver_id' : 'company_id';
        const scopeIds = userType === 'empresa' ? await getCompanyScopeIds(userId) : [userId];
        const scopeIn = scopeIds.map(() => '?').join(',');

        if (userType !== 'driver' && userType !== 'empresa') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        console.log(`[matches/opportunities] 2. BEFORE reading driver/company active matches`);
        // 1) Count fresh active matches
        const recentRow = await db.get(
            `SELECT COUNT(*) AS c FROM potential_matches
             WHERE ${filterColumn} IN (${scopeIn}) AND status NOT IN ('DECLINED','EXPIRED','HIRED_ELSEWHERE','CLOSED') AND created_at >= ?`,
            ...scopeIds, cutoff
        );
        const recentCount = recentRow ? parseInt(recentRow.c) : 0;
        console.log(`[matches/opportunities] 3. Count checked: recentActive=${recentCount} min=${minActive}`);

        // 2) Generate if needed (freshness + cooldown + lock)
        if (recentCount < minActive) {
            const lastGen = await getLastGenerationAt(userType, userId);
            const inCooldown = lastGen && (Date.now() - new Date(lastGen).getTime()) < cooldownMin * 60 * 1000;

            if (inCooldown) {
                console.log(`[matches/opportunities] 4. Skipping generation due to cooldown`);
            } else {
                const lockKey = (userType === 'driver' ? 100000 : 200000) + userId;
                const locked = await tryUserAdvisoryLock(lockKey);

                if (!locked) {
                    console.log(`[matches/opportunities] 4. Skipping generation due to lock`);
                } else {
                    try {
                        const { generateMatchesForDriver, generateMatchesForCompany } = require('./lazy_matching');
                        console.log(`[matches/opportunities] 4a. BEFORE generateMatchesFor${userType === 'driver' ? 'Driver' : 'Company'}`);
                        let genCount = 0;
                        if (userType === 'driver') {
                            genCount = await generateMatchesForDriver(userId);
                        } else {
                            genCount = await generateMatchesForCompany(userId);
                        }
                        console.log(`[matches/opportunities] 4b. AFTER generateMatchesFor${userType === 'driver' ? 'Driver' : 'Company'} genCount=${genCount}`);
                        if (genCount > 0) {
                            await writeGenerationLog(userType, userId);
                        } else {
                            console.log(`[matches/opportunities] generation produced 0 new matches — skipping cooldown write for ${userType}=${userId}`);
                        }
                    } finally {
                        await unlockUserAdvisoryLock(lockKey);
                    }
                }
            }
        }

        console.log(`[matches/opportunities] 5. BEFORE final SQL query`);
        // 3) Return matches (existing query)
        const rows = await db.all(`
            SELECT
                pm.id           AS match_id,
                pm.match_score,
                pm.score_breakdown,
                pm.status,
                pm.created_at,
                pm.driver_step1_accepted_at,
                pm.company_step1_accepted_at,
                pm.driver_share_consent_at,
                pm.company_share_consent_at,
                pm.company_id,
                COALESCE(e.nombre, 'Company #' || CAST(pm.company_id AS TEXT)) AS display_name,
                ${db.IS_POSTGRES ? "COALESCE(e.email, e.contacto, '')" : "COALESCE(e.contacto, '')"} AS company_email,
                COALESCE(e.ciudad, '') AS city,
                COALESCE(e.address_state, '') AS address_state,
                COALESCE(e.contact_person, '') AS contact_person,
                COALESCE(e.contact_phone, '') AS contact_phone,
                COALESCE(cr.req_operation_types, '[]') AS op_types,
                COALESCE(cr.offered_payment_methods, '[]') AS pay_methods,
                COALESCE(cr.availability, '') AS availability,
                COALESCE(cr.pay_per_mile_min, 0) AS pay_per_mile_min,
                COALESCE(cr.pay_per_mile_max, 0) AS pay_per_mile_max,
                COALESCE(cr.requires_travel_interview, ${db.IS_POSTGRES ? 'FALSE' : '0'}) AS requires_travel_interview,
                COALESCE(cr.home_time, '') AS home_time,
                COALESCE(cr.offered_freight_types, '') AS offered_freight_types,
                COALESCE(cr.req_modalities, '[]') AS modalities,
                COALESCE(cr.req_endorsements, '[]') AS endorsements,
                e.company_logo,
                e.company_bio
            FROM potential_matches pm
            LEFT JOIN empresas e ON e.id = pm.company_id
            LEFT JOIN company_requirements cr ON cr.company_id = pm.company_id
            WHERE pm.${filterColumn} IN (${scopeIn})
              AND pm.status NOT IN ('DECLINED','EXPIRED','HIRED_ELSEWHERE','CLOSED')
            ORDER BY pm.match_score DESC, pm.created_at DESC
        `, ...scopeIds);

        console.log(`[matches/opportunities] 6. AFTER final SQL query. Rows length: ${rows.length}`);

        // if (rows.length > 0) {
        //     console.log(`[matches/opportunities] 7. First row sample fully raw BEFORE map:`, JSON.stringify(rows[0]));
        // }

        const sanitized = rows.map(r => {
            let opTypes = r.op_types;
            if (typeof opTypes === 'string') {
                try { opTypes = JSON.parse(opTypes); } catch (e) { }
            }

            let payMethods = r.pay_methods;
            if (typeof payMethods === 'string') {
                try { payMethods = JSON.parse(payMethods); } catch (e) { }
            }

            let breakdown = r.score_breakdown;
            if (typeof breakdown === 'string') {
                try { breakdown = JSON.parse(breakdown); } catch (e) { }
            }

            const cleanRow = { ...r, op_types: opTypes, pay_methods: payMethods, score_breakdown: breakdown };

            if (cleanRow.status !== 'INFO_SHARED' && cleanRow.status !== 'HIRED') {
                const cId = String(cleanRow.company_id || cleanRow.id);
                const shortId = cId.slice(-4).toUpperCase();
                
                cleanRow.display_name = `Company #${shortId}`;
                cleanRow.company_name = null; // Hard block redundant real name
                
                cleanRow.company_email = null;
                cleanRow.city = 'Location Hidden';
                cleanRow.address_state = 'TBD';
                cleanRow.contact_person = null;
                cleanRow.contact_phone = null;
            }
            return cleanRow;
        });

        console.log(`[matches/opportunities] 8. BEFORE res.json`);
        res.json(sanitized);
    } catch (e) {
        console.error('[matches/opportunities] FATAL ERROR CATCHED:', {
            message: e.message,
            stack: e.stack,
            code: e.code,
            detail: e.detail,
            position: e.position
        });
        res.status(500).json({ error: 'Server error', details: e.message });
    }
});

// ─── MATCH STATE TRANSITIONS ───────────────────────────────────────────────────

const updateMatchStatus = async (req, res, newStatus) => {
    const matchId = req.params.id;
    const userId = req.user.id;
    const userType = req.user.type; // 'empresa' or 'driver'
    const now = new Date().toISOString();

    // --- BASIC COMPANY VERIFICATION (ANTI-FAKE) ---
    if (userType === 'empresa') {
        const emp = await db.get('SELECT verification_status FROM empresas WHERE id = ?', userId);
        if (emp && emp.verification_status !== 'approved') {
            return res.status(403).json({ error: 'Empresa no verificada', requires_verification: true });
        }
    }

    try {
        if (userType === 'empresa') {
            const emp = await db.get('SELECT billing_suspended FROM empresas WHERE id = ?', userId);
            if (emp && (emp.billing_suspended === true || emp.billing_suspended === 1)) {
                return res.status(402).json({ error: 'Cuenta suspendida por facturación pendiente' });
            }
        }

        const match = await db.get('SELECT * FROM potential_matches WHERE id = ?', matchId);
        if (!match) return res.status(404).json({ error: 'Match not found' });

        if (userType === 'empresa') {
            const scopeIds = await getCompanyScopeIds(userId);
            if (!scopeIds.includes(match.company_id)) return res.status(403).json({ error: 'Unauthorized scope' });
        }
        if (userType === 'driver' && match.driver_id !== userId) return res.status(403).json({ error: 'Unauthorized driver' });

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

        // --- PUSH: Inactive to Active (Revival) ---
        const inactiveStatuses = ['DECLINED', 'CLOSED', 'EXPIRED', 'HIRED_ELSEWHERE'];
        const activeStatuses = ['ACCEPTED', 'PREMATCH_READY'];
        if (inactiveStatuses.includes(match.status) && activeStatuses.includes(newStatus)) {
            if (userType === 'empresa') {
                try { await sendPush(match.driver_id, 'driver', '¡Nuevo Match!', 'Tienes una nueva oportunidad de trabajo. Revisa tus matches.'); } catch (e) { console.error('[MatchPush]', e.message); }
            } else {
                try { await sendPush(match.company_id, 'empresa', '¡Nuevo Match!', 'Un chofer está interesado en tu vacante. Revisa tus matches.'); } catch (e) { console.error('[MatchPush]', e.message); }
            }
        }

        // --- PUSH: Notify both parties when match transitions to PREMATCH_READY ---
        if (newStatus === 'PREMATCH_READY' && match.status !== 'PREMATCH_READY') {
            try { await sendPush(match.driver_id, 'driver', '¡Match Confirmado!', 'La empresa también aceptó tu match. Ya puedes compartir tu información.'); } catch (e) { console.error('[MatchPush]', e.message); }
            try { await sendPush(match.company_id, 'empresa', '¡Match Confirmado!', 'El chofer también aceptó tu match. Ya puedes compartir tu información.'); } catch (e) { console.error('[MatchPush]', e.message); }
        }

        console.log(`[Matches] Match ${matchId} updated to ${newStatus} by ${userType} ${userId}`);
        res.json({ success: true, status: newStatus });
    } catch (e) {
        console.error(`[Matches] Error updating match ${matchId} to ${newStatus}:`, e);
        res.status(500).json({ error: 'Server error' });
    }
};

// ─── FREE SHARE CREDIT HELPER ───────────────────────────────────────────────
// Atomically decrements free_info_shares_remaining if > 0.
// Returns true if credit was consumed, false if none remained.
async function consumeFreeShareCredit(companyId, tx) {
    const result = await tx.run(`
        UPDATE empresas
        SET free_info_shares_remaining = free_info_shares_remaining - 1,
            updated_at = ?
        WHERE id = ?
          AND COALESCE(free_info_shares_remaining, 0) > 0
    `, nowIso(), companyId);
    const consumed = getMutationCount(result) > 0;
    console.log(`[Paywall] consumeFreeShareCredit: company=${companyId} consumed=${consumed}`);
    return consumed;
}

const finalizeShare = async (matchId, runner = db) => {
    const now = new Date().toISOString();
    const match = await runner.get('SELECT driver_id FROM potential_matches WHERE id = ?', parseInt(matchId, 10));
    if (!match) return;

    // 1. Mark winning match as shared
    await runner.run(
        "UPDATE potential_matches SET status = 'INFO_SHARED', info_shared_at = ?, updated_at = ? WHERE id = ?",
        now, now, parseInt(matchId, 10)
    );

    // 2. Proactively close competing handshakes (Neutral terminal state: CLOSED)
    await runner.run(
        "UPDATE potential_matches SET status = 'CLOSED', updated_at = ? WHERE driver_id = ? AND id <> ? AND status IN ('SHARE_PENDING_COMPANY', 'SHARE_PENDING_DRIVER')",
        now, match.driver_id, parseInt(matchId, 10)
    );
};

// ─── TICKET GENERATION HELPER ───────────────────────────────────────────────
async function ensureTicketGenerated(matchId, companyId, driverId, now, runner = db) {
    const existingTicket = await runner.get('SELECT id FROM tickets WHERE match_id = ?', parseInt(matchId));
    let ticketId = existingTicket ? existingTicket.id : null;
    const price_cents = parseInt(process.env.WEEKLY_FEE_CENTS);
    if (isNaN(price_cents) || price_cents <= 0) {
        throw new Error(`[Billing] Missing or invalid WEEKLY_FEE_CENTS: ${process.env.WEEKLY_FEE_CENTS}. Ticket generation aborted.`);
    }

    if (!ticketId) {
        try {
            const t = await runner.run(
                `INSERT INTO tickets (match_id, company_id, driver_id, price_cents, currency, created_at, billing_status, billing_notes)
                 VALUES (?,?,?,?,'USD',?,'hold',?)` + (db.IS_POSTGRES ? ' RETURNING id' : ''),
                parseInt(matchId), companyId, driverId, price_cents, now, `Match ID: ${matchId}`
            );
            ticketId = (t.rows && t.rows[0]) ? t.rows[0].id : t.lastInsertRowid;
        } catch (insertErr) {
            if (insertErr.code === '23505' || (insertErr.message && (insertErr.message.includes('UNIQUE') || insertErr.message.includes('duplicate')))) {
                const race = await runner.get('SELECT id FROM tickets WHERE match_id = ?', parseInt(matchId));
                ticketId = race ? race.id : null;
            } else {
                throw insertErr;
            }
        }
    }

    if (ticketId) {
        await runner.run(
            'UPDATE potential_matches SET ticket_id = ?, fee_cents = ?, fee_currency = ?, updated_at = ? WHERE id = ?',
            ticketId, price_cents, 'USD', now, matchId
        );
        console.log(`[ConsentFlow] ticket generated ticket_id=${ticketId}`);
    }
    return ticketId;
}

app.post('/matches/:id/driver/confirm-share', authenticateToken, async (req, res) => {
    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Only drivers' });
    const matchId = req.params.id;
    const now = new Date().toISOString();

    try {
        const match = await db.get('SELECT * FROM potential_matches WHERE id = ? AND driver_id = ?', parseInt(matchId, 10), parseInt(req.user.id, 10));
        if (!match) return res.status(404).json({ error: 'Match not found' });

        console.log(`[ConsentFlow] match=${matchId} status_before=${match.status} actor=driver action=confirm_share`);

        let finalStatus = match.status;
        let ticketId = match.ticket_id || null;
        let invoiceId = null;
        let invoiceAmountCents = null;
        let shouldCharge = false;

        if (match.status !== 'INFO_SHARED') {
            const validDriverStates = ['ACCEPTED', 'PREMATCH_READY', 'SHARE_PENDING_DRIVER', 'SHARE_PENDING_COMPANY'];
            if (!validDriverStates.includes(match.status)) {
                return res.status(409).json({ error: 'Invalid match state for consent', current_status: match.status });
            }

            const lockState = await getDriverLockState(parseInt(req.user.id, 10), parseInt(matchId, 10));
            if (lockState.is_blocked) {
                console.log(`[ConsentFlow] driver=${req.user.id} blocked by canonical lock match=${lockState.blocking_match_id} reason=${lockState.reason}`);
                return res.status(409).json({
                    error: 'driver_locked',
                    blocking_match_id: lockState.blocking_match_id,
                    exclusive_until: lockState.exclusive_until,
                    reason: lockState.reason
                });
            }
        } else if (!ticketId) {
            return res.status(402).json({
                error: 'payment_required',
                message: 'Payment must be completed before accessing driver information.',
                invoice_id: null
            });
        }

        if (match.status !== 'INFO_SHARED') {
            const tx = await db.beginTransaction();

            try {
                await tx.run(
                    'UPDATE potential_matches SET driver_share_consent_at = COALESCE(driver_share_consent_at, ?), updated_at = ? WHERE id = ?',
                    now, now, parseInt(matchId, 10)
                );
                console.log(`[ConsentFlow] driver_share_consent_at set`);

                const updated = await tx.get('SELECT * FROM potential_matches WHERE id = ?', parseInt(matchId, 10));
                finalStatus = updated.status;
                ticketId = updated.ticket_id || null;

                if (updated.company_share_consent_at) {
                    // Both consents present — apply paywall
                    const creditConsumed = await consumeFreeShareCredit(updated.company_id, tx);
                    if (creditConsumed) {
                        ticketId = await ensureTicketGenerated(matchId, updated.company_id, updated.driver_id, now, tx);
                        await tx.run('UPDATE tickets SET billing_status = ? WHERE id = ?', 'free_share', ticketId);
                        await finalizeShare(matchId, tx);
                        finalStatus = 'INFO_SHARED';
                        console.log(`[ConsentFlow][Paywall] Free share consumed -> INFO_SHARED match=${matchId} company=${updated.company_id}`);
                    } else {
                        finalStatus = 'PAYMENT_REQUIRED';
                        await tx.run('UPDATE potential_matches SET status = ?, updated_at = ? WHERE id = ?', finalStatus, now, parseInt(matchId, 10));
                        console.log(`[ConsentFlow][Paywall] No free credit -> PAYMENT_REQUIRED match=${matchId} company=${updated.company_id}`);
                    }
                } else {
                    finalStatus = 'SHARE_PENDING_COMPANY';
                    await tx.run('UPDATE potential_matches SET status = ?, updated_at = ? WHERE id = ?', finalStatus, now, parseInt(matchId, 10));
                    console.log(`[ConsentFlow] status changed to SHARE_PENDING_COMPANY`);
                }

                await tx.commit();
            } catch (txErr) {
                await tx.rollback().catch(() => {});
                throw txErr;
            }
        }

        if (finalStatus === 'INFO_SHARED') {
            try { await sendPush(match.company_id, 'empresa', "Informacion Compartida", "Ambas partes han aceptado. Ya pueden contactarse directamente."); } catch (e) { console.error('[ConsentPush]', e.message); }
            try { await sendPush(match.driver_id, 'driver', "Informacion Compartida", "Ambas partes han aceptado. Ya pueden contactarse directamente."); } catch (e) { console.error('[ConsentPush]', e.message); }
        } else if (finalStatus === 'PAYMENT_REQUIRED') {
            try { await sendPush(match.company_id, 'empresa', "Pago requerido", "Completa el pago para ver la informacion del chofer."); } catch (e) { console.error('[ConsentPush]', e.message); }
        } else {
            try { await sendPush(match.company_id, 'empresa', "Consentimiento Recibido", "El chofer ha compartido su informacion contigo."); } catch (e) { console.error('[ConsentPush]', e.message); }
        }
        return res.json({ success: true, status: finalStatus, ticket_id: ticketId, requires_payment: finalStatus === 'PAYMENT_REQUIRED', match_id: parseInt(matchId, 10) });
    } catch (e) {
        console.error('[Matches] driver confirm-share error:', e);
        if (e.httpStatus) {
            return res.status(e.httpStatus).json({
                error: e.code || 'billing_error',
                message: e.message,
                invoice_id: e.invoiceId || null
            });
        }
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/matches/:id/company/confirm-share', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies' });
    const matchId = req.params.id;
    const now = new Date().toISOString();

    // --- BASIC COMPANY VERIFICATION (ANTI-FAKE) ---
    const vCheck = await db.get('SELECT verification_status FROM empresas WHERE id = ?', req.user.id);
    if (vCheck && vCheck.verification_status !== 'approved') {
        return res.status(403).json({ error: 'Empresa no verificada', requires_verification: true });
    }

    try {
        const emp = await db.get('SELECT billing_suspended FROM empresas WHERE id = ?', req.user.id);
        if (emp && (emp.billing_suspended === true || emp.billing_suspended === 1)) {
            return res.status(402).json({ error: 'Cuenta suspendida por facturación pendiente' });
        }

        const scopeIds = await getCompanyScopeIds(req.user.id);
        const scopeIn = scopeIds.map(() => '?').join(',');

        const matches = await db.all(`SELECT * FROM potential_matches WHERE id = ? AND company_id IN (${scopeIn})`, matchId, ...scopeIds);
        const match = matches.length > 0 ? matches[0] : null;
        if (!match) return res.status(404).json({ error: 'Match not found in company scope' });

        console.log(`[ConsentFlow] match=${matchId} status_before=${match.status} actor=company action=confirm_share`);

        let finalStatus = match.status;
        let ticketId = match.ticket_id || null;
        let invoiceId = null;
        let invoiceAmountCents = null;
        let shouldCharge = false;

        if (match.status !== 'INFO_SHARED') {
            const validCompanyStates = ['ACCEPTED', 'PREMATCH_READY', 'SHARE_PENDING_DRIVER', 'SHARE_PENDING_COMPANY'];
            if (!validCompanyStates.includes(match.status)) {
                return res.status(409).json({ error: 'Invalid match state for consent', current_status: match.status });
            }

            const lockState = await getDriverLockState(parseInt(match.driver_id, 10), parseInt(matchId, 10));
            if (lockState.is_blocked) {
                console.log(`[ConsentFlow] company=${req.user.id} blocked by canonical lock driver=${match.driver_id} match=${lockState.blocking_match_id} reason=${lockState.reason}`);
                return res.status(409).json({ 
                    error: 'driver_locked',
                    blocking_match_id: lockState.blocking_match_id,
                    exclusive_until: lockState.exclusive_until,
                    reason: lockState.reason
                });
            }
        } else if (!ticketId) {
            return res.status(402).json({
                error: 'payment_required',
                message: 'Payment must be completed before accessing driver information.',
                invoice_id: null
            });
        }

        if (match.status === 'INFO_SHARED' && ticketId) {
            let existingInvoice = await fetchInvoiceByTicket(ticketId, db, match.company_id);
            if (!existingInvoice) {
                try {
                    const ticket = await db.get('SELECT id, price_cents FROM tickets WHERE id = ?', ticketId);
                    invoiceAmountCents = ticket ? ticket.price_cents : parseInt(process.env.WEEKLY_FEE_CENTS, 10);
                    existingInvoice = await ensurePendingInvoice({
                        companyId: match.company_id,
                        amountCents: invoiceAmountCents,
                        metadata: {
                            ticketId,
                            matchId,
                            driverId: match.driver_id,
                            companyId: match.company_id,
                            source: 'company_confirm_share'
                        }
                    });
                } catch (invoiceRecoveryError) {
                    console.error('[Matches] company confirm-share invoice recovery error:', invoiceRecoveryError);
                    return res.status(500).json({ error: 'invoice_recovery_failed', ticket_id: ticketId });
                }
            }
            if (existingInvoice.status === 'charged') {
                await markTicketPaid(ticketId, {
                    paymentIntentId: existingInvoice.stripe_payment_intent_id || null
                });
                return res.json({ success: true, status: 'INFO_SHARED', ticket_id: ticketId });
            }
            invoiceId = existingInvoice.id;
            invoiceAmountCents = existingInvoice.total_cents || invoiceAmountCents;
            shouldCharge = true;
        }

        if (match.status !== 'INFO_SHARED') {
            const tx = await db.beginTransaction();

        try {
            await tx.run(
                'UPDATE potential_matches SET company_share_consent_at = COALESCE(company_share_consent_at, ?), updated_at = ? WHERE id = ?',
                now, now, parseInt(matchId, 10)
            );
            console.log(`[ConsentFlow] company_share_consent_at set`);

            const updated = await tx.get('SELECT * FROM potential_matches WHERE id = ?', parseInt(matchId, 10));
            finalStatus = updated.status;
            ticketId = updated.ticket_id || null;

            if (updated.driver_share_consent_at) {
                // Both consents present — apply paywall
                const creditConsumed = await consumeFreeShareCredit(updated.company_id, tx);
                if (creditConsumed) {
                    ticketId = await ensureTicketGenerated(matchId, updated.company_id, updated.driver_id, now, tx);
                    await tx.run('UPDATE tickets SET billing_status = ? WHERE id = ?', 'free_share', ticketId);
                    await finalizeShare(matchId, tx);
                    finalStatus = 'INFO_SHARED';
                    console.log(`[ConsentFlow][Paywall] Free share consumed -> INFO_SHARED match=${matchId} company=${updated.company_id}`);
                } else {
                    finalStatus = 'PAYMENT_REQUIRED';
                    await tx.run('UPDATE potential_matches SET status = ?, updated_at = ? WHERE id = ?', finalStatus, now, parseInt(matchId, 10));
                    console.log(`[ConsentFlow][Paywall] No free credit -> PAYMENT_REQUIRED match=${matchId} company=${updated.company_id}`);
                }
            } else {
                finalStatus = 'SHARE_PENDING_DRIVER';
                await tx.run('UPDATE potential_matches SET status = ?, updated_at = ? WHERE id = ?', finalStatus, now, parseInt(matchId, 10));
                console.log(`[ConsentFlow] status changed to SHARE_PENDING_DRIVER`);
            }

            await tx.commit();

        } catch (txErr) {
            await tx.rollback().catch(() => {});
            throw txErr;
        }
        }

        if (finalStatus === 'INFO_SHARED') {
            try { await sendPush(match.company_id, 'empresa', "Informacion Compartida", "Ambas partes han aceptado. Ya pueden contactarse directamente."); } catch (e) { console.error('[ConsentPush]', e.message); }
            try { await sendPush(match.driver_id, 'driver', "Informacion Compartida", "Ambas partes han aceptado. Ya pueden contactarse directamente."); } catch (e) { console.error('[ConsentPush]', e.message); }
        } else if (finalStatus === 'PAYMENT_REQUIRED') {
            try { await sendPush(match.company_id, 'empresa', "Pago requerido", "Completa el pago para ver la informacion del chofer."); } catch (e) { console.error('[ConsentPush]', e.message); }
        } else {
            try { await sendPush(match.driver_id, 'driver', "Consentimiento Recibido", "La empresa ha compartido su informacion contigo."); } catch (pushErr) { console.error('[ConsentPush]', pushErr.message); }
        }
        return res.json({ success: true, status: finalStatus, ticket_id: ticketId, requires_payment: finalStatus === 'PAYMENT_REQUIRED', match_id: parseInt(matchId, 10) });
    } catch (e) {
        console.error('[Matches] company confirm-share error:', e);
        if (e.httpStatus) {
            return res.status(e.httpStatus).json({
                error: e.code || 'billing_error',
                message: e.message,
                invoice_id: e.invoiceId || null
            });
        }
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PAY AND SHARE ───────────────────────────────────────────────
// Called by company after receiving PAYMENT_REQUIRED.
// Creates a Stripe PaymentIntent and returns client_secret for the frontend.
app.post('/matches/:id/pay-and-share', authenticateToken, async (req, res) => {
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Only companies' });
    const matchId = parseInt(req.params.id, 10);
    const now = new Date().toISOString();

    try {
        const stripe = getStripe();
        if (!stripe) return res.status(503).json({ error: 'stripe_unavailable' });
        const publishableKey = getStripePublishableKey();
        if (!publishableKey) {
            return res.status(503).json({ error: 'stripe_publishable_key_missing' });
        }

        const scopeIds = await getCompanyScopeIds(req.user.id);
        const scopeIn = scopeIds.map(() => '?').join(',');
        const match = await db.get(
            `SELECT * FROM potential_matches WHERE id = ? AND company_id IN (${scopeIn})`,
            matchId, ...scopeIds
        );
        if (!match) return res.status(404).json({ error: 'Match not found in company scope' });
        if (match.status !== 'PAYMENT_REQUIRED') {
            return res.status(409).json({ error: 'Match is not in PAYMENT_REQUIRED state', current_status: match.status });
        }

        const empresaColumns = await getTableColumns('empresas');
        const billingEmailExpr = empresaColumns.email ? 'COALESCE(email, contacto)' : 'contacto';
        const company = await db.get(
            `SELECT id, nombre, contacto, stripe_customer_id, ${billingEmailExpr} AS billing_email FROM empresas WHERE id = ?`,
            match.company_id
        );
        if (!company) return res.status(404).json({ error: 'Company not found' });

        const customerId = await ensureStripeCustomerForCompany(company);
        const price_cents = parseInt(process.env.WEEKLY_FEE_CENTS, 10);
        if (!price_cents || price_cents <= 0) return res.status(500).json({ error: 'invalid_fee_config' });

        // Ensure ticket exists (idempotent)
        const ticketId = await ensureTicketGenerated(matchId, match.company_id, match.driver_id, now, db);
        await db.run('UPDATE tickets SET billing_status = ? WHERE id = ? AND billing_status = ?', 'pending_payment', ticketId, 'hold');

        // Ensure invoice exists (idempotent via ensurePendingInvoice)
        const invoice = await ensurePendingInvoice({
            companyId: match.company_id,
            amountCents: price_cents,
            metadata: { ticketId, matchId, driverId: match.driver_id, companyId: match.company_id, source: 'pay_and_share' }
        });

        if (invoice.status === 'charged') {
            return res.status(409).json({
                error: 'already_paid',
                message: 'Payment already received. Waiting for unlock confirmation.',
                match_id: matchId,
                ticket_id: ticketId,
                invoice_id: invoice.id,
                status: 'PAYMENT_REQUIRED'
            });
        }

        // Create or retrieve PaymentIntent without duplicating active live intents
        let paymentIntent;
        if (invoice.stripe_payment_intent_id) {
            const existingIntent = await stripe.paymentIntents.retrieve(invoice.stripe_payment_intent_id);
            if (existingIntent.status === 'succeeded') {
                return res.status(409).json({
                    error: 'already_paid',
                    message: 'Payment already received. Waiting for unlock confirmation.',
                    match_id: matchId,
                    ticket_id: ticketId,
                    invoice_id: invoice.id,
                    status: 'PAYMENT_REQUIRED'
                });
            }

            if (isReusablePayAndSharePaymentIntentStatus(existingIntent.status)) {
                paymentIntent = existingIntent;
            }
        }

        if (!paymentIntent) {
            const paymentIntentIdempotencyKey = invoice.stripe_payment_intent_id
                ? `pay_share_match_${matchId}_retry_after_${invoice.stripe_payment_intent_id}`
                : `pay_share_match_${matchId}_invoice_${invoice.id}`;

            paymentIntent = await stripe.paymentIntents.create({
                amount: price_cents,
                currency: 'usd',
                customer: customerId,
                automatic_payment_methods: { enabled: true },
                metadata: buildStripeMetadata({
                    invoice_id: invoice.id,
                    ticket_id: ticketId,
                    match_id: matchId,
                    driver_id: match.driver_id,
                    company_id: match.company_id,
                    source: 'pay_and_share'
                }),
                description: `Driver info unlock for match #${matchId}`
            }, { idempotencyKey: paymentIntentIdempotencyKey });
            await db.run(
                'UPDATE invoices SET stripe_payment_intent_id = ?, updated_at = ? WHERE id = ?',
                paymentIntent.id, now, invoice.id
            );
        }

        console.log(`[Paywall] pay-and-share: match=${matchId} invoice=${invoice.id} pi=${paymentIntent.id} ticket=${ticketId}`);
        return res.json({
            ok: true,
            success: true,
            client_secret: paymentIntent.client_secret,
            publishable_key: publishableKey,
            match_id: matchId,
            status: 'PAYMENT_REQUIRED',
            invoice_id: invoice.id,
            ticket_id: ticketId,
            amount_cents: price_cents
        });
    } catch (e) {
        console.error('[Paywall] pay-and-share error:', e);
        res.status(500).json({ error: 'Server error', message: e.message });
    }
});

app.post('/matches/:id/viewed', authenticateToken, (req, res) => updateMatchStatus(req, res, 'VIEWED'));
app.post('/matches/:id/contacted', authenticateToken, (req, res) => updateMatchStatus(req, res, 'CONTACTED'));
app.post('/matches/:id/accept', authenticateToken, (req, res) => updateMatchStatus(req, res, 'ACCEPTED'));
// ──────────────────────────────────────────────────────────────────────────────

app.post('/api/debug/sql', async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({
            error: 'not_found'
        });
    }
    console.warn('[DEBUG_SQL] Accessed in non-production environment');
    // Only for diagnostic test purposes as specifically requested
    if (req.body.secret !== 'surgical_evidence_123') return res.status(403).json({ error: 'unauthorized' });
    try {
        if (req.body.run_migrations) {
            console.log("Forcibly applying migrations from debug endpoint");
            let errors = [];
            const executeAndCatch = async (query) => {
                try { await db.run(query); } catch (e) { errors.push(e.message); }
            };

            await executeAndCatch("ALTER TABLE drivers ADD COLUMN verify_token_hash TEXT");
            await executeAndCatch("ALTER TABLE drivers ADD COLUMN verify_token_expires_at TEXT");
            await executeAndCatch("ALTER TABLE empresas ADD COLUMN verify_token_hash TEXT");
            await executeAndCatch("ALTER TABLE empresas ADD COLUMN verify_token_expires_at TEXT");

            await executeAndCatch("CREATE UNIQUE INDEX idx_drivers_email ON drivers(email)");
            await executeAndCatch("CREATE UNIQUE INDEX idx_drivers_phone ON drivers(phone)");
            await executeAndCatch("CREATE UNIQUE INDEX idx_empresas_email ON empresas(email)");
            await executeAndCatch("CREATE UNIQUE INDEX idx_empresas_telefono ON empresas(telefono)");

            if (errors.length > 0) return res.status(500).json({ error: "Migration failures", details: errors });
            return res.json({ msg: "Migrations run flawlessly" });
        }

        const drivers = await db.all("SELECT id, nombre, email, contacto, phone, verified, status FROM drivers ORDER BY id DESC LIMIT 5");
        const empresas = await db.all("SELECT id, nombre, email, contacto, telefono, contact_phone, account_state, verified FROM empresas ORDER BY id DESC LIMIT 5");

        let outbox = [];
        let jobs = [];
        if (req.body.get_queues) {
            outbox = await db.all("SELECT id,event_name,company_id,driver_id,queue_status,metadata,created_at FROM events_outbox ORDER BY id DESC LIMIT 10;");
            jobs = await db.all("SELECT id,job_type,status,attempts,last_error,run_at FROM jobs_queue ORDER BY id DESC LIMIT 10;");
        }

        // Also retrieve the specific tokens for verification test
        const reqEmails = req.body.emails || [];
        const tokens = {};
        for (let em of reqEmails) {
            let u = await db.get("SELECT verify_token_hash FROM drivers WHERE email=?", em);
            if (!u) u = await db.get("SELECT verify_token_hash FROM empresas WHERE email=?", em);
            if (u) tokens[em] = u.verify_token_hash;
        }

        res.json({ drivers, empresas, tokens, outbox, jobs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Match Resolution Endpoint
app.post('/api/matches/:id/resolve', authenticateToken, async (req, res) => {
    try {
        if (req.user.type === 'empresa') {
            // --- BASIC COMPANY VERIFICATION (ANTI-FAKE) ---
            const vCheck = await db.get('SELECT verification_status FROM empresas WHERE id = ?', req.user.id);
            if (vCheck && vCheck.verification_status !== 'approved') {
                return res.status(403).json({ error: 'Empresa no verificada', requires_verification: true });
            }

            const emp = await db.get('SELECT billing_suspended FROM empresas WHERE id = ?', req.user.id);
            if (emp && (emp.billing_suspended === true || emp.billing_suspended === 1)) {
                return res.status(402).json({ error: 'Cuenta suspendida por facturación pendiente' });
            }
        }

        const matchId = req.params.id;
        const { resolution } = req.body; // HIRED, IN_PROCESS, REJECTED

        console.log(`[RESOLVE_MATCH] received resolution request for match ${matchId}`);
        console.log(`[RESOLVE_MATCH] resolution value = ${resolution}`);

        const validResolutions = ['HIRED', 'IN_PROCESS', 'REJECTED'];

        if (!validResolutions.includes(resolution)) {
            return res.status(400).json({ error: 'Invalid resolution status' });
        }

        const match = await db.get('SELECT * FROM potential_matches WHERE id = ?', matchId);
        if (!match) {
            console.log(`[RESOLVE_MATCH][404] Match ${matchId} not found`);
            return res.status(404).json({ error: 'Match not found' });
        }

        console.log(`[RESOLVE_MATCH][AUTH_CHECK] match_id: ${matchId}, actor_id: ${req.user.id}, actor_type: ${req.user.type}, match.company_id: ${match.company_id}, match.driver_id: ${match.driver_id}`);

        // Ensure user belongs to this match
        if (req.user.type === 'empresa' && match.company_id !== req.user.id) {
            console.log(`[RESOLVE_MATCH][403] Forbidden: Company ID mismatch. Match company: ${match.company_id}, Token company: ${req.user.id}`);
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (req.user.type === 'driver' && match.driver_id !== req.user.id) {
            console.log(`[RESOLVE_MATCH][403] Forbidden: Driver ID mismatch. Match driver: ${match.driver_id}, Token driver: ${req.user.id}`);
            return res.status(403).json({ error: 'Forbidden' });
        }

        const now = new Date().toISOString();
        const roleColumn = req.user.type === 'empresa' ? 'resolution_company' : 'resolution_driver';

        if (resolution === 'IN_PROCESS') {
            const currentExt = match.exclusivity_extension_hours || 0;
            const newExt = currentExt + 72;
            const maxExt = 504; // 21 days

            if (newExt > maxExt) {
                return res.status(400).json({ error: 'MaxExtensionReached', message: 'El tiempo máximo de prueba ha expirado. Debe decidir si lo contrata o no.' });
            }

            await db.run(
                `UPDATE potential_matches SET exclusivity_extension_hours = ?, ${roleColumn} = ?, updated_at = ? WHERE id = ?`,
                newExt, resolution, now, matchId
            );
            return res.json({ success: true, message: 'Extensión de 72 horas aplicada.', status: 'INFO_SHARED' });
        }

        if (resolution === 'REJECTED') {
            await db.run(`UPDATE potential_matches SET status = 'CLOSED', ${roleColumn} = ?, updated_at = ? WHERE id = ?`, resolution, now, matchId);
            await db.run(`UPDATE tickets SET billing_status = 'void', updated_at = ? WHERE match_id = ? AND billing_status NOT IN ('invoiced', 'paid')`, now, matchId);

            // --- PUSH: Rechazo Real (CLOSED) ---
            if (req.user.type === 'empresa') {
                try { await sendPush(match.driver_id, 'driver', 'Proceso Cerrado', 'La empresa ha cerrado el proceso contigo.'); } catch (e) { console.error('[MatchPush]', e.message); }
            } else {
                try { await sendPush(match.company_id, 'empresa', 'Proceso Rechazado', 'El chofer ha rechazado el proceso.'); } catch (e) { console.error('[MatchPush]', e.message); }
            }

            return res.json({ success: true, message: 'Match cerrado. Ya puede buscar otras opciones.', status: 'CLOSED' });
        }

        if (resolution === 'HIRED') {
            await db.run(`UPDATE potential_matches SET status = 'HIRED', ${roleColumn} = ?, updated_at = ? WHERE id = ?`, resolution, now, matchId);
            await db.run(`UPDATE tickets SET billing_status = 'unbilled', updated_at = ? WHERE match_id = ?`, now, matchId);
            await db.run(`UPDATE tickets SET billing_status = 'void', updated_at = ? WHERE driver_id = (SELECT driver_id FROM potential_matches WHERE id = ?) AND match_id != ?`, now, matchId, matchId);

            // Turn off driver's search status
            await db.run(`UPDATE drivers SET search_status = 'OFF', updated_at = ? WHERE id = ?`, now, match.driver_id);

            // Change all other pending matches for this driver to 'HIRED_ELSEWHERE'
            await db.run(`
                UPDATE potential_matches 
                SET status = 'HIRED_ELSEWHERE', updated_at = ? 
                WHERE driver_id = ? AND id != ? AND status NOT IN ('CLOSED', 'REJECTED', 'HIRED', 'HIRED_ELSEWHERE')
            `, now, match.driver_id, matchId);

            // --- HOOK: Push Notification ---
            try {
                await sendPush(match.driver_id, 'driver', "You’ve been hired", "A company has selected you for a job");
            } catch (pushErr) {
                console.error("[RESOLVE_MATCH] Push fail:", pushErr.message);
            }

            return res.json({ success: true, message: '¡Felicidades por la contratación!', status: 'HIRED' });
        }

    } catch (e) {
        console.error('Match Resolve Error:', e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// --- 9. ADMIN PANEL CONTROL ROUTES ---
const requireAdmin = (req, res, next) => {
    // Audit Verified Fact: Native Admin pattern is via x-admin-secret, not JWT.
    const secret = req.headers['x-admin-secret'];
    if (secret && secret === process.env.ADMIN_SECRET) {
        req.user = { id: 0, role: 'admin' }; // Mock standard user payload for audit tools
        next();
    } else {
        res.status(403).json({ error: 'Forbidden: Invalid Admin Secret' });
    }
};

app.get('/api/admin/pending-companies', requireAdmin, async (req, res) => {
    try {
        const rows = await db.all(`
            SELECT id, nombre, contacto as email, created_at, verification_status 
            FROM empresas 
            WHERE verification_status = 'pending' 
            ORDER BY created_at DESC
        `);
        res.json({ ok: true, pending_companies: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/companies/:id/approve', requireAdmin, async (req, res) => {
    try {
        const companyId = req.params.id;
        await db.run("UPDATE empresas SET verification_status = 'approved', verified_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), companyId);
        await auditLog('admin_company_approved', 0, companyId, { company_id: companyId }, req);
        
        try { await sendPush(companyId, 'empresa', "¡Empresa Verificada!", "Tu empresa ha sido verificada. Ya puedes operar."); } catch(e) { console.error('[PushError] approve:', e.message); }
        res.json({ ok: true, message: 'Company approved and verified.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/companies/:id/reject', requireAdmin, async (req, res) => {
    try {
        const companyId = req.params.id;
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ error: 'Rejection reason strictly required.' });
        
        await db.run("UPDATE empresas SET verification_status = 'rejected', rejected_reason = ?, updated_at = ? WHERE id = ?", reason, nowIso(), companyId);
        await auditLog('admin_company_rejected', 0, companyId, { company_id: companyId, reason }, req);
        
        try { await sendPush(companyId, 'empresa', "Verificación Fallida", "Tu empresa no fue aprobada. Revisa la información enviada."); } catch(e) { console.error('[PushError] reject:', e.message); }
        res.json({ ok: true, message: 'Company rejected.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/problem-companies', requireAdmin, async (req, res) => {
    try {
        const rows = await db.all(`
            SELECT c.id as company_id, c.contacto as email, c.billing_suspended, c.search_status, 
                   COUNT(i.id) as failed_invoices, MAX(i.issue_date) as last_invoice_date
            FROM empresas c
            LEFT JOIN invoices i ON i.company_id = c.id AND i.status IN ('retrying', 'failed')
            WHERE c.billing_suspended = true OR i.id IS NOT NULL
            GROUP BY c.id, c.contacto, c.billing_suspended, c.search_status
        `);
        res.json({ ok: true, companies: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/invoices', requireAdmin, async (req, res) => {
    try {
        const { status, company_id } = req.query;
        let where = []; let args = [];
        if (status) { where.push("i.status = ?"); args.push(status); }
        if (company_id) { where.push("i.company_id = ?"); args.push(company_id); }
        
        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        
        // Exact JSON matching based on engine to prevent false matches (e.g. 12 matching 112)
        const joinCondition = db.IS_POSTGRES 
            ? "CAST(j.payload::json->>'invoice_id' AS TEXT) = CAST(i.id AS TEXT)"
            : "CAST(json_extract(j.payload, '$.invoice_id') AS TEXT) = CAST(i.id AS TEXT)";

        const rows = await db.all(`
            SELECT 
                i.id, i.company_id, i.status, i.total_cents as amount, 
                COALESCE((
                    SELECT j.attempts 
                    FROM jobs_queue j 
                    WHERE j.job_type = 'charge_weekly_invoice' AND ${joinCondition}
                    ORDER BY j.id DESC LIMIT 1
                ), 0) as attempts,
                (
                    SELECT j.run_after 
                    FROM jobs_queue j 
                    WHERE j.job_type = 'charge_weekly_invoice' AND ${joinCondition}
                    ORDER BY j.id DESC LIMIT 1
                ) as next_retry_at,
                i.created_at
            FROM invoices i
            ${whereClause} ORDER BY i.created_at DESC LIMIT 100
        `, ...args);
        
        res.json({ ok: true, invoices: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/invoices/:id/retry', requireAdmin, async (req, res) => {
    try {
        const invoiceId = req.params.id;
        const inv = await db.get("SELECT id FROM invoices WHERE id = ?", invoiceId);
        if (!inv) return res.status(404).json({ error: 'Invoice not found' });
        
        await db.run("INSERT INTO jobs_queue (job_type, payload, status, attempts, run_after, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)",
            'charge_weekly_invoice', JSON.stringify({ invoice_id: invoiceId, admin_forced: true }), nowIso(), nowIso(), nowIso()
        );
        
        await auditLog('admin_force_retry', 0, invoiceId, { source: 'admin_secret', action: 'admin_force_retry', invoice_id: invoiceId }, req);
        res.json({ ok: true, message: 'Retry job queued for invoice' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/companies/:id/unsuspend', requireAdmin, async (req, res) => {
    try {
        const companyId = req.params.id;
        await db.run("UPDATE empresas SET billing_suspended = false, search_status = 'ON', updated_at = ? WHERE id = ?", nowIso(), companyId);
        
        await auditLog('admin_unsuspend_company', 0, companyId, { source: 'admin_secret', action: 'admin_unsuspend_company', company_id: companyId }, req);
        res.json({ ok: true, message: 'Company billing unsuspended and search enabled' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

if (process.env.RUN_MIGRATIONS === 'true' || process.env.RUN_MIGRATIONS === '1') {
    const { execSync } = require('child_process');
    console.log("--- Starting Consolidated Auto-Migrations ---");
    try {
        // Critical Core Schema
        execSync('node migrate_auth_fix.js', { stdio: 'inherit' });
        execSync('node migrate_prod_consolidated.js', { stdio: 'inherit' });

        // Feature Schema (Hardened against failure)
        const featureMigrations = [
            'migrate_phase2_legal.js',
            'migrate_auth_indexes.js',
            'migrate_fix_events.js',
            'migrate_company_requirements.js',
            'migrate_driver_profile.js',
            'migrate_fix_profile_columns.js',
            'migrate_availability.js',
            'migrate_matches_consent.js',
            'migrate_ticket_match_unique.js',
            'migrate_ticket_payment.js',
            'migrate_matches_index.js',
            'migrate_matches_query_indexes.js',
            'migrate_lazy_matching.js',
            'migrate_candidate_pool.js',
            'migrate_candidate_pool_gin.js',
            'migrate_match_retention.js',
            'migrate_otr_eligibility.js',
            'migrate_normalize_preferences.js',
            'migrate_driver_leads.js',
            'migrate_lead_invitations.js',
            'migrate_lead_source.js',
            'migrate_lead_funnel_events.js',
            'migrate_phase6_driver_profile.js',
            'migrate_phase6_production_fix.js',
            'migrate_fix_duplicate_tickets.js',
            'scripts/migrate_driver_banner.js',
            'migrate_empresas_updated_at.js'
        ];

        for (const m of featureMigrations) {
            try {
                execSync(`node ${m}`, { stdio: 'inherit' });
            } catch (err) {
                console.warn(`[WARNING] Non-fatal migration error in ${m}:`, err.message);
            }
        }

        // Inline Column Patches (Async)
        (async () => {
            try {
                await db.run('ALTER TABLE potential_matches ADD COLUMN IF NOT EXISTS exclusivity_extension_hours INTEGER DEFAULT 0').catch(() => { });
                await db.run('ALTER TABLE potential_matches ADD COLUMN IF NOT EXISTS resolution_company TEXT').catch(() => { });
                await db.run('ALTER TABLE potential_matches ADD COLUMN IF NOT EXISTS resolution_driver TEXT').catch(() => { });
            } catch (e) { console.warn("Schema patch warning:", e.message); }
        })();

        console.log("--- Auto-Migrations Finished ---");
    } catch (e) {
        console.error("FATAL: Core migration failed:", e.message);
        // We only exit if CORE schema fails. Feature schema errors are warned but allow server to try starting.
        // process.exit(1); 
    }
}

async function startServer() {
  try {
    console.log("🚀 Running push_tokens migration...");
    await runPushMigration().catch(err => {
      console.error("⚠️ Migration warning:", err.message);
    });
    await runDriverReactivationStartupCompatibilityBootstrap(db, console).catch(err => {
      console.warn("[Driver Reactivation] Compatibility bootstrap warning:", err.message);
    });

    // Bootstrap: free_info_shares_remaining on empresas (paywall free credit column)
    try {
      if (db.IS_POSTGRES) {
        await db.run('ALTER TABLE empresas ADD COLUMN IF NOT EXISTS free_info_shares_remaining INTEGER DEFAULT 1');
      } else {
        await db.run('ALTER TABLE empresas ADD COLUMN free_info_shares_remaining INTEGER DEFAULT 1');
      }
      console.log('[Bootstrap] free_info_shares_remaining ensured on empresas.');
    } catch (bootstrapErr) {
      const msg = String(bootstrapErr.message || '');
      if (!msg.includes('duplicate') && !msg.includes('already exists') && !msg.includes('duplicate column')) {
        console.warn('[Bootstrap] free_info_shares_remaining warning:', bootstrapErr.message);
      }
    }

    await resumeInvoicePdfGenerationJobs();
    console.log("✅ Migration step finished.");

    console.log("⚙️ Starting background workers...");
    startQueueWorker().catch(e => console.error('Worker Start Error:', e));

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} [${process.env.NODE_ENV}]`);
        console.log(`DB Mode: ${db.IS_POSTGRES ? 'PostgreSQL' : 'SQLite'}`);
    });
  } catch (e) {
    console.error("❌ Critical start error:", e.message);
    process.exit(1);
  }
}

startServer();
