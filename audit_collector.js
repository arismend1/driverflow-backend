const API_URL = 'https://api.driverflow.app';
const d_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTIsInR5cGUiOiJkcml2ZXIiLCJpYXQiOjE3NzI0MzM0MjMsImV4cCI6MTc3MjUxOTgyM30.fivsNooKZEadnt1BA_6wpnFiYydD2zIj8FR9ImQSXUg';
const c_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NCwidHlwZSI6ImVtcHJlc2EiLCJpYXQiOjE3NzI0MzM1ODEsImV4cCI6MTc3MjUxOTk4MX0.zVFTg2nhKpcn0yvHSz6xOQgqmI9VD0o4oSCnEpWRCs4';

async function audit() {
    console.log('--- LITERAL AUDIT REPORT ---');

    async function test(label, url, method, token = null) {
        console.log(`\n> ${label}`);
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        try {
            const res = await fetch(url, { method, headers });
            const body = await res.text();
            console.log(`Status: ${res.status}`);
            console.log(`Body: ${body}`);
            try { return JSON.parse(body); } catch { return body; }
        } catch (e) {
            console.log(`Error: ${e.message}`);
        }
    }

    // B) SECURITY
    await test('B1: POST /driver/confirm-share (No Token)', `${API_URL}/matches/25637/driver/confirm-share`, 'POST');
    await test('B2: POST /company/confirm-share (No Token)', `${API_URL}/matches/25637/company/confirm-share`, 'POST');

    // C) ORDER
    await test('C: Company Confirm before Driver Consent (Match 29487)', `${API_URL}/matches/29487/company/confirm-share`, 'POST', c_token);

    // F) MASKING (NEW)
    const opps = await test('F1: GET /matches/opportunities (Masking Active - Match 907)', `${API_URL}/matches/opportunities`, 'GET', d_token);
    const m907 = opps.find(o => o.match_id === 907);
    console.log('Match 907 JSON:', JSON.stringify(m907, null, 2));

    // F) MASKING (INFO_SHARED)
    const cands = await test('F2: GET /matches/candidates (Reveal Successful - Match 25637)', `${API_URL}/matches/candidates`, 'GET', c_token);
    const m25637 = cands.find(c => c.match_id === 25637);
    console.log('Match 25637 JSON:', JSON.stringify(m25637, null, 2));
}

audit();
