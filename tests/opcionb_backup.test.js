'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPORT_TABLES,
  createBackupEnvelope,
  validateBackupEnvelope,
  summarizeBackup,
  buildRestoreScript,
  toInsertStatements,
} = require('../opcionb/backup_sqlite');

function emptyData() {
  const data = {};
  for (const table of EXPORT_TABLES) data[table] = [];
  return data;
}

test('createBackupEnvelope builds metadata and hash', () => {
  const payload = createBackupEnvelope(emptyData(), {
    version: '1.2.0',
    exportedAt: '2026-03-01T10:00:00.000Z',
    deviceId: 'android-01',
  });

  assert.equal(payload.metadata.version, '1.2.0');
  assert.equal(payload.metadata.device_id, 'android-01');
  assert.equal(typeof payload.metadata.sha256, 'string');
  assert.equal(payload.metadata.sha256.length, 64);
});

test('validateBackupEnvelope rejects missing table arrays', () => {
  const payload = createBackupEnvelope({ customers: [] });

  assert.throws(() => validateBackupEnvelope(payload), /payload\.data\.lender_profile must be an array/);
});

test('summarizeBackup returns totals', () => {
  const data = emptyData();
  data.customers.push({ id: 1, full_name: 'Juan' });
  data.loans.push({ id: 1, customer_id: 1, principal_original: 1000 });

  const summary = summarizeBackup(createBackupEnvelope(data, { exportedAt: '2026-03-01T00:00:00.000Z' }));
  assert.equal(summary.totals.customers, 1);
  assert.equal(summary.totals.loans, 1);
  assert.equal(summary.totalRows, 2);
});

test('toInsertStatements escapes single quotes', () => {
  const sql = toInsertStatements('customers', [{ id: 1, full_name: "O'Neil" }]);
  assert.equal(sql[0], "INSERT INTO customers (id, full_name) VALUES (1, 'O''Neil');");
});

test('buildRestoreScript wraps all table operations in transaction', () => {
  const data = emptyData();
  data.customers.push({ id: 1, full_name: 'Juan' });

  const script = buildRestoreScript(createBackupEnvelope(data));
  assert.equal(script.startsWith('BEGIN TRANSACTION;'), true);
  assert.equal(script.includes('DELETE FROM customers;'), true);
  assert.equal(script.includes("INSERT INTO customers (id, full_name) VALUES (1, 'Juan');"), true);
  assert.equal(script.endsWith('COMMIT;'), true);
});
