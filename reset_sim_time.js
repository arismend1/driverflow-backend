const fs = require('fs');
const path = require('path');

const SIM_STATE_FILE = path.resolve(__dirname, 'sim_time_state.json');
// Default Scale 60 (should match Env)
const SCALE = process.env.SIM_TIME_SCALE ? parseInt(process.env.SIM_TIME_SCALE) : 60;

const targetDateStr = process.argv[2];

if (!targetDateStr) {
    console.log("Usage: node reset_sim_time.js <ISO_DATE>");
    console.log("Example: node reset_sim_time.js 2030-01-01T00:00:00Z");
    process.exit(1);
}

const targetDate = new Date(targetDateStr);
if (isNaN(targetDate.getTime())) {
    console.error("Invalid Date:", targetDateStr);
    process.exit(1);
}

const realNow = new Date();
const diffMs = targetDate.getTime() - realNow.getTime();

// Formula: sim = real + (offset_minutes * 60000 * SCALE)
// diff_ms = offset_minutes * 60000 * SCALE
// offset_minutes = diff_ms / (60000 * SCALE)

const offsetMinutes = diffMs / (60000 * SCALE);

fs.writeFileSync(SIM_STATE_FILE, JSON.stringify({ offset_minutes: offsetMinutes }, null, 2));

console.log(`--- Sim Time Reset ---`);
console.log(`Target Sim Time : ${targetDate.toISOString()}`);
console.log(`Real Time       : ${realNow.toISOString()}`);
console.log(`Calculated Offset: ${offsetMinutes.toFixed(4)} real minutes`);
console.log(`Scale           : ${SCALE}x`);
