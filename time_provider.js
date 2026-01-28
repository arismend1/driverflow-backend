const time = require('./time_contract');
const path = require('path');

/**
 * LEGACY BRIDGE
 * This module is now a facade for time_contract.js.
 * It exists to support legacy imports in server.js without breaking changes.
 */

// Mapping legacy API to strict Contract
const nowIso = () => time.nowIso({ ctx: 'legacy_provider_iso' });
const nowEpochMs = () => time.nowMs({ ctx: 'legacy_provider_ms' });
const getNow = () => time.nowDate({ ctx: 'legacy_provider_date' });

// Stubs for internal logic that should now be dead or handled by contract
const getSimState = () => ({ offset_minutes: 0 }); // Contract handles this internally now
const IS_SIM = process.env.SIM_TIME === '1';
const SIM_FILE = path.resolve(__dirname, 'sim_time.json');

module.exports = {
    nowIso,
    nowEpochMs,
    getSimState,
    IS_SIM,
    getNow,
    getNowISO: nowIso,
    SIM_FILE
};

