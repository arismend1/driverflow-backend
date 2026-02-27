const sqlite3 = require('better-sqlite3');
const db = new sqlite3('database.sqlite');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

for (const table of tables) {
    console.log(`\n--- Schema for ${table.name} ---`);
    const info = db.prepare(`PRAGMA table_info(${table.name})`).all();
    console.log(info.map(c => `${c.name} (${c.type})`).join(', '));
}
