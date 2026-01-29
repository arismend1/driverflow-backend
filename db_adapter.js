const path = require('path');
const fs = require('fs');

// --- CONFIGURATION ---
const IS_POSTGRES = !!process.env.DATABASE_URL;
const IS_PROD = process.env.NODE_ENV === 'production';

let pgPool = null;
let sqliteDb = null;

if (IS_POSTGRES) {
    try {
        const pg = require('pg'); // Lazy load
        const { Pool } = pg;
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        console.log('[DB] Using PostgreSQL connection.');
    } catch (e) {
        console.error('[DB] FATAL: "pg" module not found but DATABASE_URL is set.');
        process.exit(1);
    }
} else {
    // SQLite Fallback
    if (IS_PROD) {
        console.error('[DB] FATAL: Production mode requires DATABASE_URL. SQLite is not allowed in production.');
        process.exit(1);
    }

    try {
        const Database = require('better-sqlite3'); // Lazy load
        const defaultPath = path.join(__dirname, 'driverflow.db');
        const dbPath = process.env.DB_PATH || defaultPath;

        console.log(`[DB] Using SQLite fallback: ${dbPath}`);
        sqliteDb = new Database(dbPath);
        // Enable WAL for concurrency
        sqliteDb.pragma('journal_mode = WAL');
    } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND') {
            console.error('[DB] FATAL: "better-sqlite3" not installed. Install it for local dev or set DATABASE_URL.');
        } else {
            console.error('[DB] SQLite Init Error:', e);
        }
        process.exit(1);
    }
}

// --- ADAPTER API ---

/**
 * Get a single row.
 * @param {string} sql 
 * @param {any[]} params 
 */
async function get(sql, ...params) {
    if (IS_POSTGRES) {
        const { query, args } = normalizeQuery(sql, params);
        const res = await pgPool.query(query, args);
        return res.rows[0];
    } else {
        return sqliteDb.prepare(sql).get(...params);
    }
}

/**
 * Get all rows.
 * @param {string} sql 
 * @param {any[]} params 
 */
async function all(sql, ...params) {
    if (IS_POSTGRES) {
        const { query, args } = normalizeQuery(sql, params);
        const res = await pgPool.query(query, args);
        return res.rows;
    } else {
        return sqliteDb.prepare(sql).all(...params);
    }
}

/**
 * Run a query (INSERT/UPDATE/DELETE).
 * Returns { changes: number, lastInsertRowid: number|string }
 * @param {string} sql 
 * @param {any[]} params 
 */
async function run(sql, ...params) {
    if (IS_POSTGRES) {
        const { query, args } = normalizeQuery(sql, params);
        let isInsert = /^\s*INSERT/i.test(query);
        let finalQuery = query;

        // PG needs RETURNING id to simulate lastInsertRowid behavior for Inserts
        if (isInsert && !query.toUpperCase().includes('RETURNING')) {
            // Basic heuristic, assumes 'id' column exists. 
            finalQuery += ' RETURNING id';
        }

        try {
            const res = await pgPool.query(finalQuery, args);
            // If it was an INSERT with RETURNING, get the ID.
            // If it was UPDATE/DELETE, res.rows is empty usually (unless RETURNING used).
            const id = (res.rows && res.rows.length > 0 && res.rows[0].id) ? res.rows[0].id : 0;
            return {
                changes: res.rowCount,
                lastInsertRowid: id
            };
        } catch (e) {
            // If "returning id" fails (table has no id?), fallback to original query
            if (isInsert && e.message && e.message.includes('does not exist')) {
                const res2 = await pgPool.query(query, args);
                return { changes: res2.rowCount, lastInsertRowid: 0 };
            }
            throw e;
        }
    } else {
        const stmt = sqliteDb.prepare(sql);
        const info = stmt.run(...params);
        return {
            changes: info.changes,
            lastInsertRowid: info.lastInsertRowid
        };
    }
}

/**
 * Execute a raw script (for migrations etc)
 */
async function exec(script) {
    if (IS_POSTGRES) {
        await pgPool.query(script);
    } else {
        sqliteDb.exec(script);
    }
}


// --- HELPER: Normalize SQL (? -> $n) for Postgres ---
function normalizeQuery(sql, params) {
    if (!IS_POSTGRES) return { query: sql, args: params };

    let i = 1;
    const query = sql.replace(/\?/g, () => `$${i++}`);
    return { query, args: params };
}

module.exports = {
    get,
    all,
    run,
    exec,
    IS_POSTGRES
};
