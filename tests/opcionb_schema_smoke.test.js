'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

function sql(dbPath, statement) {
  return execSync(`sqlite3 ${dbPath} \"${statement.replace(/\"/g, '\\\"')}\"`, { encoding: 'utf8' }).trim();
}

test('opcion B schema supports reenganche and accounting flow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opcionb-'));
  const db = join(dir, 'test.db');

  try {
    execSync(`sqlite3 ${db} < sql/loan_option_b_schema.sql`, { stdio: 'pipe' });

    sql(db, "INSERT INTO customers (full_name) VALUES ('Juan Perez');");
    sql(db, `
      INSERT INTO loans (
        customer_id, principal_original, principal_outstanding, interest_rate_monthly, late_fee_rate,
        other_fee_rate, payment_frequency, interest_mode, start_date, status
      ) VALUES (1, 20000, 20000, 10, 5, 0, 'MENSUAL', 'SIMPLE', '2026-01-01', 'ACTIVO');
    `);

    sql(db, `
      INSERT INTO installments (loan_id, installment_no, due_date, principal_due, interest_due, late_fee_due)
      VALUES (1, 1, '2026-02-01', 10000, 2000, 500);
    `);

    sql(db, "INSERT INTO payments (loan_id, payment_date, amount, method) VALUES (1, '2026-02-01', 12500, 'EFECTIVO');");
    sql(db, "INSERT INTO payment_allocations (payment_id, installment_id, component, amount) VALUES (1, 1, 'MORA', 500);");
    sql(db, "INSERT INTO payment_allocations (payment_id, installment_id, component, amount) VALUES (1, 1, 'INTERES', 2000);");
    sql(db, "INSERT INTO payment_allocations (payment_id, installment_id, component, amount) VALUES (1, 1, 'CAPITAL', 10000);");

    const afterPayment = Number(sql(db, 'SELECT principal_outstanding FROM loans WHERE id=1;'));
    assert.equal(afterPayment, 10000);

    const installmentStatus = sql(db, "SELECT status || '|' || principal_paid || '|' || interest_paid || '|' || late_fee_paid FROM installments WHERE id = 1;");
    assert.equal(installmentStatus, 'PAGADA|10000|2000|500');

    sql(db, "INSERT INTO reenganches (loan_id, amount, balance_before, balance_after, applied_date, note) VALUES (1, 10000, 10000, 20000, '2026-02-02', 'Necesidad personal');");

    const afterReenganche = Number(sql(db, 'SELECT principal_outstanding FROM loans WHERE id=1;'));
    assert.equal(afterReenganche, 20000);

    const cash = sql(db, 'SELECT total_in || \"|\" || total_out || \"|\" || cash_available FROM v_cash_position;');
    assert.equal(cash, '12500|10000|2500');

    const audit = Number(sql(db, "SELECT COUNT(*) FROM audit_log WHERE action='REENGANCHE_APLICADO';"));
    assert.equal(audit, 1);

    const quarterRow = sql(db, "SELECT year || 'Q' || quarter || '|' || earnings_income || '|' || capital_out FROM v_quarterly_report LIMIT 1;");
    assert.equal(quarterRow.includes('|2500|10000'), true);

    sql(db, "INSERT INTO backup_registry (backup_filename, backup_sha256, status) VALUES ('backup-20260202.json', 'abc123', 'EXPORTADO');");
    const backups = Number(sql(db, 'SELECT COUNT(*) FROM backup_registry;'));
    assert.equal(backups, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
