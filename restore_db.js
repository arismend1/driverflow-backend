const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || 'driverflow.db';

// Arguments
const sourceFile = process.argv[2];
const confirm = process.argv.includes('--confirm');

console.log(`--- Restore Process ---`);

if (!sourceFile) {
    console.error(`❌ Error: Source file argument missing.`);
    console.error(`Usage: node restore_db.js <path_to_backup_file> --confirm`);
    process.exit(1);
}

if (!confirm) {
    console.error(`⚠️  WARNING: This will OVERWRITE the active database at: ${DB_PATH}`);
    console.error(`   To proceed, you must append the flag: --confirm`);
    process.exit(1);
}

if (!fs.existsSync(sourceFile)) {
    console.error(`❌ Error: Source backup file not found at ${sourceFile}`);
    process.exit(1);
}

console.log(`Source: ${sourceFile}`);
console.log(`Target: ${DB_PATH}`);
console.log(`Restoring...`);

try {
    fs.copyFileSync(sourceFile, DB_PATH);
    console.log(`✅ Restore complete.`);
    console.log(`   PLEASE RESTART THE SERVER if it was running.`);
} catch (e) {
    console.error(`❌ Error restoring file: ${e.message}`);
    process.exit(1);
}
