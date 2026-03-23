const { getStripe } = require('./stripe_client.js');

async function test() {
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
    const client = getStripe();
    
    // Simulate what checkout created
    const params = {
        payment_method_types: ['card'],
        customer: undefined,
        line_items: [{
            price_data: {
                currency: 'usd',
                product_data: { name: 'Weekly Invoice (2026-03-09)' },
                unit_amount: 15000
            },
            quantity: 1
        }],
        mode: 'payment',
        success_url: 'http://localhost/success',
        cancel_url: 'http://localhost/cancel'
    };

    // We can't actually hit stripe with mock key, but we want to see if `customer=undefined` is in the payload.
    // Let's monkeypatch fetch
    global.fetch = async (url, options) => {
        console.log("PAYLOAD SENT TO STRIPE:");
        console.log(decodeURIComponent(options.body));
        if (options.body.includes('undefined')) {
            console.error("FAIL: Payload still contains 'undefined'!");
        } else {
            console.log("PASS: Payload looks clean.");
        }
        return { ok: true, json: () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_123' }) };
    };

    try {
        const res = await client.checkout.sessions.create(params);
        console.log("Returned URL:", res.url);
    } catch(e) {
        console.error(e);
    }
}
test();
