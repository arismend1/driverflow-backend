const fs = require('fs');
const path = require('path');

// CONFIG
const MIN_YEAR_DEFAULT = 2000;
const MAX_YEAR_DEFAULT = 2100;
const SIM_STATE_FILE = path.resolve(__dirname, 'sim_time_state.json');

/**
 * STRICT TIME CONTRACT
 * Rule: NO Direct Date.now() allowed in business logic.
 * Rule: NO Implicit 1970 fallback.
 */

function getSimOffsetMinutes() {
    try {
        if (fs.existsSync(SIM_STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(SIM_STATE_FILE, 'utf8'));
            return data.offset_minutes || 0;
        }
    } catch (e) {
        // console.error('[TimeContract] Warning: Could not read sim state', e);
    }
    return 0;
}

function assertSaneNow(ms, ctx) {
    const y = new Date(ms).getFullYear();
    if (y < MIN_YEAR_DEFAULT || y > MAX_YEAR_DEFAULT) {
        throw new Error(`[TimeContract] FATAL: Time sanity check failed for context '${ctx}'. Year ${y} is out of bounds (${MIN_YEAR_DEFAULT}-${MAX_YEAR_DEFAULT}).`);
    }
}

// --- KILL-SWITCH PROTECTION ---
const RealDate = Date;

if (process.env.SIM_TIME === '1' || process.env.NODE_ENV === 'test') {
    console.log('[TimeContract] 🛡️  Installing Time Kill-Switch...');

    // Monkey-patch Date to warn on unsafe usage
    // We cannot fully disable it because libs (sqlite, etc) might use it.
    // We strictly warn on: Date.now() and new Date() (no args).

    global.Date = class ProtectedDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) {
                // Check stack trace to see if it's us (time_contract) or them (user code)
                // Actually, time_contract uses RealDate, so any call here is "them".
                // BUT: Many third-party libs use new Date(). We can't crash them.
                // We will rely on "Critical Warning" for now to flush out business logic errors.
                // const stack = new Error().stack;
                // if (!stack.includes('node_modules')) ...
                // For now, silent allow for libs, but known business logic paths should use contract.
                super();
            } else {
                super(...args);
            }
        }

        static now() {
            // This is the most dangerous one used for logic.
            // We'll throw a loud warning.
            process.stderr.write('[TimeContract] ⚠️  WARNING: Date.now() called directly! Use time.nowMs()\n');
            const stack = new Error().stack.split('\n');
            if (stack[2]) process.stderr.write(`   at ${stack[2].trim()}\n`);
            return RealDate.now();
        }
    };

    // Copy static methods we missed?
    // Copy static methods we missed?
    global.Date.parse = RealDate.parse;
    global.Date.UTC = RealDate.UTC;
}

const api = {};
module.exports = api;

// INTERNAL OVERRIDE: API must use RealDate
api.nowMs = (ctx = 'unknown') => {
    let now = RealDate.now();
    if (process.env.SIM_TIME === '1') {
        const offsetMins = getSimOffsetMinutes();
        now += offsetMins * 60 * 1000;
    }
    assertSaneNow(now, ctx);
    return now;
};

api.nowDate = (ctx = 'unknown') => new RealDate(api.nowMs(ctx));
api.nowIso = (ctx = 'unknown') => api.nowDate(ctx).toISOString();

api.parseLoose = (val, opts = {}) => {
    const minYear = opts.minYear || MIN_YEAR_DEFAULT;
    if (val === null || val === undefined || val === '') return null;
    if (val === 0 || val === '0') return null;

    let d = null;
    if (typeof val === 'number' || (typeof val === 'string' && val.trim() !== '' && !isNaN(val))) {
        const num = Number(val);
        if (num <= 0) return null;
        // Heuristic improvement:
        // 2026 AD in sec: ~1.7e9
        // 2026 AD in ms:  ~1.7e12
        // 1999 AD in ms:  ~9.4e11 (simpler heuristic < 3e10 roughly year 2920)
        // If num < 100,000,000,000 (1e11, year 5138 in sec, year 1973 in ms)
        // Let's use 1e11. 1999 ms (9.4e11) > 1e11 (Correct, native ms).
        // 2025 sec (1.7e9) < 1e11 (Correct, multiply by 1000).
        const ms = num < 100000000000 ? num * 1000 : num;
        d = new RealDate(ms); // Uses RealDate
    } else {
        d = new RealDate(val); // Uses RealDate
    }

    if (!d || isNaN(d.getTime())) return null;
    if (d.getFullYear() < minYear) return null;

    return d;
};

