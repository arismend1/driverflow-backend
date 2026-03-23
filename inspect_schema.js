const fs = require('fs');
const { Client } = require('pg');

const client = new Client({
    connectionString: "postgresql://driverflow_db_user:GQmobgYujMULj0roQswbqfY4Ad5BkKY8@dpg-d5t4ribuibrs73cijiag-a.oregon-postgres.render.com/driverflow_db",
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        
        let output = "--- INVOICES TABLE SCHEMA ---\n";
        const invoicesSchema = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'invoices'
            ORDER BY ordinal_position;
        `);
        for (const row of invoicesSchema.rows) {
            output += `${row.column_name}: ${row.data_type}\n`;
        }

        output += "\n--- EMPRESAS TABLE SCHEMA ---\n";
        const empresasSchema = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'empresas'
            ORDER BY ordinal_position;
        `);
        for (const row of empresasSchema.rows) {
            output += `${row.column_name}: ${row.data_type}\n`;
        }

        fs.writeFileSync('schema_output_utf8.txt', output, 'utf8');
        console.log("Wrote to schema_output_utf8.txt");
    } catch (e) {
        console.error("Fallo:", e.message);
    } finally {
        await client.end();
    }
}
run();
