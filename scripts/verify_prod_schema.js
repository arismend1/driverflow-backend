const { Client } = require('pg');

// Force usage of the env var if available, or try to load from .env
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error('❌ Error: DATABASE_URL environment variable is missing.');
    console.error('   Please run this script in the terminal where you set $env:DATABASE_URL');
    process.exit(1);
}

// Mask password for logging
const safeUrl = connectionString.replace(/:[^:@]+@/, ':****@');
console.log(`🔌 Intentando conectar a: ${safeUrl}`);

async function verify() {
    const client = new Client({
        connectionString,
        ssl: { rejectUnauthorized: false }, // Necessary for Render External
        connectionTimeoutMillis: 10000 // 10s timeout
    });

    try {
        await client.connect();
        console.log('✅ Conectado exitosamente.');

        // 1. List Tables
        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            ORDER BY table_name;
        `);

        if (res.rows.length === 0) {
            console.log('⚠️  ¡Atención! No se encontraron tablas públicas. La base de datos parece vacía.');
        } else {
            console.log(`\n📋 Tablas encontradas (${res.rows.length}):`);

            // 2. Count rows for each table
            for (const row of res.rows) {
                const tableName = row.table_name;
                const countRes = await client.query(`SELECT COUNT(*) as c FROM "${tableName}"`);
                console.log(`   - ${tableName}: ${countRes.rows[0].c} registros`);
            }

            console.log('\n✅ Todo parece correcto. La estructura está en su lugar.');
        }

        await client.end();
    } catch (err) {
        console.error('❌ Error de conexión:', err.message);
        if (err.message.includes('terminated') || err.message.includes('timeout')) {
            console.log('   (Esto puede ser un fallo de red momentáneo o bloqueo de IP. Intenta de nuevo).');
        }
    }
}

verify();
