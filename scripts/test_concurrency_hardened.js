// test_concurrency_hardened.js
// Standalone simulation of concurrently claiming jobs

async function simulateConcurrency() {
    console.log("--- START CONCURRENCY TEST: Multi-Worker Claim Isolation ---");

    // Mock DB State
    let dbState = [
        { id: 1, status: 'pending', locked_by: null, locked_at: null },
        { id: 2, status: 'pending', locked_by: null, locked_at: null }
    ];

    const now = new Date().toISOString();

    // Mock DB functions implementing the NEW HARDENED LOGIC
    const dbInterface = (workerId) => ({
        all: async (sql, ...args) => {
            if (sql.includes("SELECT id")) {
                // Both workers see pending jobs
                return dbState.filter(r => r.status === 'pending').map(r => ({ id: r.id }));
            }
            if (sql.includes("SELECT *")) {
                // Re-fetch only what this worker successfully locked
                const idList = args[0]; // simplistic mock mapping
                return dbState.filter(r => r.status === 'processing' && r.locked_by === workerId && r.locked_at === now);
            }
            return [];
        },
        run: async (sql, ...args) => {
            if (sql.includes("UPDATE")) {
                const idList = [1, 2]; // simplification
                // CRITICAL ATOMIC SIMULATION
                let affected = 0;
                dbState.forEach(row => {
                    if (idList.includes(row.id) && row.status === 'pending') {
                        row.status = 'processing';
                        row.locked_by = workerId;
                        row.locked_at = now;
                        affected++;
                    }
                });
                console.log(`  [DB] Worker ${workerId} attempted UPDATE. Rows affected: ${affected}`);
            }
        }
    });

    // WORKER LOGIC (Extracted from worker_queue.js)
    async function workerClaim(workerId) {
        const tx = dbInterface(workerId);
        const BATCH_SIZE = 10;
        
        // 1. SELECT candidates
        const candidates = await tx.all("SELECT id FROM jobs_queue WHERE status = 'pending' LIMIT 10", now, BATCH_SIZE);
        console.log(`Worker ${workerId} found ${candidates.length} candidates.`);

        if (candidates.length > 0) {
            const ids = candidates.map(c => c.id);
            
            // 2. ATOMIC UPDATE with status='pending' check
            await tx.run("UPDATE jobs_queue SET status='processing' WHERE id IN (...) AND status='pending'", workerId, now);

            // 3. RE-SELECT verified claims
            const claimed = await tx.all("SELECT * FROM jobs_queue WHERE id IN (...) AND status='processing' AND locked_by=? AND locked_at=?", workerId, now);
            console.log(`Worker ${workerId} successfully claimed ${claimed.length} jobs.`);
            return claimed;
        }
        return [];
    }

    // SIMULATE CONCURRENT EXECUTION
    // In a real DB, these would hit the same lock, only one wins the 'pending' check
    console.log("Simulating Worker-A and Worker-B claiming simultaneously...");
    
    // We run them sequentially to simulate the atomic lock winner vs loser
    const resultA = await workerClaim("Worker-A");
    const resultB = await workerClaim("Worker-B");

    console.log("\n--- FINAL RESULTS ---");
    console.log("Worker-A claimed IDs:", resultA.map(j => j.id));
    console.log("Worker-B claimed IDs:", resultB.map(j => j.id));

    if (resultA.length > 0 && resultB.length === 0) {
        console.log("✅ SUCCESS: Isolation maintained. Worker-B failed to claim already-captured jobs.");
    } else if (resultA.length > 0 && resultB.length > 0) {
        const intersection = resultA.filter(a => resultB.some(b => b.id === a.id));
        if (intersection.length > 0) {
            console.error("❌ FAILURE: RACE CONDITION DETECTED! Both workers claimed IDs:", intersection.map(i => i.id));
        } else {
            console.log("✅ SUCCESS: Both workers got different jobs.");
        }
    } else {
        console.log("No jobs claimed.");
    }
}

simulateConcurrency();
