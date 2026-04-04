const API_URL = "https://driverflow-backend.onrender.com";
const DEBUG_SECRET = "surgical_evidence_123";

async function verify() {
    try {
        const debugRes = await fetch(`${API_URL}/api/debug/sql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: DEBUG_SECRET, get_queues: true })
        });
        const debugData = await debugRes.json();
        
        console.log("Recent Outbox Flow:");
        debugData.outbox.slice(0, 10).forEach(e => {
            console.log(`Event ${e.id}: ${e.event_name} | Metadata: ${e.metadata}`);
        });
    } catch (e) {
        console.error("Diagnostic failed:", e.message);
    }
}

verify();
