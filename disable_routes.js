const fs = require('fs');

const content = fs.readFileSync('server.js', 'utf8');

const patterns = [
    "const driverProfileRoutes = require('./routes/driver_profile');",
    "const companyReqRoutes = require('./routes/company_requirements');",
    "const matchRoutes = require('./routes/matches');",
    "app.use('/drivers/profile', authenticateToken, driverProfileRoutes);",
    "app.use('/companies/requirements', authenticateToken, companyReqRoutes);",
    "app.use('/matches', authenticateToken, matchRoutes);"
];

let newContent = content;
for (const p of patterns) {
    newContent = newContent.replace(p, "// " + p);
}

if (newContent !== content) {
    fs.writeFileSync('server.js', newContent);
    console.log("Disabled Phase 7 routes in server.js");
} else {
    console.error("Could not find routes to disable.");
}
