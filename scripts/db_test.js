const db = require('../db_adapter');

async function test() {
    try {
        console.log('Testing DB Connection...');
        const row = await db.get('SELECT 1 as val');
        console.log('Success!', row);
        process.exit(0);
    } catch (e) {
        console.error('Connection failed:', e);
        process.exit(1);
    }
}

test();
