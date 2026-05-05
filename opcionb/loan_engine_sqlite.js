'use strict';

const FREQUENCIES = {
  SEMANAL: 7,
  QUINCENAL: 15,
  MENSUAL: 30,
};

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function fromCents(value) {
  return Number((value / 100).toFixed(2));
}

function ensurePositiveNumber(value, fieldName) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${fieldName} must be > 0`);
  }
  return numberValue;
}

function ensureOneOf(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function allocatePayment(dueBreakdown, paymentAmount) {
  const total = toCents(ensurePositiveNumber(paymentAmount, 'paymentAmount'));
  let remaining = total;

  const dueLate = toCents(Math.max(0, Number(dueBreakdown.lateDue || 0)));
  const dueInterest = toCents(Math.max(0, Number(dueBreakdown.interestDue || 0)));
  const duePrincipal = toCents(Math.max(0, Number(dueBreakdown.principalDue || 0)));

  const mora = Math.min(remaining, dueLate);
  remaining -= mora;

  const interes = Math.min(remaining, dueInterest);
  remaining -= interes;

  const capitalDue = Math.min(remaining, duePrincipal);
  remaining -= capitalDue;

  return {
    mora: fromCents(mora),
    interes: fromCents(interes),
    capital: fromCents(capitalDue + remaining),
  };
}

function allocateAcrossInstallments(installments, paymentAmount) {
  let remaining = toCents(ensurePositiveNumber(paymentAmount, 'paymentAmount'));
  const plan = [];

  for (const installment of installments) {
    if (remaining <= 0) break;

    const lateDue = toCents(Math.max(0, Number(installment.late_fee_due) - Number(installment.late_fee_paid)));
    const interestDue = toCents(Math.max(0, Number(installment.interest_due) - Number(installment.interest_paid)));
    const principalDue = toCents(Math.max(0, Number(installment.principal_due) - Number(installment.principal_paid)));

    const mora = Math.min(remaining, lateDue);
    remaining -= mora;

    const interes = Math.min(remaining, interestDue);
    remaining -= interes;

    const capital = Math.min(remaining, principalDue);
    remaining -= capital;

    if (mora > 0) plan.push({ installmentId: installment.id, component: 'MORA', amount: fromCents(mora) });
    if (interes > 0) plan.push({ installmentId: installment.id, component: 'INTERES', amount: fromCents(interes) });
    if (capital > 0) plan.push({ installmentId: installment.id, component: 'CAPITAL', amount: fromCents(capital) });
  }

  if (remaining > 0) {
    plan.push({ installmentId: null, component: 'CAPITAL', amount: fromCents(remaining) });
  }

  return plan;
}

function generateInstallmentPlan(input) {
  const principal = ensurePositiveNumber(input.principal, 'principal');
  const interestRateMonthly = Number(input.interestRateMonthly || 0);
  const termCount = Number(input.termCount || 0);
  const frequency = ensureOneOf(input.frequency, ['SEMANAL', 'QUINCENAL', 'MENSUAL'], 'frequency');

  if (!Number.isInteger(termCount) || termCount <= 0) {
    throw new Error('termCount must be a positive integer');
  }

  const principalCents = toCents(principal);
  const basePrincipalByInstallment = Math.floor(principalCents / termCount);
  const remainder = principalCents - (basePrincipalByInstallment * termCount);

  const schedule = [];
  let pendingCents = principalCents;

  for (let i = 1; i <= termCount; i += 1) {
    const principalDueCents = basePrincipalByInstallment + (i <= remainder ? 1 : 0);
    const monthlyInterestCents = Math.round(pendingCents * (interestRateMonthly / 100));
    const frequencyFactor = FREQUENCIES[frequency] / 30;
    const interestDueCents = Math.round(monthlyInterestCents * frequencyFactor);

    const dueDate = addDays(input.startDate, FREQUENCIES[frequency] * i);
    pendingCents -= principalDueCents;

    schedule.push({
      installmentNo: i,
      dueDate,
      principalDue: fromCents(principalDueCents),
      interestDue: fromCents(interestDueCents),
      lateFeeDue: 0,
    });
  }

  return schedule;
}

function createLoan(db, input) {
  ensurePositiveNumber(input.principal, 'principal');
  ensureOneOf(input.paymentFrequency, ['SEMANAL', 'QUINCENAL', 'MENSUAL'], 'paymentFrequency');
  ensureOneOf(input.interestMode, ['SIMPLE', 'COMPUESTO'], 'interestMode');

  const result = db.prepare(`
    INSERT INTO loans (
      customer_id, principal_original, principal_outstanding, interest_rate_monthly, late_fee_rate,
      other_fee_rate, payment_frequency, interest_mode, start_date, status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVO', ?)
  `).run(
    input.customerId,
    Number(input.principal),
    Number(input.principal),
    Number(input.interestRateMonthly),
    Number(input.lateFeeRate),
    Number(input.otherFeeRate || 0),
    input.paymentFrequency,
    input.interestMode,
    input.startDate,
    input.notes || null,
  );

  db.prepare(`
    INSERT INTO cash_ledger (movement_date, movement_type, amount_in, amount_out, loan_id, reference)
    VALUES (?, 'DESEMBOLSO', 0, ?, ?, 'Desembolso inicial')
  `).run(input.startDate, Number(input.principal), result.lastInsertRowid);

  return result.lastInsertRowid;
}

function applyPayment(db, input) {
  const loanId = Number(input.loanId);
  const amount = ensurePositiveNumber(input.amount, 'amount');

  const installments = db.prepare(`
    SELECT id, due_date, principal_due, interest_due, late_fee_due, principal_paid, interest_paid, late_fee_paid
    FROM installments
    WHERE loan_id = ? AND status IN ('PENDIENTE', 'PARCIAL', 'VENCIDA')
    ORDER BY date(due_date), installment_no
  `).all(loanId);

  const allocationPlan = allocateAcrossInstallments(installments, amount);

  db.exec('BEGIN');
  try {
    const payment = db.prepare(`
      INSERT INTO payments (loan_id, payment_date, amount, method, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(loanId, input.paymentDate, amount, input.method || 'EFECTIVO', input.note || null);

    const insertAllocation = db.prepare(`
      INSERT INTO payment_allocations (payment_id, installment_id, component, amount)
      VALUES (?, ?, ?, ?)
    `);

    for (const alloc of allocationPlan) {
      insertAllocation.run(payment.lastInsertRowid, alloc.installmentId, alloc.component, alloc.amount);
    }

    const remaining = Number(db.prepare('SELECT principal_outstanding FROM loans WHERE id = ?').get(loanId).principal_outstanding);
    if (remaining <= 0.000001) {
      db.prepare("UPDATE loans SET status='PAGADO', principal_outstanding=0, updated_at=CURRENT_TIMESTAMP WHERE id = ?").run(loanId);
    }

    db.exec('COMMIT');
    return { paymentId: payment.lastInsertRowid, allocations: allocationPlan };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rescheduleAfterReenganche(db, input) {
  const loan = db.prepare(`
    SELECT id, payment_frequency, interest_rate_monthly, principal_outstanding
    FROM loans WHERE id = ?
  `).get(input.loanId);

  if (!loan) throw new Error('loan not found');

  const schedule = generateInstallmentPlan({
    principal: loan.principal_outstanding,
    interestRateMonthly: loan.interest_rate_monthly,
    frequency: loan.payment_frequency,
    startDate: input.fromDate,
    termCount: input.termCount,
  });

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM installments WHERE loan_id = ? AND status IN ('PENDIENTE', 'PARCIAL', 'VENCIDA')`).run(input.loanId);

    const insertInstallment = db.prepare(`
      INSERT INTO installments (loan_id, installment_no, due_date, principal_due, interest_due, late_fee_due, status)
      VALUES (?, ?, ?, ?, ?, 0, 'PENDIENTE')
    `);

    for (const item of schedule) {
      insertInstallment.run(input.loanId, item.installmentNo, item.dueDate, item.principalDue, item.interestDue);
    }

    db.exec('COMMIT');
    return schedule;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function applyReenganche(db, input) {
  const amount = ensurePositiveNumber(input.amount, 'amount');
  const loan = db.prepare('SELECT principal_outstanding FROM loans WHERE id = ?').get(Number(input.loanId));
  if (!loan) throw new Error('loan not found');

  const balanceBefore = Number(loan.principal_outstanding);
  const balanceAfter = Number((balanceBefore + amount).toFixed(2));

  db.prepare(`
    INSERT INTO reenganches (loan_id, amount, balance_before, balance_after, applied_date, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Number(input.loanId), amount, balanceBefore, balanceAfter, input.appliedDate, input.note || null);

  return { balanceBefore, balanceAfter };
}

function getCashPosition(db) {
  return db.prepare('SELECT total_in, total_out, cash_available FROM v_cash_position').get();
}

function getQuarterlyReport(db) {
  return db.prepare('SELECT * FROM v_quarterly_report').all();
}

module.exports = {
  allocatePayment,
  allocateAcrossInstallments,
  generateInstallmentPlan,
  createLoan,
  applyPayment,
  applyReenganche,
  rescheduleAfterReenganche,
  getCashPosition,
  getQuarterlyReport,
};
