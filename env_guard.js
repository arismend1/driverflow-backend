// env_guard.js
const fs = require('fs');

function validateEnv({ role }) {
    if (process.env.NODE_ENV !== 'production') return; // Skip in Dev/Test

    const required = [];

    // Common
    required.push('NODE_ENV', 'PORT', 'JWT_SECRET'); // Strict JWT_SECRET

    // DB Selection
    if (process.env.DATABASE_URL) {
        // Postgres
    } else {
        // Legacy SQLite support if needed
    }

    if (role === 'api') {
        required.push('ADMIN_SECRET', 'METRICS_TOKEN');

        // Email (Warn only)
        if (!process.env.SENDGRID_API_KEY) console.warn('⚠️  SENDGRID_API_KEY missing. Emails will fail.');
        if (!process.env.FROM_EMAIL) console.warn('⚠️  FROM_EMAIL missing. Emails will fail.');

        // Stripe Enforcement if configured
        if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.startsWith('sk_live_')) {
            console.error('FATAL: STRIPE_SECRET_KEY must be a Live Key (sk_live_...) in Production');
            process.exit(1);
        }
        if (process.env.STRIPE_WEBHOOK_SECRET && !process.env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
            console.error('FATAL: STRIPE_WEBHOOK_SECRET must be valid (whsec_...) in Production');
            process.exit(1);
        }
    }

    if (role === 'worker') {
        // Worker needs email keys too, but we let 'api' guarding cover it usually if shared env
    }

    const missing = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
        console.error(`FATAL: Missing Env Vars for ${role}: ${missing.join(', ')}`);
        process.exit(1);
    }

    console.log(`✅ Env Guard Passed (${role})`);
}

module.exports = { validateEnv };
