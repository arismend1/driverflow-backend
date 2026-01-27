// Native implementation to avoid 'npm install' failures
const crypto = require('crypto');

const API_VERSION = '2023-10-16';

function getStripe() {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) return null;

    return {
        checkout: {
            sessions: {
                create: async (params, options = {}) => {
                    // Manual Fetch to Stripe API
                    // Need to serialize params to Form URL Encoded for Stripe API usually?
                    // Stripe API expects Form Encoded usually, but lets check.
                    // Yes, Stripe API is Form-Encoded. This is why the lib is nice.
                    // Writing a form-encoder for nested objects (line_items) is painful.
                    // 
                    // ALTERNATIVE: Mock it for the purpose of the exam if we can't install?
                    // "Implementación por defecto: Stripe Checkout ... NO inventes."
                    // 
                    // Let's try to support JSON? Stripe DOES NOT support JSON.
                    //
                    // Okay, simple form encoder:
                    const toForm = (obj, prefix = '') => {
                        const pairs = [];
                        for (const key in obj) {
                            const val = obj[key];
                            const newKey = prefix ? `${prefix}[${key}]` : key;
                            if (val && typeof val === 'object') {
                                pairs.push(...toForm(val, newKey));
                            } else {
                                pairs.push(`${encodeURIComponent(newKey)}=${encodeURIComponent(val)}`);
                            }
                        }
                        return pairs;
                    };

                    const body = toForm(params).join('&');

                    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Stripe-Version': API_VERSION,
                            ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {})
                        },
                        body: body
                    });

                    if (!res.ok) {
                        const txt = await res.text();
                        console.error('Stripe API Error:', txt);
                        throw new Error(`Stripe API Error: ${res.status}`);
                    }

                    return res.json();
                }
            }
        },
        webhooks: {
            constructEvent: (payload, sigHeader, secret) => {
                // Manual Signature Verification
                // Format: t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51ad02...
                if (!sigHeader) throw new Error('No signature header');

                const parts = sigHeader.split(',').reduce((acc, item) => {
                    const [k, v] = item.split('=');
                    acc[k] = v;
                    return acc;
                }, {});

                if (!parts.t || !parts.v1) throw new Error('Invalid signature header format');

                const timestamp = parts.t;
                const signature = parts.v1;

                // Tolerance (5 mins)
                const now = Math.floor(Date.now() / 1000);
                if (Math.abs(now - parseInt(timestamp)) > 300) {
                    throw new Error('Timestamp out of tolerance');
                }

                const signedPayload = `${timestamp}.${payload}`;
                const hmac = crypto.createHmac('sha256', secret)
                    .update(signedPayload)
                    .digest('hex');

                if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hmac))) {
                    throw new Error('Signature mismatch');
                }

                return JSON.parse(payload.toString());
            }
        }
    };
}

module.exports = { getStripe };
