const db = require('./db_adapter');

async function test() {
    console.log('--- STARTING DIRECT TEST ---');
    try {
        const driverId = 1; // From our previous check

        // 1. Test GET Profile
        console.log('1. Testing GET Profile for ID 1...');
        const driver = await db.get("SELECT * FROM drivers WHERE id = ?", driverId);
        if (!driver) {
            console.error('Driver 1 not found');
            return;
        }
        console.log('Driver found:', driver.nombre, '| has_cdl:', driver.has_cdl);

        // 2. Test UPDATE Profile
        console.log('2. Testing UPDATE Profile...');
        const payload = {
            has_cdl: true,
            license_types: ['A', 'B'],
            endorsements: ['Tanker'],
            operation_types: ['OTR'],
            experience_years: 5,
            experience_range: '2–5 años',
            job_preferences: ['Full-time'],
            has_truck: true,
            payment_methods: ['Zelle'],
            work_relationships: ['1099']
        };

        const sql = `UPDATE drivers SET 
            has_cdl = ?, license_types = ?, endorsements = ?, operation_types = ?,
            experience_years = ?, experience_range = ?, job_preferences = ?,
            has_truck = ?, payment_methods = ?, work_relationships = ?,
            updated_at = ?
            WHERE id = ?`;

        const params = [
            +!!payload.has_cdl,
            JSON.stringify(payload.license_types),
            JSON.stringify(payload.endorsements),
            JSON.stringify(payload.operation_types),
            payload.experience_years,
            payload.experience_range,
            JSON.stringify(payload.job_preferences),
            +!!payload.has_truck,
            JSON.stringify(payload.payment_methods),
            JSON.stringify(payload.work_relationships),
            new Date().toISOString(),
            driverId
        ];

        await db.run(sql, ...params);
        console.log('Update successful.');

        // 3. Verify Update
        console.log('3. Verifying update...');
        const updated = await db.get("SELECT * FROM drivers WHERE id = ?", driverId);
        console.log('Updated has_cdl:', updated.has_cdl);
        console.log('Updated license_types:', updated.license_types);

        // 4. Test Tickets
        console.log('4. Testing Get Tickets...');
        const tickets = await db.all("SELECT * FROM tickets WHERE driver_id = ? LIMIT 5", driverId);
        console.log('Tickets found:', tickets.length);
        if (tickets.length > 0) {
            console.log('First ticket:', tickets[0]);
        }

    } catch (e) {
        console.error('Test failed:', e);
    }
}

test().then(() => {
    console.log('--- TEST FINISHED ---');
    process.exit(0);
});
