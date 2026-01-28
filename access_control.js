// access_control.js
const time = require('./time_contract');
// const { nowIso, nowEpochMs } = require('./time_provider'); // DEPRECATED

/**
 * Enforces strict operational blocking based on debt duration.
 * Rule: Block if DEBT EXISTS (pending invoices) AND (Time since last payment >= 28 days OR Time since first unpaid invoice >= 28 days).
 * 
 * @param {import('better-sqlite3').Database} db 
 * @param {number|string} companyId 
 * @param {string} actionLabel - Context for the error (e.g., 'create_ticket')
 * @returns {void}
 * @throws {Error} if company is blocked
 */
function enforceCompanyCanOperate(db, companyId, actionLabel) {
    const cId = Number(companyId);
    if (!Number.isFinite(cId)) throw new Error(`Invalid companyId: ${companyId}`);

    // Use time_contract for consistent simulation time
    const nowStr = time.nowIso({ ctx: 'enforce_check' });
    const nowMs = time.nowMs({ ctx: 'enforce_logic' });

    // 0. Fetch Current Status (Preserve Manual Blocks)
    const current = db.prepare('SELECT is_blocked, blocked_reason FROM empresas WHERE id = ?').get(cId);
    let manualBlock = false;
    if (current && current.is_blocked === 1) {
        // If reason is explicitly from this auto-logic, we are allowed to clear it.
        // Otherwise (Admin block, Initial Setup), we persist it.
        // Auto-logic uses reasons starting with '28_days_no_payment'.
        if (!current.blocked_reason || !current.blocked_reason.startsWith('28_days')) {
            manualBlock = true;
        }
    }

    if (manualBlock) {
        const err = new Error('ACCOUNT_BLOCKED_OVERDUE_INVOICES');
        err.code = 'ACCOUNT_BLOCKED_OVERDUE_INVOICES';
        err.details = { reason: current.blocked_reason, blocked_at: nowStr };
        throw err;
    }

    // 1. Calculate Auto-Status
    // Check for ANY debt
    const pendingCount = db.prepare(`
        SELECT COUNT(*) as c FROM invoices 
        WHERE company_id = ? AND status = 'pending'
    `).get(cId).c;

    let isAutoBlocked = false;
    let autoReason = null;

    if (pendingCount > 0) {
        // Has debt. Check duration since last payment.
        const lastPayment = db.prepare(`
            SELECT MAX(paid_at) as last_paid 
            FROM invoices 
            WHERE company_id = ? AND paid_at IS NOT NULL
        `).get(cId);

        let refDateMs = null;

        if (lastPayment && lastPayment.last_paid) {
            // Anchor: Last Payment Date
            const d = time.parseLoose(lastPayment.last_paid, { minYear: 2000 });
            if (d) refDateMs = d.valueOf();
        } else {
            // Never paid OR all paid invoices irrelevant? 
            // If invoices exist but pending, use oldest pending as anchor.
            const oldestPending = db.prepare(`
                SELECT MIN(COALESCE(issue_date, created_at)) as oldest_date
                FROM invoices
                WHERE company_id = ? AND status = 'pending'
            `).get(cId);

            if (oldestPending && oldestPending.oldest_date) {
                const d = time.parseLoose(oldestPending.oldest_date, { minYear: 2000 });
                if (d) refDateMs = d.valueOf();
            }
        }

        if (refDateMs !== null) {
            const diffMs = nowMs - refDateMs;
            const daysDiff = diffMs / (1000 * 3600 * 24);

            // THRESHOLD: 28 Days
            if (daysDiff >= 28) {
                isAutoBlocked = true;
                autoReason = `28_days_no_payment_with_debt (Diff: ${daysDiff.toFixed(1)} days)`;
            }
        }
    }

    // 2. Persist State (Auto Only)
    // Only update if changes to avoid DB spam? No, user says "Persistir inmediatamente".
    // We update to ensure consistency.
    const nowSql = nowStr.replace('T', ' ').slice(0, 19);

    if (isAutoBlocked) {
        db.prepare(`
            UPDATE empresas 
            SET is_blocked = 1, 
                blocked_reason = ?, 
                blocked_at = COALESCE(blocked_at, ?) 
            WHERE id = ?
        `).run(autoReason, nowSql, cId);

        // Emit Event: company_blocked (request_id=0 for system events)
        try {
            db.prepare(`
                INSERT INTO events_outbox (event_name, created_at, company_id, request_id, metadata)
                VALUES (?, ?, ?, ?, ?)
            `).run('company_blocked', nowStr, cId, 0, JSON.stringify({ reason: autoReason }));
        } catch (e) { /* ignore duplicate */ }

        const err = new Error('ACCOUNT_BLOCKED_OVERDUE_INVOICES');
        err.code = 'ACCOUNT_BLOCKED_OVERDUE_INVOICES';
        err.details = {
            reason: autoReason,
            blocked_at: nowStr,
            action: actionLabel
        };
        throw err;
    } else {
        // Unblock ONLY if currently blocked by AUTO logic
        if (current && current.is_blocked === 1) {
            // We checked manualBlock above. If we are here, it is NOT manual. 
            // It must be auto/old. And isAutoBlocked is false. So we unblock.
            db.prepare(`
                UPDATE empresas 
                SET is_blocked = 0, 
                    blocked_reason = NULL, 
                    blocked_at = NULL 
                WHERE id = ?
            `).run(cId);
        }
    }
}

module.exports = { enforceCompanyCanOperate };
