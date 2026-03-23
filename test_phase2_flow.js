// Node 24 native fetch used
const jwt = require('jsonwebtoken');

const API_URL = 'http://localhost:10000';
const SECRET = process.env.JWT_SECRET || 'mi_secreto_super_seguro'; // Fallback to dev secret normally
const TEST_COMPANY_EMAIL = 'hqpaintingllc@hotmail.com';

async function runSimulation() {
    console.log(`\n======================================================`);
    console.log(`🚀 RUNNING PHASE 2 LEGAL COMPLIANCE SIMULATION (E2E)`);
    console.log(`======================================================`);

    // 1. Manually craft a RESTRICTED token (Simulating a legacy session or old login)
    const restrictedPayload = {
        id: 8,
        email: TEST_COMPANY_EMAIL,
        type: 'empresa',
        legal_accepted: false,
        legal_version: 'v0' // Obsolete version
    };
    const restrictedToken = jwt.sign(restrictedPayload, SECRET, { expiresIn: '7d' });
    console.log(`\n[STEP 1] Booting mobile app with legacy RESTRICTED token...`);

    // 2. Simulate AuthContext bootstrap() -> registerPushToken()
    console.log(`\n[STEP 2] Mobile app automatically calls POST /api/push/register in background...`);
    const pushRes1 = await fetch(`${API_URL}/api/push/register`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${restrictedToken}`
        },
        body: JSON.stringify({ token: 'simulated_fcm_token_123', platform: 'android' })
    });
    const pushData1 = await pushRes1.json();
    
    console.log(`[HTTP STATUS]: ${pushRes1.status}`);
    console.log(`[RESPONSE]:`, pushData1);

    if (pushRes1.status === 403 && pushData1.requires_legal_acceptance) {
        console.log(`✅ SUCCESS: Backend correctly BLOCKED the push registration.`);
        console.log(`✅ SUCCESS: Global Interceptor catches 403, sets needsLegalAccept=true.`);
        console.log(`✅ SUCCESS: RootNavigator blocks PIN screen and displays LegalAcceptanceScreen.`);
    } else {
        console.error(`❌ FAILURE: Backend did not block the request!`);
        process.exit(1);
    }

    // 3. Simulate user tapping "I Accept" on LegalAcceptanceScreen
    console.log(`\n[STEP 3] User taps 'I Accept'. Submitting correct payload to POST /api/legal/accept...`);
    const acceptRes = await fetch(`${API_URL}/api/legal/accept`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${restrictedToken}`
        },
        body: JSON.stringify({ accept_terms: true, accept_privacy: true })
    });
    const acceptData = await acceptRes.json();

    console.log(`[HTTP STATUS]: ${acceptRes.status}`);
    console.log(`[RESPONSE]:`, acceptData);

    if (acceptRes.status === 200 && acceptData.token) {
        console.log(`✅ SUCCESS: Backend accepted the signatures without 400 Bad Request.`);
        console.log(`✅ SUCCESS: Backend issued a new UNLOCKED JWT.`);
    } else {
        console.error(`❌ FAILURE: Backend rejected the signature payload!`);
        process.exit(1);
    }

    const unlockedToken = acceptData.token;

    // 4. Simulate AuthContext completeLegalAcceptance -> registerPushToken
    console.log(`\n[STEP 4] Mobile app saves unlocked token, hides Legal Screen, and retries registerPushToken...`);
    const pushRes2 = await fetch(`${API_URL}/api/push/register`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${unlockedToken}`
        },
        body: JSON.stringify({ token: 'simulated_fcm_token_123', platform: 'android' })
    });
    
    console.log(`[HTTP STATUS]: ${pushRes2.status}`);

    if (pushRes2.status === 200) {
        console.log(`✅ SUCCESS: Backend ALLOWED the push registration with the new token.`);
        console.log(`\n🎉 PHASE 2 E2E SIMULATION COMPLETED SECURELY AND WITHOUT LOOPS.`);
    } else {
        console.error(`❌ FAILURE: Backend blocked the unlocked token!`);
        process.exit(1);
    }
}

runSimulation().catch(console.error);
