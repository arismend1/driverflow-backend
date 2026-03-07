const API_URL = 'https://api.driverflow.app';
const d_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTIsInR5cGUiOiJkcml2ZXIiLCJpYXQiOjE3NzI0MzM0MjMsImV4cCI6MTc3MjUxOTgyM30.fivsNooKZEadnt1BA_6wpnFiYydD2zIj8FR9ImQSXUg';
const c_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NCwidHlwZSI6ImVtcHJlc2EiLCJpYXQiOjE3NzI0MzM1ODEsImV4cCI6MTc3MjUxOTk4MX0.zVFTg2nhKpcn0yvHSz6xOQgqmI9VD0o4oSCnEpWRCs4';
const matchId = 25637;

async function runAudit() {
    console.log('--- STARTING PRODUCTION AUDIT A-E ---');

    console.log('\n--- Test A: 401 Unauthorized ---');
    const a1 = await fetch(`${API_URL}/matches/${matchId}/driver/confirm-share`, { method: 'POST' });
    console.log(`Driver confirm-share (no token): ${a1.status}`);
    const a2 = await fetch(`${API_URL}/matches/${matchId}/company/confirm-share`, { method: 'POST' });
    console.log(`Company confirm-share (no token): ${a2.status}`);

    console.log('\n--- Test B: 409 Incorrect Order ---');
    const b = await fetch(`${API_URL}/matches/${matchId}/company/confirm-share`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c_token}` }
    });
    console.log(`Company confirm-share (before driver): ${b.status}`);
    const b_body = await b.json();
    console.log('Body:', JSON.stringify(b_body));

    console.log('\n--- Test C: Success Flow (Driver Consent) ---');
    const c_d = await fetch(`${API_URL}/matches/${matchId}/driver/confirm-share`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${d_token}` }
    });
    console.log(`Driver confirm-share: ${c_d.status}`);
    console.log('Body:', JSON.stringify(await c_d.json()));

    console.log('\n--- Test C: Success Flow (Company Consent) ---');
    const c_c = await fetch(`${API_URL}/matches/${matchId}/company/confirm-share`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c_token}` }
    });
    console.log(`Company confirm-share: ${c_c.status}`);
    const c_c_body = await c_c.json();
    console.log('Body:', JSON.stringify(c_c_body));

    console.log('\n--- Test D: Anti-Double Billing ---');
    const d = await fetch(`${API_URL}/matches/${matchId}/company/confirm-share`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${c_token}` }
    });
    console.log(`Company confirm-share (second time): ${d.status}`);
    console.log('Body:', JSON.stringify(await d.json()));

    console.log('\n--- Test E: Masking Reveal ---');
    const e_d = await fetch(`${API_URL}/matches/opportunities`, {
        headers: { 'Authorization': `Bearer ${d_token}` }
    });
    const opps = await e_d.json();
    const target = opps.find(o => o.match_id === matchId);
    console.log(`Match ${matchId} for Driver:`, JSON.stringify(target, null, 2));

    const e_c = await fetch(`${API_URL}/matches/candidates`, {
        headers: { 'Authorization': `Bearer ${c_token}` }
    });
    const cands = await e_c.json();
    const target_c = cands.find(c => c.match_id === matchId);
    console.log(`Match ${matchId} for Company:`, JSON.stringify(target_c, null, 2));
}

runAudit();
