require('dotenv').config();
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "FOUND" : "NOT FOUND");
console.log("DB_PATH:", process.env.DB_PATH);
const db = require('./db_adapter');
console.log("IS_POSTGRES:", db.IS_POSTGRES);
db.close();
