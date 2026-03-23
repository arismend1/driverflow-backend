const jwt = require('jsonwebtoken');

async function testCheckout() {
    const JWT_SECRET = process.env.JWT_SECRET || 'mi_secreto_super_seguro_123';
    
    // Create token for company_id 6
    const token = jwt.sign({ id: 6, email: 'info@luxuryservices.com', type: 'empresa' }, JWT_SECRET, { expiresIn: '1h' });

    try {
        const res = await fetch('https://driverflow-backend.onrender.com/api/billing/invoices/2/checkout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        const data = await res.json();
        console.log("Status:", res.status);
        console.log("Response:", data);
    } catch(e) {
        console.error(e);
    }
}
testCheckout();
