'use strict';

const crypto = require('node:crypto');

const EXPORT_TABLES = [
  'lender_profile',
  'lender_defaults',
  'customers',
  'loans',
  'installments',
  'payments',
  'payment_allocations',
  'reenganches',
  'cash_ledger',
  'audit_log',
  'backup_registry',
];

function createBackupEnvelope(data, metadata = {}) {
  const payload = {
    metadata: {
      version: metadata.version || '1.0.0',
      exported_at: metadata.exportedAt || new Date().toISOString(),
      device_id: metadata.deviceId || 'unknown-device',
      app: metadata.app || 'opcion-b',
    },
    data,
  };

  payload.metadata.sha256 = computeBackupHash(payload);
  return payload;
}

function computeBackupHash(payload) {
  const stable = JSON.stringify(payload);
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function validateBackupEnvelope(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload must be an object');
  }
  if (!payload.metadata || !payload.data) {
    throw new Error('payload must include metadata and data');
  }
  if (!payload.metadata.version || !payload.metadata.exported_at) {
    throw new Error('metadata.version and metadata.exported_at are required');
  }

  for (const table of EXPORT_TABLES) {
    if (!Array.isArray(payload.data[table])) {
      throw new Error(`payload.data.${table} must be an array`);
    }
  }

  return true;
}

function summarizeBackup(payload) {
  validateBackupEnvelope(payload);

  const counts = {};
  for (const table of EXPORT_TABLES) {
    counts[table] = payload.data[table].length;
  }

  return {
    exportedAt: payload.metadata.exported_at,
    version: payload.metadata.version,
    totals: counts,
    totalRows: Object.values(counts).reduce((acc, n) => acc + n, 0),
  };
}

function sqlQuote(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function toInsertStatements(tableName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  return rows.map((row) => {
    const columns = Object.keys(row);
    const values = columns.map((column) => sqlQuote(row[column]));
    return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
  });
}

function buildRestoreScript(payload) {
  validateBackupEnvelope(payload);

  const statements = ['BEGIN TRANSACTION;'];

  for (const table of EXPORT_TABLES) {
    const rows = payload.data[table];
    statements.push(`DELETE FROM ${table};`);
    statements.push(...toInsertStatements(table, rows));
  }

  statements.push('COMMIT;');
  return statements.join('\n');
}

module.exports = {
  EXPORT_TABLES,
  createBackupEnvelope,
  computeBackupHash,
  validateBackupEnvelope,
  summarizeBackup,
  toInsertStatements,
  buildRestoreScript,
};
