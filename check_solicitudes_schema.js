const db = require('./db_adapter');

async function checkSol() {
    try {
        console.log("--- Checking Schema for solicitudes ---");
        const rows = await db.all(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'solicitudes'
        `);

        console.log("Columns:", rows.map(r => r.column_name).sort().join(', '));
    } catch (e) {
        console.error("Error:", e);
    }
}

checkSol();
