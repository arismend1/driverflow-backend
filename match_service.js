const db = require('./db');

// Helper to parse JSON safely
const parseJson = (str) => {
    try {
        return JSON.parse(str || '[]');
    } catch (e) {
        return [];
    }
};

// Helper: check if A is a subset of B (All elements of A must be in B)
// Company Reqs (A) must be satisfied by Driver Profile (B)
const isSubset = (requiredArr, driverArr) => {
    if (!requiredArr || requiredArr.length === 0) return true; // No requirements = Match
    if (!driverArr || driverArr.length === 0) return false; // Requirements exist but driver has none = No Match
    // Every item in Required must be included in Driver
    return requiredArr.every(r => driverArr.includes(r));
};

// Helper: check intersection (At least one must match)
// e.g. Payment Methods: Company offers [A, B], Driver accepts [B, C] -> Match on B.
const hasIntersection = (arr1, arr2) => {
    if (!arr1 || arr1.length === 0) return true; // No constraints?
    if (!arr2 || arr2.length === 0) return true;
    return arr1.some(i => arr2.includes(i));
};

exports.findMatchesForCompany = (companyId) => {
    // 1. Get Company Requirements
    const company = db.prepare('SELECT * FROM company_requirements WHERE company_id = ?').get(companyId);
    if (!company) return [];

    const reqLicense = parseJson(company.req_license_types);
    const reqEndorsements = parseJson(company.req_endorsements);
    const reqOps = parseJson(company.req_operation_types);
    const reqModalities = parseJson(company.req_modalities); // "1 viaje", "1 carga"
    const reqRels = parseJson(company.req_relationships); // "Company Driver", "Owner Operator"

    // 2. Get All Active Drivers (Optimize with SQL filtering later?)
    // For MVP, fetch all profiles and filter in JS to handle complex JSON logic easily.
    const drivers = db.prepare(`
        SELECT dp.*, d.nombre, d.created_at as driver_since
        FROM driver_profiles dp
        JOIN drivers d ON d.id = dp.driver_id
        WHERE d.status = 'active'
    `).all();

    const matches = [];

    for (const driver of drivers) {
        // Strict Checks

        // 1. CDL
        if (company.req_cdl && !driver.has_cdl) continue;

        // 2. Truck (If company requires truck, driver must have it)
        if (company.req_truck && !driver.has_truck) continue;

        // 3. License Types (Subset)
        const driverLicenses = parseJson(driver.license_types);
        console.log(`DEBUG [Driver ${driver.driver_id}] License Check: Req ${JSON.stringify(reqLicense)} vs Driver ${JSON.stringify(driverLicenses)}`);
        if (!isSubset(reqLicense, driverLicenses)) {
            console.log("  -> License Mismatch");
            continue;
        }

        // 4. Endorsements (Subset)
        const driverEndorsements = parseJson(driver.endorsements);
        console.log(`DEBUG [Driver ${driver.driver_id}] Endorsement Check: Req ${JSON.stringify(reqEndorsements)} vs Driver ${JSON.stringify(driverEndorsements)}`);
        if (!isSubset(reqEndorsements, driverEndorsements)) {
            console.log("  -> Endorsements Mismatch");
            continue;
        }

        // 5. Operation Types (Subset? Or Intersection? Prompt says "Company can mark multiple", "Driver can mark multiple".
        // Usually, if Company requires "OTR", Driver must do "OTR".
        // If Company does "Local" OR "Regional", Driver must do one of them.
        // Let's assume Intersection for "Types of Operation" (Company has Local jobs, Driver wants Local = Match).
        // Wait, Prompt says "REQUISITOS DEL CHOFER... Tipo de operación del trabajo".
        // If Company checks "Local" AND "Regional", does it mean the driver MUST do BOTH? Or that the job IS both?
        // Usually Job is one type. Company might be looking for drivers who can do X.
        // Let's stick to strict requirement: If Company selects "OTR", they want an OTR driver.
        // If they select "OTR" and "Regional", maybe they have both jobs?
        // Let's use Intersection for "What Company Offers" vs "What Driver Wants".
        const driverOps = parseJson(driver.operation_types);
        if (!hasIntersection(reqOps, driverOps)) continue;

        // 6. Experience (Simple Check for now: Req Range must match Driver Range or Driver Years >= Min)
        // User prompt: "Campo numérico opcional: Años mínimos requeridos" (Company)
        // Driver has "Experience Range" and "Years Exact".
        // We'll trust the unstructured range or use simple logic if implemented.
        // For now, let's assume loose string matching on Range if provided.

        // 7. Modality (Intersection)
        const driverPrefs = parseJson(driver.job_preferences); // "One Trip", "One Load", "Full Time"
        // Map Company "1 viaje" -> Driver "One Trip"
        // Ideally we standardise keys. 
        // Let's assume keys are standardised in Frontend or Backend.
        // We will perform intersection.
        // if (!hasIntersection(reqModalities, driverPrefs)) continue; // Enabled if keys match

        // 8. Payment Methods (Intersection)
        const driverPay = parseJson(driver.payment_methods);
        const compPay = parseJson(company.offered_payment_methods);
        if (!hasIntersection(compPay, driverPay)) continue;

        // 9. Relationship (Intersection)
        const driverRel = parseJson(driver.work_relationships);
        if (!hasIntersection(reqRels, driverRel)) continue;

        // Match Found!
        matches.push({
            driver_id: driver.driver_id,
            // Privacy: Do NOT return Name/Contact yet? 
            // "No se muestra información privada antes del MATCH + TICKET + PAGO."
            // "CandidatesScreen: List of matching drivers (Blind: 'Chofer A - Exp 5 años')"
            display_name: `Chofer #${driver.driver_id}`, // Obfuscated
            experience_years: driver.experience_years,
            experience_range: driver.experience_range,
            license_summ: driverLicenses.join('/'),
            match_score: 100 // Calculate based on overlap?
        });
    }

    return matches;
};

