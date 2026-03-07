const API_URL = 'https://api.driverflow.app';
const d_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTIsInR5cGUiOiJkcml2ZXIiLCJpYXQiOjE3NzI0MzM0MjMsImV4cCI6MTc3MjUxOTgyM30.fivsNooKZEadnt1BA_6wpnFiYydD2zIj8FR9ImQSXUg';
const c_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NCwidHlwZSI6ImVtcHJlc2EiLCJpYXQiOjE3NzI0MzM1ODEsImV4cCI6MTc3MjUxOTk4MX0.zVFTg2nhKpcn0yvHSz6xOQgqmI9VD0o4oSCnEpWRCs4';

async function findMatch() {
    console.log('Fetching opportunities for driver 12...');
    const res = await fetch(`${API_URL}/matches/opportunities`, {
        headers: { 'Authorization': `Bearer ${d_token}` }
    });
    const opps = await res.json();
    console.log('Opportunities:', JSON.stringify(opps, null, 2));

    console.log('\nFetching candidates for company 4...');
    const res2 = await fetch(`${API_URL}/matches/candidates`, {
        headers: { 'Authorization': `Bearer ${c_token}` }
    });
    const cands = await res2.json();
    console.log('Candidates:', JSON.stringify(cands, null, 2));
}

findMatch();
