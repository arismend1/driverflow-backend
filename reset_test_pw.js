const bcrypt = require('bcryptjs');
const db = require('better-sqlite3')('driverflow.db');
const hash = bcrypt.hashSync('Angeles2515@', 10);

db.prepare("UPDATE empresas SET password_hash = ? WHERE contacto = ?").run(hash, "luxuryservicesfl@gmail.com");
db.prepare("UPDATE drivers SET password_hash = ? WHERE contacto = ?").run(hash, "anglorangzam@gmail.com");

console.log('Passwords forcefully synced');
