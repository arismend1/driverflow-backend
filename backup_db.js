const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || 'driverflow.db';
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';

console.log(`--- Starting Backup Process ---`);
console.log(`Source DB: ${DB_PATH}`);
console.log(`Backup Dir: ${BACKUP_DIR}`);

// 1. Validate Source
if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ Error: Database file not found at ${DB_PATH}`);
    process.exit(1);
}

// 2. Prepare Destination ID
try {
    if (!fs.existsSync(BACKUP_DIR)) {
        console.log(`Creating backup directory...`);
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
} catch (e) {
    console.error(`❌ Error creating backup dir: ${e.message}`);
    process.exit(1);
}

// 3. Generate Filename
const now = new Date();
// Format: YYYYMMDD_HHMMSS
const pad = (n) => n.toString().padStart(2, '0');
const timestamp =
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) + '_' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());

const filename = `driverflow_${timestamp}.db`;
const destPath = path.join(BACKUP_DIR, filename);

// 4. Copy File
try {
    fs.copyFileSync(DB_PATH, destPath);
    console.log(`✅ Backup created at: ${destPath}`);

    // Check size
    const stats = fs.statSync(destPath);
    console.log(`   Size: ${stats.size} bytes`);

} catch (e) {
    console.error(`❌ Error copying file: ${e.message}`);
    if (e.code === 'EBUSY') {
        console.error('   (The database might be locked. stop the server first)');
    }
    process.exit(1);
}
