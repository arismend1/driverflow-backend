'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  allocatePayment,
  allocateAcrossInstallments,
  generateInstallmentPlan,
} = require('../opcionb/loan_engine_sqlite');

test('allocatePayment applies mora -> interes -> capital', () => {
  const allocations = allocatePayment(
    { lateDue: 500, interestDue: 1200, principalDue: 10000 },
    4000,
  );

  assert.deepEqual(allocations, {
    mora: 500,
    interes: 1200,
    capital: 2300,
  });
});

test('allocateAcrossInstallments distributes by due order and components', () => {
  const plan = allocateAcrossInstallments([
    { id: 11, late_fee_due: 100, late_fee_paid: 0, interest_due: 300, interest_paid: 0, principal_due: 1000, principal_paid: 0 },
    { id: 12, late_fee_due: 0, late_fee_paid: 0, interest_due: 200, interest_paid: 0, principal_due: 1000, principal_paid: 0 },
  ], 1800);

  assert.deepEqual(plan, [
    { installmentId: 11, component: 'MORA', amount: 100 },
    { installmentId: 11, component: 'INTERES', amount: 300 },
    { installmentId: 11, component: 'CAPITAL', amount: 1000 },
    { installmentId: 12, component: 'INTERES', amount: 200 },
    { installmentId: 12, component: 'CAPITAL', amount: 200 },
  ]);
});

test('generateInstallmentPlan creates valid schedule for mensual frequency', () => {
  const schedule = generateInstallmentPlan({
    principal: 20000,
    interestRateMonthly: 10,
    frequency: 'MENSUAL',
    startDate: '2026-01-01',
    termCount: 4,
  });

  assert.equal(schedule.length, 4);
  assert.equal(schedule[0].installmentNo, 1);
  assert.equal(schedule[0].dueDate, '2026-01-31');
  assert.equal(schedule[3].dueDate, '2026-05-01');

  const principalTotal = schedule.reduce((acc, item) => acc + item.principalDue, 0);
  assert.equal(Number(principalTotal.toFixed(2)), 20000);
});
