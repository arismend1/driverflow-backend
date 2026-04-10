const schemaColumnsCacheByDb = new WeakMap();
const schemaWarningCacheByDb = new WeakMap();

function getSchemaColumnsCache(db) {
    if (!schemaColumnsCacheByDb.has(db)) {
        schemaColumnsCacheByDb.set(db, new Map());
    }
    return schemaColumnsCacheByDb.get(db);
}

function getSchemaWarningCache(db) {
    if (!schemaWarningCacheByDb.has(db)) {
        schemaWarningCacheByDb.set(db, new Set());
    }
    return schemaWarningCacheByDb.get(db);
}

function createInvoiceSchemaHelpers({ db, nowIso, warn = console.warn, safeTables = ['invoices'] }) {
    async function getTableColumns(tableName) {
        const schemaColumnsCache = getSchemaColumnsCache(db);
        if (schemaColumnsCache.has(tableName)) {
            return schemaColumnsCache.get(tableName);
        }

        let columns = {};

        if (db.IS_POSTGRES) {
            const rows = await db.all(`
                SELECT column_name, is_nullable
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = ?
            `, tableName);

            columns = (rows || []).reduce((acc, row) => {
                acc[row.column_name] = { notNull: row.is_nullable === 'NO' };
                return acc;
            }, {});
        } else {
            const allowedTables = new Set(safeTables);
            if (!allowedTables.has(tableName)) {
                throw new Error(`Unsafe table lookup: ${tableName}`);
            }

            const rows = await db.all(`PRAGMA table_info(${tableName})`);
            columns = (rows || []).reduce((acc, row) => {
                acc[row.name] = { notNull: !!row.notnull };
                return acc;
            }, {});
        }

        schemaColumnsCache.set(tableName, columns);
        return columns;
    }

    function logSchemaWarningOnce(key, message) {
        const schemaWarningCache = getSchemaWarningCache(db);
        if (schemaWarningCache.has(key)) return;
        schemaWarningCache.add(key);
        warn(message);
    }

    async function ensureInvoiceDunningRescueColumns() {
        const invoiceColumns = await getTableColumns('invoices');
        const hasRequiredColumns = !!invoiceColumns.next_retry_at;
        if (!hasRequiredColumns) {
            logSchemaWarningOnce(
                'invoice-dunning-missing-columns',
                '[Dunning Rescue] Skipped: required invoice dunning columns missing in current schema'
            );
        }
        return { invoiceColumns, hasRequiredColumns };
    }

    async function updateInvoiceRetryState(invoiceId, options = {}, runner = db) {
        if (!invoiceId) return;

        const invoiceColumns = await getTableColumns('invoices');
        const assignments = ['status = ?'];
        const params = [options.status || 'retrying'];

        if (options.clearFailureReason && invoiceColumns.failure_reason) {
            assignments.push('failure_reason = NULL');
        }
        if (options.failureReason !== undefined && invoiceColumns.failure_reason) {
            assignments.push('failure_reason = ?');
            params.push(options.failureReason);
        }
        if (options.clearSuspendedAt && invoiceColumns.suspended_at) {
            assignments.push('suspended_at = NULL');
        }
        if (options.suspendedAt !== undefined && invoiceColumns.suspended_at) {
            assignments.push('suspended_at = ?');
            params.push(options.suspendedAt);
        }
        if (options.nextRetryAt !== undefined && invoiceColumns.next_retry_at) {
            assignments.push('next_retry_at = ?');
            params.push(options.nextRetryAt);
        }
        if (options.attemptCount !== undefined && invoiceColumns.attempt_count) {
            assignments.push('attempt_count = ?');
            params.push(options.attemptCount);
        }
        if (options.lastAttemptAt !== undefined && invoiceColumns.last_attempt_at) {
            assignments.push('last_attempt_at = ?');
            params.push(options.lastAttemptAt);
        }
        if (options.updatedAt !== undefined && invoiceColumns.updated_at) {
            assignments.push('updated_at = ?');
            params.push(options.updatedAt);
        }

        params.push(invoiceId);
        await runner.run(`UPDATE invoices SET ${assignments.join(', ')} WHERE id = ?`, ...params);
    }

    async function markInvoiceChargedByWhereClause(whereClause, whereArgs, paymentInfo = {}, runner = db) {
        if (!whereClause || !Array.isArray(whereArgs) || whereArgs.length === 0) return;

        const invoiceColumns = await getTableColumns('invoices');
        const assignments = ['status = ?'];
        const params = ['charged'];

        if (invoiceColumns.stripe_payment_intent_id && paymentInfo.paymentIntentId) {
            assignments.push('stripe_payment_intent_id = ?');
            params.push(paymentInfo.paymentIntentId);
        }
        if (paymentInfo.chargeId && invoiceColumns.stripe_charge_id) {
            assignments.push('stripe_charge_id = ?');
            params.push(paymentInfo.chargeId);
        }
        if (paymentInfo.receiptUrl && invoiceColumns.receipt_url) {
            assignments.push('receipt_url = ?');
            params.push(paymentInfo.receiptUrl);
        }
        if (invoiceColumns.paid_at) {
            assignments.push('paid_at = ?');
            params.push(paymentInfo.paidAt || nowIso());
        }
        if (invoiceColumns.paid_method) {
            assignments.push('paid_method = ?');
            params.push('stripe');
        }
        if (invoiceColumns.failure_reason) {
            assignments.push('failure_reason = NULL');
        }
        if (invoiceColumns.next_retry_at) {
            assignments.push('next_retry_at = NULL');
        }
        if (invoiceColumns.suspended_at) {
            assignments.push('suspended_at = NULL');
        }
        if (paymentInfo.attemptCount !== undefined && invoiceColumns.attempt_count) {
            assignments.push('attempt_count = ?');
            params.push(paymentInfo.attemptCount);
        }
        if (paymentInfo.lastAttemptAt !== undefined && invoiceColumns.last_attempt_at) {
            assignments.push('last_attempt_at = ?');
            params.push(paymentInfo.lastAttemptAt);
        }
        if (invoiceColumns.updated_at) {
            assignments.push('updated_at = ?');
            params.push(paymentInfo.updatedAt || nowIso());
        }

        params.push(...whereArgs);
        await runner.run(`UPDATE invoices SET ${assignments.join(', ')} WHERE ${whereClause}`, ...params);
    }

    async function markInvoiceCharged(invoiceId, paymentInfo = {}, runner = db) {
        if (!invoiceId) return;
        return markInvoiceChargedByWhereClause('id = ? AND status <> \'charged\'', [invoiceId], paymentInfo, runner);
    }

    return {
        getTableColumns,
        logSchemaWarningOnce,
        ensureInvoiceDunningRescueColumns,
        updateInvoiceRetryState,
        markInvoiceCharged,
        markInvoiceChargedByWhereClause
    };
}

module.exports = { createInvoiceSchemaHelpers };
