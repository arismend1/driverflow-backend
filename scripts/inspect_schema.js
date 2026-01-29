const db = require('better-sqlite3')('driverflow.db');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();

console.log("--- SCHEMA REPORT ---");
tables.forEach(t => {
    console.log(`\nTABLE: ${t.name}`);
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
    cols.forEach(c => {
        console.log(` - ${c.name} (${c.type}) [NotNull:${c.notnull}, PK:${c.pk}]`);
    });
});
