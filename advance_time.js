const fs = require('fs');
const path = require('path');
const { getSimState, SIM_FILE } = require('./time_provider');

// SIM_TIME_STATE file is what the provider actually reads for 60x
const SIM_STATE_FILE = path.resolve(__dirname, 'sim_time_state.json');
const SCALE = process.env.SIM_TIME_SCALE ? parseInt(process.env.SIM_TIME_SCALE) : 60;

const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("Usage: node advance_time.js <amount> <unit>");
    process.exit(1);
}

// User uses: node advance_time.js 1 week
// args[0] = 1, args[1] = week
const amount = parseInt(args[0]);
const unit = args[1].toLowerCase();

if (isNaN(amount)) {
    console.error("Invalid amount");
    process.exit(1);
}

// Logic from advance_sim_time.js (60x)
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
const realMinutesToAdd = simMinutesToAdd / SCALE;

// Update State (sim_time_state.json)
let state = {};
try {
    if (fs.existsSync(SIM_STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(SIM_STATE_FILE, 'utf8'));
    }
} catch (e) { }

const currentOffset = state.offset_minutes || 0;
const newOffset = currentOffset + realMinutesToAdd;

fs.writeFileSync(SIM_STATE_FILE, JSON.stringify({ offset_minutes: newOffset }, null, 2));

// ALSO update legacy SIM_FILE (sim_time.json) just so we don't break legacy expectations if any
// (but provider primarily uses state for 60x)
try {
    // We need to calculate the new time for display/legacy
    // provider.getNow() uses the state we just wrote
    // We can't easily require provider here if we are inside the logic?
    // We can just rely on the provider.
} catch (e) { }

console.log(`--- Time Advanced ---`);
console.log(`Added Sim: ${amount} ${unit} (${simMinutesToAdd} sim mins)`);
console.log(`Offset Added (Real Mins): ${realMinutesToAdd.toFixed(4)}`);
console.log(`Total Offset (Real Mins): ${newOffset.toFixed(4)}`);
