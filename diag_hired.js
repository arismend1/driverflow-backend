const API_URL = "https://driverflow-backend.onrender.com";
const DEBUG_SECRET = "surgical_evidence_123";

async function verify() {
    try {
        console.log("--- Diagnosing Match State ---");
        // Get recent drivers and companies to identify a likely match or just use a known match if found
        const debugRes = await fetch(`${API_URL}/api/debug/sql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: DEBUG_SECRET })
        });
        const debugData = await debugRes.json();
        
        console.log("Recent Drivers:", debugData.drivers.map(d => d.id));
        console.log("Recent Companies:", debugData.empresas.map(e => e.id));

        // We need a Match ID. Since I can't easily query /potential_matches, 
        // I'll try to find one by looking at the outbox if there was a recent 'match_generated' event.
        const matchEvents = debugData.outbox.filter(e => e.event_name === 'match_generated');
        console.log("Recent Match Events:", matchEvents.map(e => e.id));

        // Let's assume we can't easily find a match. 
        // I'll check if there's any match 136252 (from lux-check) still open.
        // Actually, I'll just report what I found.
    } catch (e) {
        console.error("Diagnostic failed:", e.message);
    }
}

verify();
