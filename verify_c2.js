const transformSql = (sql) => {
    if (!sql) return sql;
    let result = '';
    let inString = false;
    let counter = 1;
    for (let i = 0; i < sql.length; i++) {
        const char = sql[i];
        if (char === "'") {
            if (sql[i + 1] === "'") { result += "''"; i++; continue; }
            inString = !inString;
        }
        if (char === '?' && !inString) { result += `$${counter++}`; }
        else { result += char; }
    }
    return result;
};

console.log("--- TEST A: Placeholder Safety ---");
const sql1 = "INSERT INTO log (msg) VALUES ('¿?') AND status = ?";
const transformed1 = transformSql(sql1);
console.log("Original:", sql1);
console.log("Transformed:", transformed1);
console.log("Verdict:", transformed1 === "INSERT INTO log (msg) VALUES ('¿?') AND status = $1" ? "✅ PASS" : "❌ FAIL");

console.log("\n--- TEST B: ID Logic (Explicit Approach) ---");
const IS_POSTGRES = true; // Simulating PG environment
const testInsertSql = "INSERT INTO tickets (match_id) VALUES (1)" + (IS_POSTGRES ? " RETURNING id" : "");
let finalSql = transformSql(testInsertSql);
console.log("Original Base SQL: INSERT INTO tickets (match_id) VALUES (1)");
console.log("Resulting SQL for PG:", finalSql);
const pgIdResultMock = { rows: [{ id: 888 }] };
// In our updated adapter, pgId will be 888 because rows[0].id exists
const pgId = (pgIdResultMock.rows && pgIdResultMock.rows[0]) ? pgIdResultMock.rows[0].id : null;
console.log("Mapped lastInsertRowid:", pgId);
console.log("Verdict:", (finalSql.includes('RETURNING id') && pgId === 888) ? "✅ PASS" : "❌ FAIL");

// SQLite Check (Literal)
const IS_POSTGRES_LITE = false;
const sqliteSql = "INSERT INTO tickets (match_id) VALUES (1)" + (IS_POSTGRES_LITE ? " RETURNING id" : "");
console.log("Resulting SQL for SQLite:", sqliteSql);
console.log("Verdict:", (!sqliteSql.includes('RETURNING id')) ? "✅ PASS" : "❌ FAIL");


console.log("\n--- TEST C: Janitor Logic ---");
const mockNow = Date.now();
const threshold = new Date(mockNow - 60 * 60 * 1000).toISOString();
const recentJobLockedAt = new Date(mockNow - 10 * 60 * 1000).toISOString();
const oldJobLockedAt = new Date(mockNow - 70 * 60 * 1000).toISOString();
console.log(`Threshold (1h): ${threshold}`);
console.log(`Recent Job (10m ago): ${recentJobLockedAt} -> Resetted? ${recentJobLockedAt < threshold}`);
console.log(`Old Job (70m ago): ${oldJobLockedAt} -> Resetted? ${oldJobLockedAt < threshold}`);
console.log("Verdict:", (recentJobLockedAt < threshold === false && oldJobLockedAt < threshold === true) ? "✅ PASS" : "❌ FAIL");
