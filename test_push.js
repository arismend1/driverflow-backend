const { sendPush } = require('./notifications_service');
const db = require('./db_adapter');

async function test() {
    console.log("--- Testing Notifications Service ---");
    
    const testUserId = 999;
    const testToken = "test_token_123";
    
    try {
        // 1. Setup dummy token
        await db.run('DELETE FROM push_tokens WHERE user_id = ?', testUserId);
        await db.run('INSERT INTO push_tokens (user_id, token, platform) VALUES (?, ?, ?)', testUserId, testToken, 'android');
        console.log("✅ Dummy token registered.");

        // 2. Test sendPush
        console.log("Testing sendPush...");
        await sendPush(testUserId, "Test Title", "Test Message Body");
        
        console.log("✅ Test completed. Check logs above for '[PUSH_SENT]'.");
    } catch (e) {
        console.error("❌ Test failed:", e.message);
    } finally {
        // Cleanup
        await db.run('DELETE FROM push_tokens WHERE user_id = ?', testUserId);
        process.exit(0);
    }
}

test();
