const { Pool } = require('pg');

const IS_POSTGRES = !!process.env.DATABASE_URL;

if (!IS_POSTGRES) {
    console.error("FATAL: DATABASE_URL no está configurada. El sistema requiere PostgreSQL para producción.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

module.exports = {
    IS_POSTGRES,
    run: async (sql, ...args) => {
        try {
            // Convierte "?" de SQLite a "$1", "$2" de PostgreSQL
            let pgSql = sql;
            let counter = 1;
            while (pgSql.includes('?')) {
                pgSql = pgSql.replace('?', `$${counter}`);
                counter++;
            }
            const res = await pool.query(pgSql, args);
            return res; // compatible interface
        } catch (e) {
            throw e;
        }
    },
    all: async (sql, ...args) => {
        try {
            let pgSql = sql;
            let counter = 1;
            while (pgSql.includes('?')) {
                pgSql = pgSql.replace('?', `$${counter}`);
                counter++;
            }
            const res = await pool.query(pgSql, args);
            return res.rows;
        } catch (e) {
            throw e;
        }
    },
    get: async (sql, ...args) => {
        try {
            let pgSql = sql;
            let counter = 1;
            while (pgSql.includes('?')) {
                pgSql = pgSql.replace('?', `$${counter}`);
                counter++;
            }
            const res = await pool.query(pgSql, args);
            return res.rows.length ? res.rows[0] : null;
        } catch (e) {
            throw e;
        }
    },
    exec: async (sql) => {
        try {
            await pool.query(sql);
        } catch (e) {
            throw e;
        }
    },
    close: () => pool.end()
};
