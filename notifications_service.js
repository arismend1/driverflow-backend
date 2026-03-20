const db = require('./db_adapter');
const logger = require('./logger');
const admin = require('firebase-admin');

// Initialize Firebase Admin once
try {
    const serviceAccountJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (serviceAccountJson) {
        const serviceAccount = JSON.parse(serviceAccountJson);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("[PUSH] Firebase Admin initialized.");
    } else {
        console.warn("[PUSH] FCM_SERVICE_ACCOUNT_JSON missing. Push disabled.");
    }
} catch (e) {
    console.error("[PUSH] Firebase Init Error:", e.message);
}

/**
 * Sends a push notification to all devices registered for a user.
 * Best-effort only: never throws upward, logs errors, cleans up stale tokens.
 * @param {number} userId  - The user's ID (from drivers or empresas table)
 * @param {string} userType - 'driver' or 'empresa'
 * @param {string} title
 * @param {string} body
 * @param {object} data - optional extra data payload
 */
async function sendPush(userId, userType, title, body, data = {}) {
    try {
        if (!userId || !userType || !admin.apps.length) return;

        const tokens = await db.all('SELECT token FROM push_tokens WHERE user_id = ? AND user_type = ?', userId, userType);
        if (!tokens || tokens.length === 0) return;

        console.log(`[PUSH] User #${userId} (${userType}): "${title}" (${tokens.length} devices)`);

        for (const t of tokens) {
            const message = {
                notification: { title, body },
                data: { ...data }, 
                token: t.token
            };

            try {
                await admin.messaging().send(message);
                logger.info(`[PUSH_SENT] To: ${t.token.slice(0, 10)}...`);
            } catch (error) {
                // Handle stale/invalid tokens (FCM v1 codes: UNREGISTERED, INVALID_ARGUMENT)
                if (error.code === 'messaging/registration-token-not-registered' || 
                    error.code === 'messaging/invalid-argument') {
                    logger.warn(`[PUSH_CLEANUP] Removing stale token: ${t.token.slice(0, 10)}...`);
                    await db.run('DELETE FROM push_tokens WHERE token = ?', t.token);
                } else {
                    logger.error(`[PUSH_ERROR] Token ${t.token.slice(0, 10)}...: ${error.message}`);
                }
            }
        }
    } catch (err) {
        logger.error(`[PUSH_SERVICE_FAIL] User #${userId} (${userType}): ${err.message}`);
    }
}

module.exports = { sendPush };
