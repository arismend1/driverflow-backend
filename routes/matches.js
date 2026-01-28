const express = require('express');
const router = express.Router();
const MatchService = require('../match_service');

// GET /matches/candidates (For Company)
router.get('/candidates', (req, res) => {
    const companyId = req.user ? req.user.id : null;
    if (!companyId) return res.status(401).json({ error: 'Unauthorized' });

    // Assuming role check is handled by middleware but good to be safe
    if (req.user.type !== 'empresa') return res.status(403).json({ error: 'Forbidden' });

    const matches = MatchService.findMatchesForCompany(companyId);
    res.json(matches);
});

// GET /matches/opportunities (For Driver)
router.get('/opportunities', (req, res) => {
    const driverId = req.user ? req.user.id : null;
    if (!driverId) return res.status(401).json({ error: 'Unauthorized' });

    if (req.user.type !== 'driver') return res.status(403).json({ error: 'Forbidden' });

    const matches = MatchService.findMatchesForDriver(driverId);
    res.json(matches);
});

module.exports = router;
