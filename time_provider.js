const fs = require('fs');
const path = require('path');

const SIM_STATE_FILE = path.resolve(__dirname, 'sim_time_state.json');
const IS_SIM = process.env.SIM_TIME === '1';
const SCALE = process.env.SIM_TIME_SCALE ? parseInt(process.env.SIM_TIME_SCALE) : 60;

const getSimState = () => {
    try {
        if (fs.existsSync(SIM_STATE_FILE)) {
            return JSON.parse(fs.readFileSync(SIM_STATE_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("Error reading sim_time_state.json:", e);
    }
    return { offset_minutes: 0 };
};

const nowEpochMs = () => {
    const realNow = Date.now();
    if (!IS_SIM) return realNow;

    const state = getSimState();
    // Formula: sim_now = real_now + (SIM_TIME_OFFSET_MINUTES * 60 * 1000 * SIM_TIME_SCALE)
    const offsetMs = (state.offset_minutes || 0) * 60 * 1000 * SCALE;
    return realNow + offsetMs;
};

const nowIso = () => {
    return new Date(nowEpochMs()).toISOString();
};

const getNow = () => new Date(nowEpochMs());
const SIM_FILE = path.resolve(__dirname, 'sim_time.json');

module.exports = {
    nowIso,
    nowEpochMs,
    getSimState,
    IS_SIM,
    getNow,
    getNowISO: nowIso, // Alias for backward compatibility if needed
    SIM_FILE
};
