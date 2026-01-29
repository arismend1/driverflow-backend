const fs = require('fs');

const content = fs.readFileSync('server.js', 'utf8');

const targetCheck = "if (process.env.NODE_ENV !== 'production' && (dbPath.includes('prod') || dbPath.includes('live'))) {";
const replacement = "if (!process.env.DATABASE_URL && process.env.NODE_ENV !== 'production' && (dbPath.includes('prod') || dbPath.includes('live'))) {";

if (content.includes(targetCheck)) {
    const newContent = content.replace(targetCheck, replacement);
    fs.writeFileSync('server.js', newContent);
    console.log("Fixed safety check in server.js");
} else {
    console.error("Could not find safety check line.");
    console.log("Looking for:", targetCheck);
}
