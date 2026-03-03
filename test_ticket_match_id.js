const db = require('./db_adapter');

(async () => {
    console.log('--- TEST: Ticket Match ID Verification ---');

    // Use a real match that exists in the DB
    const testMatchId = 907; // A NEW match for driver 12
    const now = new Date().toISOString();

    try {
        // Get match details
        const match = await db.get('SELECT * FROM potential_matches WHERE id = ?', testMatchId);
        if (!match) {
            console.log('❌ Match not found. Pick a valid match_id.');
            process.exit(1);
        }
        console.log(`Using match ${testMatchId}: driver=${match.driver_id}, company=${match.company_id}`);

        // 1st attempt: Insert ticket WITH match_id
        const existingTicket1 = await db.get('SELECT id FROM tickets WHERE match_id = ? LIMIT 1', testMatchId);
        let ticketId;

        if (!existingTicket1) {
            const t = await db.run(
                "INSERT INTO tickets (match_id, company_id, driver_id, price_cents, amount_cents, currency, created_at, billing_status, billing_notes) VALUES (?,?,?,?,?,?,?,'pending',?)",
                testMatchId, match.company_id, match.driver_id, 15000, 15000, 'USD', now, `Test Match ID: ${testMatchId}`
            );
            ticketId = t.lastInsertRowid || (t.rows && t.rows[0] ? t.rows[0].id : null);
            console.log(`✅ 1st call: Ticket created with id=${ticketId}`);
        } else {
            ticketId = existingTicket1.id;
            console.log(`✅ 1st call: Ticket already exists with id=${ticketId}`);
        }

        // 2nd attempt: Pre-check should find existing
        const existingTicket2 = await db.get('SELECT id FROM tickets WHERE match_id = ? LIMIT 1', testMatchId);
        if (existingTicket2) {
            console.log(`✅ 2nd call: Pre-check found existing ticket id=${existingTicket2.id}. No duplicate.`);
        } else {
            console.log('❌ 2nd call: Pre-check failed!');
        }

        // Verify: Exactly 1 ticket
        const tickets = await db.all('SELECT id, match_id, company_id, driver_id, amount_cents FROM tickets WHERE match_id = ?', testMatchId);
        console.log(`\n--- VERIFICATION ---`);
        console.log(`Tickets for match_id=${testMatchId}: ${tickets.length}`);
        console.log(JSON.stringify(tickets, null, 2));
        console.log(tickets.length === 1 ? '✅ PASS: Exactly 1 ticket.' : `❌ FAIL: Got ${tickets.length}`);
        console.log(tickets[0]?.match_id == testMatchId ? '✅ PASS: match_id is set.' : '❌ FAIL: match_id wrong.');

        // DB constraint test
        console.log('\n--- DB Constraint Test ---');
        try {
            await db.run(
                "INSERT INTO tickets (match_id, company_id, driver_id, price_cents, amount_cents, currency, created_at, billing_status) VALUES (?,?,?,?,?,?,?,'pending')",
                testMatchId, match.company_id, match.driver_id, 15000, 15000, 'USD', now
            );
            console.log('❌ FAIL: DB allowed duplicate!');
        } catch (e) {
            if (e.message.includes('UNIQUE') || e.message.includes('unique') || e.message.includes('duplicate')) {
                console.log('✅ PASS: DB blocked duplicate (UNIQUE constraint).');
            } else {
                console.log('❌ Unexpected error:', e.message);
            }
        }

        // Cleanup
        await db.run('DELETE FROM tickets WHERE match_id = ?', testMatchId);
        console.log('\n🧹 Cleanup done.');

    } catch (e) {
        console.error('❌ Test error:', e);
    }
    process.exit(0);
})();
