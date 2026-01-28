const assert = require('assert');
const path = require('path');
const fs = require('fs');

// 1. SETUP ENV
process.env.SIM_TIME = '1';
process.env.SIM_TIME_SCALE = '1'; // Safety
const time = require('../time_contract');

console.log('--- 🧪 STARTING TIME REGRESSION TEST ---');

// 2. TEST: parseLoose Strictness
console.log('[Test] Checking parseLoose strictness...');

const cases = [
    { val: null, expect: null, desc: 'Null' },
    { val: undefined, expect: null, desc: 'Undefined' },
    { val: '', expect: null, desc: 'Empty String' },
    { val: 0, expect: null, desc: 'Zero (1970)' },
    { val: '0', expect: null, desc: 'String Zero (1970)' },
    { val: -100, expect: null, desc: 'Negative Timestamp' },
    { val: 'invalid-date', expect: null, desc: 'Garbage String' },
    { val: '1999-12-31T23:59:59Z', expect: null, desc: 'Pre-2000 (Ghost)' },
    { val: 946684799000, expect: null, desc: 'Pre-2000 Timestamp' },
    // Valid cases
    { val: '2025-01-01T00:00:00Z', expectYear: 2025, desc: 'Valid ISO' },
    { val: 1735689600000, expectYear: 2025, desc: 'Valid Timestamp MS' },
    { val: 1735689600, expectYear: 2025, desc: 'Valid Timestamp SEC' }, // Heuristic check
];

let failed = 0;
for (const c of cases) {
    const res = time.parseLoose(c.val, { minYear: 2000 });

    if (c.expect === null) {
        if (res !== null) {
            console.error(`❌ FAIL: ${c.desc} -> Expected NULL, got ${res}`);
            failed++;
        } else {
            console.log(`✅ PASS: ${c.desc}`);
        }
    } else if (c.expectYear) {
        if (!res || res.getUTCFullYear() !== c.expectYear) {
            console.error(`❌ FAIL: ${c.desc} -> Expected Year ${c.expectYear}, got ${res.toISOString()}`);
            failed++;
        } else {
            console.log(`✅ PASS: ${c.desc}`);
        }
    }
}

// 3. TEST: Kill Switch
console.log('\n[Test] Checking Kill-Switch Warning...');
const stderrWrite = process.stderr.write;
let warningCaptured = false;

// Mock stderr to capture warning
process.stderr.write = (chunk) => {
    if (String(chunk).includes('WARNING: Date.now')) {
        warningCaptured = true;
    }
    // stderrWrite.call(process.stderr, chunk); // Passthrough optional
    return true;
};

const unsafeNow = Date.now(); // Should trigger warning
process.stderr.write = stderrWrite; // Restore

if (warningCaptured) {
    console.log('✅ PASS: Kill-switch warning captured.');
} else {
    console.error('❌ FAIL: Kill-switch did NOT warn on Date.now()!');
    failed++;
}

// 4. TEST: Offset Logic (Basic)
console.log('\n[Test] Checking Simulation Offset...');
// Manipulate sim state
const simStatePath = path.resolve(__dirname, '../sim_time_state.json');
fs.writeFileSync(simStatePath, JSON.stringify({ offset_minutes: 60 })); // +1 hour

const t1 = Date.now(); // Real (patched, but returns real time value)
const t2 = time.nowMs({ ctx: 'test' }); // Contract (should be +1h)

const diff = t2 - t1;
// Allow some margin for execution time
if (diff >= 3590000 && diff <= 3610000) {
    console.log(`✅ PASS: Offset applied correctly (~${diff}ms).`);
} else {
    console.error(`❌ FAIL: Offset mismatch. Diff: ${diff}ms (Expected ~3600000)`);
    // Note: If t1 came from Date.now() which is RealDate.now(), it is consistent.
    failed++;
}

// Cleanup
try { fs.unlinkSync(simStatePath); } catch { }

if (failed > 0) {
    console.error(`\n💥 FAILED: ${failed} regression tests failed.`);
    process.exit(1);
} else {
    console.log('\n🎉 SUCCESS: All regression tests passed.');
    process.exit(0);
}
