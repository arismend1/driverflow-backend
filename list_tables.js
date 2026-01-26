const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database(
  process.env.DB_PATH || 'driverflow.db'
);

db.all(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  (err, rows) => {
    if (err) {
      console.error(err);
    } else {
      console.log(rows.map(r => r.name).join('\n'));
    }
    db.close();
  }
);
