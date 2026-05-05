'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runSql, queryJson, quote, transaction } = require('./sqlite_cli');
const { generateInstallmentPlan } = require('./loan_engine_sqlite');
const { EXPORT_TABLES, createBackupEnvelope, buildRestoreScript } = require('./backup_sqlite');

const SCHEMA_PATH = resolve(__dirname, '../sql/loan_option_b_schema.sql');

function initDatabase(dbPath) {
  const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
  runSql(dbPath, schemaSql);
}

function setupLender(dbPath, input) {
  transaction(dbPath, [
    'DELETE FROM lender_profile;',
    'DELETE FROM lender_defaults;',
    `INSERT INTO lender_profile (id, full_name, currency_code, initial_capital) VALUES (1, ${quote(input.fullName)}, ${quote(input.currencyCode || 'DOP')}, ${Number(input.initialCapital || 0)});`,
    `INSERT INTO lender_defaults (id, default_interest_rate_monthly, default_late_fee_rate, default_other_fee_rate, default_frequency, interest_mode) VALUES (1, ${Number(input.defaultInterestRateMonthly || 0)}, ${Number(input.defaultLateFeeRate || 0)}, ${Number(input.defaultOtherFeeRate || 0)}, ${quote(input.defaultFrequency || 'MENSUAL')}, ${quote(input.interestMode || 'SIMPLE')});`,
    `INSERT INTO cash_ledger (movement_date, movement_type, amount_in, amount_out, reference) VALUES (date('now'), 'CAPITAL_INICIAL', ${Number(input.initialCapital || 0)}, 0, 'Capital inicial');`,
  ]);
}

function createCustomer(dbPath, input) {
  runSql(dbPath, `
    INSERT INTO customers (full_name, phone, address, national_id)
    VALUES (${quote(input.fullName)}, ${quote(input.phone)}, ${quote(input.address)}, ${quote(input.nationalId)});
  `);
  return queryJson(dbPath, 'SELECT * FROM customers ORDER BY id DESC LIMIT 1;')[0];
}

function createLoan(dbPath, input) {
  runSql(dbPath, `
    INSERT INTO loans (
      customer_id, principal_original, principal_outstanding, interest_rate_monthly, late_fee_rate,
      other_fee_rate, payment_frequency, interest_mode, start_date, status, notes
    ) VALUES (
      ${Number(input.customerId)}, ${Number(input.principal)}, ${Number(input.principal)},
      ${Number(input.interestRateMonthly)}, ${Number(input.lateFeeRate)}, ${Number(input.otherFeeRate || 0)},
      ${quote(input.paymentFrequency)}, ${quote(input.interestMode || 'SIMPLE')}, ${quote(input.startDate)}, 'ACTIVO', ${quote(input.notes)}
    );
  `);

  const loan = queryJson(dbPath, 'SELECT * FROM loans ORDER BY id DESC LIMIT 1;')[0];
  const schedule = generateInstallmentPlan({
    principal: input.principal,
    interestRateMonthly: input.interestRateMonthly,
    frequency: input.paymentFrequency,
    startDate: input.startDate,
    termCount: input.termCount,
  });

  const statements = [
    `INSERT INTO cash_ledger (movement_date, movement_type, amount_in, amount_out, loan_id, reference) VALUES (${quote(input.startDate)}, 'DESEMBOLSO', 0, ${Number(input.principal)}, ${loan.id}, 'Desembolso inicial');`,
  ];

  for (const item of schedule) {
    statements.push(
      `INSERT INTO installments (loan_id, installment_no, due_date, principal_due, interest_due, late_fee_due, status) VALUES (${loan.id}, ${item.installmentNo}, ${quote(item.dueDate)}, ${Number(item.principalDue)}, ${Number(item.interestDue)}, ${Number(item.lateFeeDue)}, 'PENDIENTE');`,
    );
  }
  transaction(dbPath, statements);

  return {
    loan: queryJson(dbPath, `SELECT * FROM loans WHERE id = ${loan.id};`)[0],
    installments: queryJson(dbPath, `SELECT * FROM installments WHERE loan_id = ${loan.id} ORDER BY installment_no;`),
  };
}