exports.findMatchesForDriver = (driverId) => {
    // Inverse Logic
    const driver = db.prepare('SELECT * FROM driver_profiles WHERE driver_id = ?').get(driverId);
    if (!driver) return [];

    const companies = db.prepare('SELECT * FROM company_requirements').all(); // Fetch all (optimize later)
    const matches = [];

    const driverLicenses = parseJson(driver.license_types);
    const driverEndorsements = parseJson(driver.endorsements);
    const driverOps = parseJson(driver.operation_types);
    const driverPay = parseJson(driver.payment_methods);
    const driverRel = parseJson(driver.work_relationships);

    for (const company of companies) {
        // Strict Checks (Company Req ⊆ Driver Profile)

        if (company.req_cdl && !driver.has_cdl) continue;
        if (company.req_truck && !driver.has_truck) continue;

        const reqLicense = parseJson(company.req_license_types);
        if (!isSubset(reqLicense, driverLicenses)) continue;

        const reqEndorsements = parseJson(company.req_endorsements);
        if (!isSubset(reqEndorsements, driverEndorsements)) continue;

        const reqOps = parseJson(company.req_operation_types);
        if (!hasIntersection(reqOps, driverOps)) continue; // Intersection

        const reqRels = parseJson(company.req_relationships);
        if (!hasIntersection(reqRels, driverRel)) continue;

        const compPay = parseJson(company.offered_payment_methods);
        if (!hasIntersection(compPay, driverPay)) continue;

        // Match!
        const companyInfo = db.prepare('SELECT id, legal_name, city FROM empresas WHERE id = ?').get(company.company_id);

        matches.push({
            company_id: company.company_id,
            // Privacy Obfuscation (Strict: No City/Name)
            display_name: `Empresa #${company.company_id}`,
            // UX Fields
            op_types: reqOps.join(', '),
            availability: company.availability || 'Inmediata',
            pay_methods: compPay.join(', '),
            match_score: 100
        });
    }

    return matches;
};
