const fs = require('fs');

const content = fs.readFileSync('server.js', 'utf8');

const startMarker = "// --- MIGRATION: Run on Server Start (STRICT REQUIREMENT) ---";
const endBlockMarker = "console.log('--- Migration Complete ---');\r\n} catch (err) {";
const endBlockMarker2 = "console.log('--- Migration Complete ---');\n} catch (err) {";

// We need to target the TRY block start.
const tryStart = "try {\r\n    console.log('--- Running Auto-Migration (migrate_auth_fix.js) ---');";
const tryStart2 = "try {\n    console.log('--- Running Auto-Migration (migrate_auth_fix.js) ---');";

let pStart = content.indexOf(tryStart);
if (pStart === -1) pStart = content.indexOf(tryStart2);

// We need to find the END of the catch block.
const catchEndMarker = "process.exit(1);\r\n}";
const catchEndMarker2 = "process.exit(1);\n}";

let pEnd = content.indexOf(catchEndMarker);
if (pEnd === -1) pEnd = content.indexOf(catchEndMarker2);

if (pStart !== -1 && pEnd !== -1) {
    const EndOfBlock = pEnd + catchEndMarker.length; // Approximate
    // Actually, simple match is better if we are sure of the text.
    // Let's replace the whole block by finding the start of the 'try' and the end of the 'catch'.

    const originalBlock = content.substring(pStart, pEnd + (content.indexOf(catchEndMarker) !== -1 ? catchEndMarker.length : catchEndMarker2.length));

    const newBlock = `
// ONLY run legacy SQLite migrations if NOT using Postgres.
if (!process.env.DATABASE_URL) {
${originalBlock}
} else {
    console.log('[Startup] Skipping legacy SQLite migrations (Running in Postgres Mode)');
}
`;
    // We replace the original block
    const newFileContent = content.substring(0, pStart) + newBlock + content.substring(pEnd + (content.indexOf(catchEndMarker) !== -1 ? catchEndMarker.length : catchEndMarker2.length));
    fs.writeFileSync('server.js', newFileContent);
    console.log("Fixed migration usage in server.js");
} else {
    console.error("Could not find migration block markers.");
    // Fallback: look for generic catch block end? Risk of hitting wrong one.
    // Let's use string replace() on the known try header if markers fail.
}
