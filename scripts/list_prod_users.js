const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false // Retrying without SSL
});

(async () => {
    try {
        console.log('--- EMPRESAS ---');
        const companies = await pool.query('SELECT id, nombre, email, contacto, verified, city, created_at, password_hash FROM empresas ORDER BY created_at DESC LIMIT 10');
        if (companies.rowCount === 0) console.log('(None)');
        companies.rows.forEach(c => {
            console.log(`[ID: ${c.id}] ${c.nombre} (${c.email || c.contacto}) | Verified: ${c.verified} | PW Length: ${c.password_hash ? c.password_hash.length : 0}`);
        });

        console.log('\n--- DRIVERS ---');
        const drivers = await pool.query('SELECT id, nombre, contacto, verified, tipo_licencia, created_at, password_hash, status FROM drivers ORDER BY created_at DESC LIMIT 10');
        if (drivers.rowCount === 0) console.log('(None)');
        drivers.rows.forEach(d => {
            console.log(`[ID: ${d.id}] ${d.nombre} (${d.contacto}) | Verified: ${d.verified} | Status: ${d.status} | PW Length: ${d.password_hash ? d.password_hash.length : 0}`);
        });

    } catch (e) {
        console.error('DB Error:', e);
    } finally {
        pool.end();
    }
})();
