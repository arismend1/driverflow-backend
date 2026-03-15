'use strict';

const { execFileSync } = require('node:child_process');

function runSql(dbPath, sql) {
  execFileSync('sqlite3', [dbPath], { encoding: 'utf8', input: `${sql}\n` });
}

function queryJson(dbPath, sql) {
  const out = execFileSync('sqlite3', ['-json', dbPath], { encoding: 'utf8', input: `${sql}\n` }).trim();
  if (!out) return [];
  return JSON.parse(out);
}

function quote(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function transaction(dbPath, statements) {
  const script = ['BEGIN TRANSACTION;', ...statements, 'COMMIT;'].join('\n');
  runSql(dbPath, script);
}

module.exports = {
  runSql,
  queryJson,
  quote,
  transaction,
};
