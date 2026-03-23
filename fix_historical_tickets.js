require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log("Connecting to production DB...");
        await client.connect();
        
        console.log("Starting surgical historical ticket fix...");
        
        const updateQuery = `
            UPDATE tickets
            SET billing_status = 'void'
            FROM potential_matches pm
            WHERE tickets.match_id = pm.id
            AND pm.status IN ('CLOSED', 'REJECTED', 'HIRED_ELSEWHERE')
            RETURNING tickets.id, tickets.match_id, pm.status as match_status;
        `;
        
        const result = await client.query(updateQuery);
        console.log(`Successfully voided ${result.rowCount} corrupted tickets.`);
        
        if (result.rowCount > 0) {
            console.table(result.rows);
        }
        
    } catch (e) {
        console.error("Migration failed:", e.message);
    } finally {
        await client.end();
        console.log("Disconnected.");
    }
}
run();
