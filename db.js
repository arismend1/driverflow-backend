const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'driverflow.db');
console.log(`[DB.JS] Opened DB at: ${dbPath}`);
const db = new Database(dbPath, { verbose: process.env.DEBUG ? console.log : null });

module.exports = db;
