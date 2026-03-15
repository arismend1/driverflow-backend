'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
  initDatabase,
  setupLender,
  createCustomer,
  createLoan,
  applyPayment,
  applyReenganche,
  getDashboard,
  exportBackup,
  restoreBackup,
} = require('../opcionb/app_service');

test('option B service full flow works end-to-end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opcionb-service-'));
  const db = join(dir, 'optionb.db');

  try {
    initDatabase(db);
    setupLender(db, {
      fullName: 'Prestamista Demo',
      initialCapital: 100000,
      defaultInterestRateMonthly: 10,
      defaultLateFeeRate: 5,
      defaultFrequency: 'MENSUAL',
      interestMode: 'SIMPLE',
    });

    const customer = createCustomer(db, { fullName: 'Juan Perez', phone: '8090001111' });
    assert.equal(customer.full_name, 'Juan Perez');

    const loanResult = createLoan(db, {
      customerId: customer.id,
      principal: 20000,
      interestRateMonthly: 10,
      lateFeeRate: 5,
      paymentFrequency: 'MENSUAL',
      interestMode: 'SIMPLE',
      startDate: '2026-01-01',
      termCount: 4,
    });

    assert.equal(loanResult.installments.length, 4);

    const payment = applyPayment(db, {
      loanId: loanResult.loan.id,
      paymentDate: '2026-02-01',
      amount: 3500,
      method: 'EFECTIVO',
    });

    assert.equal(payment.payment.loan_id, loanResult.loan.id);
    assert.equal(payment.allocations.length > 0, true);

    const reenganche = applyReenganche(db, {
      loanId: loanResult.loan.id,
      amount: 10000,
      appliedDate: '2026-02-02',
      note: 'reenganche de prueba',
      termCount: 6,
    });

    assert.equal(reenganche.loan.principal_outstanding > 0, true);

    const dashboard = getDashboard(db);
    assert.equal(typeof dashboard.cash.cash_available !== 'undefined', true);

    const backup = exportBackup(db, { filename: 'backup-test.json', deviceId: 'android-test' });
    assert.equal(backup.metadata.device_id, 'android-test');

    const dbRestore = join(dir, 'restore.db');
    initDatabase(dbRestore);
    restoreBackup(dbRestore, backup);
    const restoredDashboard = getDashboard(dbRestore);
    assert.equal(restoredDashboard.loans.length >= 1, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
