const { getStripe } = require('./stripe_client.js');

async function checkEvents() {
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock'; // Will replace below
    // No easy way to get actual render key unless I print it from Node, but the webhook is incoming.
}
