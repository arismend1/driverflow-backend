'use strict';

const express = require('express');
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
} = require('./app_service');

const app = express();
app.use(express.json({ limit: '2mb' }));

const DB_PATH = process.env.OPTIONB_DB_PATH || './opcionb.sqlite';

app.get('/optionb/health', (_req, res) => {
  res.json({ ok: true, dbPath: DB_PATH });
});

app.post('/optionb/init', (_req, res) => {
  initDatabase(DB_PATH);
  res.json({ ok: true });
});

app.post('/optionb/setup', (req, res) => {
  setupLender(DB_PATH, req.body || {});
  res.json({ ok: true });
});

app.post('/optionb/customers', (req, res) => {
  const customer = createCustomer(DB_PATH, req.body || {});
  res.status(201).json(customer);
});

app.post('/optionb/loans', (req, res) => {
  const result = createLoan(DB_PATH, req.body || {});
  res.status(201).json(result);
});

app.post('/optionb/loans/:loanId/payments', (req, res) => {
  const result = applyPayment(DB_PATH, { ...req.body, loanId: Number(req.params.loanId) });
  res.status(201).json(result);
});

app.post('/optionb/loans/:loanId/reenganches', (req, res) => {
  const result = applyReenganche(DB_PATH, { ...req.body, loanId: Number(req.params.loanId) });
  res.status(201).json(result);
});

app.get('/optionb/dashboard', (_req, res) => {
  res.json(getDashboard(DB_PATH));
});

app.post('/optionb/backup/export', (req, res) => {
  const payload = exportBackup(DB_PATH, req.body || {});
  res.json(payload);
});

app.post('/optionb/backup/restore', (req, res) => {
  restoreBackup(DB_PATH, req.body);
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error.message || 'Unexpected error' });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3099);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Option B API listening on :${port}`);
  });
}

module.exports = app;
