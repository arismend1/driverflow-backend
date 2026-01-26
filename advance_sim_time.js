const fs = require('fs');
const path = require('path');
const { getSimState } = require('./time_provider');

const SIM_STATE_FILE = path.resolve(__dirname, 'sim_time_state.json');
const SCALE = process.env.SIM_TIME_SCALE ? parseInt(process.env.SIM_TIME_SCALE) : 60;

const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("Usage: node advance_sim_time.js <unit> <amount>");
    console.log("  Units: minutes, hours, days, weeks");
    process.exit(1);
}

const unit = args[0].toLowerCase();
const amount = parseInt(args[1]);

if (isNaN(amount)) {
    console.error("Invalid amount");
    process.exit(1);
}

// Convert input to SIMULATED MINUTES
let simMinutesToAdd = 0;
switch (unit) {
    case 'minute':
    case 'minutes':
        simMinutesToAdd = amount;
        break;
    case 'hour':
    case 'hours':
        simMinutesToAdd = amount * 60;
        break;
    case 'day':
    case 'days':
        simMinutesToAdd = amount * 24 * 60;
        break;
    case 'week':
    case 'weeks':
        simMinutesToAdd = amount * 7 * 24 * 60;
        break;
    default:
        console.error("Unknown unit:", unit);
        process.exit(1);
}

// Convert SIMULATED MINUTES to REAL MIMUTES (Offset Unit)
// Relationship: 1 Real Minute = SCALE (60) Sim Minutes
// Real Minutes Needed = Sim Minutes / SCALE
const realMinutesToAdd = simMinutesToAdd / SCALE;

// Update State
const state = getSimState();
const currentOffset = state.offset_minutes || 0;
const newOffset = currentOffset + realMinutesToAdd;

fs.writeFileSync(SIM_STATE_FILE, JSON.stringify({ offset_minutes: newOffset }, null, 2));

console.log(`--- Time Advanced ---`);
console.log(`Added Sim Duration : ${amount} ${unit} (${simMinutesToAdd} sim minutes)`);
console.log(`Real Offset Added  : ${realMinutesToAdd.toFixed(4)} real minutes`);
console.log(`Total Offset       : ${newOffset.toFixed(4)} real minutes`);

// Show current sim time preview
const timeProvider = require('./time_provider');
// Force reload logic or just use naive calc for display since env is loaded 
// (time_provider reads file on every call in current impl? No, getSimState does.)
console.log(`New Sim Time       : ${timeProvider.nowIso()}`);
