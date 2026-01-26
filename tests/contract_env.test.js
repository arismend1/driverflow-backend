const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

test('CI Environment Contract', (t) => {
    // 1. CI must always run with DRY_RUN=1
    if (process.env.CI) {
        if (process.env.DRY_RUN !== '1') {
            assert.fail(`CI must run with DRY_RUN=1 to prevent real sends. Current: ${process.env.DRY_RUN}`);
        }
        // Optional: Ensure API Key is not required (implicit by not failing here if missing, logic is in processor)
    }
});

test('Project Structure Contract', (t) => {
    const testsDir = path.join(PROJECT_ROOT, 'tests');

    // Helper to scan directory RECURSIVELY
    function scan(dir, list = []) {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const file of files) {
            if (file.name === 'node_modules' || file.name === '.git') continue;

            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                scan(fullPath, list);
            } else {
                list.push(fullPath);
            }
        }
        return list;
    }

    const allFiles = scan(PROJECT_ROOT);
    const violations = [];

    // 2. All *.test.js must live under /tests
    for (const file of allFiles) {
        if (file.endsWith('.test.js')) {
            // Check if it starts with testsDir
            // Normalize paths to avoid slash issues
            if (!file.startsWith(testsDir)) {
                violations.push(`Test file outside /tests: ${path.relative(PROJECT_ROOT, file)}`);
            }
        }
    }

    // 3. No insertion scripts under /tests
    // "Scripts de inserción" defined as: name includes "insert_" OR ends with ".script.js"
    const testFiles = fs.readdirSync(testsDir).map(name => path.join(testsDir, name)); // Non-recursive for tests dir depth 0 commonly, but let's be safe if recursive needed? 
    // User req says: "Verificar que NO existan scripts de inserción dentro de /tests"
    // Let's us the 'allFiles' filtered for inside testsDir to be thorough
    const filesInTests = allFiles.filter(f => f.startsWith(testsDir));

    for (const file of filesInTests) {
        const filename = path.basename(file);
        if (filename.includes('insert_') || filename.endsWith('.script.js')) {
            violations.push(`Insertion script inside /tests: ${path.relative(PROJECT_ROOT, file)}`);
        }
    }

    if (violations.length > 0) {
        assert.fail(`Project Structure Violations Found:\n${violations.join('\n')}`);
    }
});
