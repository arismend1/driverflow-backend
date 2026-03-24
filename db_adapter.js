const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const IS_POSTGRES = !!process.env.DATABASE_URL;
let pool = null;
let sqliteDb = null;

if (IS_POSTGRES) {
    console.log("[DB] Engine: POSTGRES");
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
} else {
    const dbPath = path.resolve(process.env.DB_PATH || 'driverflow.db');
    console.log("[DB] Engine: SQLITE");
    console.log("[DB] Path:", dbPath);

    // Dynamically load better-sqlite3
    try {
        const Database = require('better-sqlite3');
        sqliteDb = new Database(dbPath);
    } catch (err) {
        console.error("FATAL: SQLite fallback failed. Ensure 'better-sqlite3' is installed.");
        process.exit(1);
    }
}

module.exports = {
    IS_POSTGRES,
    run: async (sql, ...args) => {
        try {
            if (IS_POSTGRES) {
                let pgSql = sql;
                let counter = 1;
                while (pgSql.includes('?')) {
                    pgSql = pgSql.replace('?', `$${counter}`);
                    counter++;
                }
                const res = await pool.query(pgSql, args);
                // Map lastInsertRowid for compatibility if possible (PG uses RETURNING usually)
                // But for simple INSERTs, we'll just return the result
                return { lastInsertRowid: res.oid || (res.rows[0] ? res.rows[0].id : null), ...res };
            } else {
                const info = sqliteDb.prepare(sql).run(args);
                return { lastInsertRowid: info.lastInsertRowid, ...info };
            }
        } catch (e) {
            throw e;
        }
    },
    all: async (sql, ...args) => {
        try {
            if (IS_POSTGRES) {
                let pgSql = sql;
                let counter = 1;
                while (pgSql.includes('?')) {
                    pgSql = pgSql.replace('?', `$${counter}`);
                    counter++;
                }
                const res = await pool.query(pgSql, args);
                return res.rows;
            } else {
                return sqliteDb.prepare(sql).all(args);
            }
        } catch (e) {
            throw e;
        }
    },
    get: async (sql, ...args) => {
        try {
            if (IS_POSTGRES) {
                let pgSql = sql;
                let counter = 1;
                while (pgSql.includes('?')) {
                    pgSql = pgSql.replace('?', `$${counter}`);
                    counter++;
                }
                const res = await pool.query(pgSql, args);
                return res.rows.length ? res.rows[0] : null;
            } else {
                return sqliteDb.prepare(sql).get(args);
            }
        } catch (e) {
            throw e;
        }
    },
    exec: async (sql) => {
        try {
            if (IS_POSTGRES) {
                await pool.query(sql);
            } else {
                sqliteDb.exec(sql);
            }
        } catch (e) {
            throw e;
        }
    },
    close: () => {
        if (pool) pool.end();
        if (sqliteDb) sqliteDb.close();
    },
    beginTransaction: async () => {
        if (IS_POSTGRES) {
            const client = await pool.connect();
            await client.query('BEGIN');
            return {
                run: async (sql, ...args) => {
                    let pgSql = sql; let c = 1; while(pgSql.includes('?')){ pgSql = pgSql.replace('?', `$${c++}`); }
                    const res = await client.query(pgSql, args);
                    return { lastInsertRowid: res.oid || (res.rows[0] ? res.rows[0].id : null), ...res };
                },
                get: async (sql, ...args) => {
                    let pgSql = sql; let c = 1; while(pgSql.includes('?')){ pgSql = pgSql.replace('?', `$${c++}`); }
                    const res = await client.query(pgSql, args);
                    return res.rows.length ? res.rows[0] : null;
                },
                all: async (sql, ...args) => {
                    let pgSql = sql; let c = 1; while(pgSql.includes('?')){ pgSql = pgSql.replace('?', `$${c++}`); }
                    const res = await client.query(pgSql, args);
                    return res.rows;
                },
                commit: async () => { await client.query('COMMIT'); client.release(); },
                rollback: async () => { await client.query('ROLLBACK'); client.release(); }
            };
        } else {
            sqliteDb.exec('BEGIN');
            return {
                run: async (sql, ...args) => {
                    const info = sqliteDb.prepare(sql).run(args);
                    return { lastInsertRowid: info.lastInsertRowid, ...info };
                },
                get: async (sql, ...args) => sqliteDb.prepare(sql).get(args),
                all: async (sql, ...args) => sqliteDb.prepare(sql).all(args),
                commit: async () => sqliteDb.exec('COMMIT'),
                rollback: async () => { try{ sqliteDb.exec('ROLLBACK') }catch(e){} }
            };
        }
    }
};