function applyPayment(dbPath, input) {
  runSql(dbPath, `INSERT INTO payments (loan_id, payment_date, amount, method, note) VALUES (${Number(input.loanId)}, ${quote(input.paymentDate)}, ${Number(input.amount)}, ${quote(input.method || 'EFECTIVO')}, ${quote(input.note)});`);
  const payment = queryJson(dbPath, 'SELECT * FROM payments ORDER BY id DESC LIMIT 1;')[0];

  let remaining = Number(input.amount);
  const installments = queryJson(dbPath, `
    SELECT * FROM installments WHERE loan_id = ${Number(input.loanId)} AND status IN ('PENDIENTE','PARCIAL','VENCIDA')
    ORDER BY date(due_date), installment_no;
  `);

  const statements = [];
  for (const row of installments) {
    if (remaining <= 0) break;

    const lateDue = Math.max(0, Number(row.late_fee_due) - Number(row.late_fee_paid));
    const interestDue = Math.max(0, Number(row.interest_due) - Number(row.interest_paid));
    const principalDue = Math.max(0, Number(row.principal_due) - Number(row.principal_paid));

    const allocMora = Math.min(remaining, lateDue);
    remaining -= allocMora;
    if (allocMora > 0) statements.push(`INSERT INTO payment_allocations (payment_id, installment_id, component, amount) VALUES (${payment.id}, ${row.id}, 'MORA', ${allocMora});`);

    const allocInteres = Math.min(remaining, interestDue);
    remaining -= allocInteres;
    if (allocInteres > 0) statements.push(`INSERT INTO payment_allocations (payment_id, installment_id, component, amount) VALUES (${payment.id}, ${row.id}, 'INTERES', ${allocInteres});`);

    const allocCapital = Math.min(remaining, principalDue);
    remaining -= allocCapital;
    if (allocCapital > 0) statements.push(`INSERT INTO payment_allocations (payment_id, installment_id, component, amount) VALUES (${payment.id}, ${row.id}, 'CAPITAL', ${allocCapital});`);
  }

  if (remaining > 0) {
    statements.push(`INSERT INTO payment_allocations (payment_id, installment_id, component, amount) VALUES (${payment.id}, NULL, 'CAPITAL', ${remaining});`);
  }

  transaction(dbPath, statements);

  runSql(dbPath, `
    UPDATE loans
      SET status = CASE WHEN principal_outstanding <= 0 THEN 'PAGADO' ELSE status END,
          principal_outstanding = CASE WHEN principal_outstanding < 0 THEN 0 ELSE principal_outstanding END,
          updated_at = CURRENT_TIMESTAMP
    WHERE id = ${Number(input.loanId)};
  `);

  return {
    payment: queryJson(dbPath, `SELECT * FROM payments WHERE id = ${payment.id};`)[0],
    allocations: queryJson(dbPath, `SELECT * FROM payment_allocations WHERE payment_id = ${payment.id};`),
    loan: queryJson(dbPath, `SELECT * FROM loans WHERE id = ${Number(input.loanId)};`)[0],
  };
}

function applyReenganche(dbPath, input) {
  const loan = queryJson(dbPath, `SELECT * FROM loans WHERE id = ${Number(input.loanId)};`)[0];
  const before = Number(loan.principal_outstanding);
  const after = Number((before + Number(input.amount)).toFixed(2));

  runSql(dbPath, `
    INSERT INTO reenganches (loan_id, amount, balance_before, balance_after, applied_date, note)
    VALUES (${Number(input.loanId)}, ${Number(input.amount)}, ${before}, ${after}, ${quote(input.appliedDate)}, ${quote(input.note)});
  `);

  if (input.termCount && Number(input.termCount) > 0) {
    const refreshedLoan = queryJson(dbPath, `SELECT * FROM loans WHERE id = ${Number(input.loanId)};`)[0];
    const schedule = generateInstallmentPlan({
      principal: refreshedLoan.principal_outstanding,
      interestRateMonthly: refreshedLoan.interest_rate_monthly,
      frequency: refreshedLoan.payment_frequency,
      startDate: input.appliedDate,
      termCount: Number(input.termCount),
    });

    const statements = [`DELETE FROM installments WHERE loan_id = ${Number(input.loanId)} AND status IN ('PENDIENTE','PARCIAL','VENCIDA');`];
    for (const item of schedule) {
      statements.push(`INSERT INTO installments (loan_id, installment_no, due_date, principal_due, interest_due, late_fee_due, status) VALUES (${Number(input.loanId)}, ${item.installmentNo}, ${quote(item.dueDate)}, ${Number(item.principalDue)}, ${Number(item.interestDue)}, 0, 'PENDIENTE');`);
    }
    transaction(dbPath, statements);
  }

  return {
    reenganche: queryJson(dbPath, 'SELECT * FROM reenganches ORDER BY id DESC LIMIT 1;')[0],
    loan: queryJson(dbPath, `SELECT * FROM loans WHERE id = ${Number(input.loanId)};`)[0],
  };
}

function getDashboard(dbPath) {
  return {
    cash: queryJson(dbPath, 'SELECT * FROM v_cash_position;')[0],
    portfolio: queryJson(dbPath, 'SELECT * FROM v_portfolio_summary;')[0],
    quarterly: queryJson(dbPath, 'SELECT * FROM v_quarterly_report;'),
    loans: queryJson(dbPath, 'SELECT * FROM v_loan_customer_overview ORDER BY loan_id DESC;'),
  };
}

function exportBackup(dbPath, metadata = {}) {
  const data = {};
  for (const table of EXPORT_TABLES) {
    data[table] = queryJson(dbPath, `SELECT * FROM ${table};`);
  }

  const envelope = createBackupEnvelope(data, metadata);
  runSql(dbPath, `INSERT INTO backup_registry (backup_filename, backup_sha256, status, notes) VALUES (${quote(metadata.filename || 'manual-backup.json')}, ${quote(envelope.metadata.sha256)}, 'EXPORTADO', 'Backup generado');`);
  return envelope;
}

function restoreBackup(dbPath, payload) {
  const restoreSql = buildRestoreScript(payload);
  runSql(dbPath, restoreSql);
  runSql(dbPath, `INSERT INTO backup_registry (backup_filename, backup_sha256, status, notes, restored_at) VALUES ('restore.json', ${quote(payload.metadata.sha256 || null)}, 'RESTAURADO', 'Restore ejecutado', CURRENT_TIMESTAMP);`);
}

module.exports = {
  initDatabase,
  setupLender,
  createCustomer,
  createLoan,
  applyPayment,
  applyReenganche,
  getDashboard,
  exportBackup,
  restoreBackup,
};
