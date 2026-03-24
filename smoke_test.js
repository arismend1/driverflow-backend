const db = require('./db_adapter');
async function test() {
    console.log('[SmokeTest] Engine:', db.IS_POSTGRES ? 'POSTGRES' : 'SQLITE');
    try {
        await db.run('CREATE TABLE IF NOT EXISTS test_b (id INTEGER PRIMARY KEY)');
        await db.run('INSERT INTO test_b (id) VALUES (?)', Math.floor(Math.random() * 10000));
        const res = await db.get('SELECT count(*) as count FROM test_b');
        console.log('[SmokeTest] Result:', res);
        console.log('✅ SQLite Local Success');
        process.exit(0);
    } catch (e) {
        console.error('❌ SQL Error:', e);
        process.exit(1);
    }
}
test();
