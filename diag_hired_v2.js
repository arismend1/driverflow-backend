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
        
        console.log("Recent Jobs:", debugData.jobs.map(j => ({ id: j.id, type: j.job_type, status: j.status, run_at: j.run_at })));
        console.log("Recent Outbox Events:", debugData.outbox.map(e => ({ id: e.id, name: e.event_name, status: e.queue_status })));
    } catch (e) {
        console.error("Diagnostic failed:", e.message);
    }
}

verify();
