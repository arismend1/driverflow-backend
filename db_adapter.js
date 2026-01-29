// require('dotenv').config(); // Not needed in Prod (Env injected)
const path = require('path');

// --- CONFIGURATION ---
const IS_POSTGRES = !!process.env.DATABASE_URL;
const SQLITE_PATH = process.env.DB_PATH || path.join(__dirname, 'driverflow.db');

let pgPool = null;
let sqliteDb = null;

if (IS_POSTGRES) {
    try {
        pg = require('pg');
    } catch (e) {
        console.error('[DB] root pg not found. Ensure "pg" is in package.json');
        throw e;
    }
    const { Pool } = pg;
    pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    console.log('[DB] Using PostgreSQL connection.');
} else {
    console.error('[DB] ❌ DATABASE_URL is missing. SQLite fallback is disabled in production.');
    console.error('[DB] Please configure DATABASE_URL in your environment variables.');
    process.exit(1);
}

// --- ADAPTER API (Async Wrapper) ---

/**
 * Get a single row.
 * @param {string} sql 
 * @param {any[]} params 
 * @returns {Promise<any>} row or undefined
 */
async function get(sql, ...params) {
    // Forced Postgres
    const { query, args } = normalizeQuery(sql, params);
    const res = await pgPool.query(query, args);
    return res.rows[0];
}

/**
 * Get all rows.
 * @param {string} sql 
 * @param {any[]} params 
 * @returns {Promise<any[]>} rows
 */
async function all(sql, ...params) {
    // Forced Postgres
    const { query, args } = normalizeQuery(sql, params);
    const res = await pgPool.query(query, args);
    return res.rows;
}

/**
 * Run a query (INSERT/UPDATE/DELETE).
 * @param {string} sql 
 * @param {any[]} params 
 * @returns {Promise<{changes: number, lastInsertRowid: number|string}>}
 */
async function run(sql, ...params) {
    // Forced Postgres
    const { query, args } = normalizeQuery(sql, params);

    // Handle RETURNING id if it looks like an INSERT
    // SQLite returns lastInsertRowid automatically. PG needs RETURNING id.
    let isInsert = /^\s*INSERT/i.test(query);
    let finalQuery = query;
    if (isInsert && !query.toUpperCase().includes('RETURNING')) {
        // Heuristic: Append RETURNING id if it's missing. 
        // LIMITATION: Only works if table has 'id'. Most do.
        finalQuery += ' RETURNING id';
    }

    try {
        const res = await pgPool.query(finalQuery, args);
        return {
            changes: res.rowCount,
            lastInsertRowid: (isInsert && res.rows[0]) ? res.rows[0].id : 0
        };
    } catch (e) {
        // If RETURNING id failed (maybe table has no id), retry without it?
        // Or assume caller handles it.
        if (isInsert && e.message.includes('column "id" does not exist')) {
            // Retry without RETURNING
            const res2 = await pgPool.query(query, args);
            return { changes: res2.rowCount, lastInsertRowid: 0 };
        }
        throw e;
    }
}

// --- HELPER: Normalize SQL (? -> $n) ---
function normalizeQuery(sql, params) {
    if (!IS_POSTGRES) return { query: sql, args: params };

    let i = 1;
    // Replace ? with $1, $2, etc.
    const query = sql.replace(/\?/g, () => `$${i++}`);
    return { query, args: params };
}

// --- EXPORT ---
module.exports = {
    get,
    all,
    run
};
