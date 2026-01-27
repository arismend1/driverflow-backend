const crypto = require('crypto');

// Secrets to redact
const SENSITIVE_KEYS = ['password', 'token', 'authorization', 'secret', 'key'];

function redact(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const copy = Array.isArray(obj) ? [] : {};
    for (const k in obj) {
        if (SENSITIVE_KEYS.some(s => k.toLowerCase().includes(s))) {
            copy[k] = '[REDACTED]';
        } else if (typeof obj[k] === 'object') {
            copy[k] = redact(obj[k]);
        } else {
            copy[k] = obj[k];
        }
    }
    return copy;
}

const logger = {
    info: (msg, meta = {}) => log('INFO', msg, meta),
    warn: (msg, meta = {}) => log('WARN', msg, meta),
    error: (msg, meta = {}) => log('ERROR', msg, meta),
};

function log(level, msg, meta = {}) {
    // Ensure meta is an object
    const safeMeta = (typeof meta === 'object' && meta !== null) ? meta : { raw_meta: meta };

    // Extract common fields if present in meta to top-level
    const { req, res, err, duration_ms, user, ...extras } = safeMeta;

    const entry = {
        ts: new Date().toISOString(),
        level,
        msg,
        service: extras.service || 'api', // Default to API, worker overrides
        request_id: (req && req.requestId) || extras.request_id || undefined,
        route: (req && req.originalUrl) || extras.route || undefined,
        method: (req && req.method) || extras.method || undefined,
        status: (res && res.statusCode) || extras.status || undefined,
        duration_ms: duration_ms || extras.duration_ms || undefined,
        user_id: (user && user.id) || extras.user_id || undefined,
        user_type: (user && user.type) || extras.user_type || undefined,
        event: extras.event || 'log', // Default event
    };

    // Include Error Stack if present
    if (err) {
        entry.err = {
            message: err.message,
            stack: err.stack,
            code: err.code
        };
    }

    // Add extra custom fields, redacted
    Object.assign(entry, redact(extras));

    console.log(JSON.stringify(entry));
}

module.exports = logger;
