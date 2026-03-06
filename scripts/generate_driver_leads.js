/**
 * scripts/generate_driver_leads.js — Seed 1000+ realistic CDL driver leads
 *
 * Usage: node scripts/generate_driver_leads.js [count] [company_id]
 *   count      — number of leads to generate (default: 1000)
 *   company_id — target company (default: 1)
 */

const db = require('../db_adapter');

const FIRST_NAMES = [
    'Carlos', 'John', 'Robert', 'Luis', 'James', 'Miguel', 'David', 'Jose',
    'Michael', 'Daniel', 'William', 'Richard', 'Jesus', 'Antonio', 'Francisco',
    'Thomas', 'Christopher', 'Jorge', 'Juan', 'Pedro', 'Mark', 'Steven',
    'Kevin', 'Brian', 'Eddie', 'Oscar', 'Victor', 'Mario', 'Rafael', 'Manuel',
    'Tony', 'Angel', 'Raymond', 'Alejandro', 'Fernando', 'Roberto', 'Alberto',
    'Hector', 'Sergio', 'Ruben', 'Enrique', 'Alfredo', 'Pablo', 'Ramon',
    'Armando', 'Jaime', 'Salvador', 'Ernesto', 'Arturo', 'Gustavo',
    'Andrew', 'Patrick', 'Travis', 'Derek', 'Brandon', 'Tyler', 'Jason',
    'Aaron', 'Sean', 'Nathan', 'Cody', 'Derrick', 'Marcus', 'Terrance',
    'Darnell', 'Lamar', 'DeShawn', 'Tyrone', 'Jerome', 'Curtis', 'Clarence',
    'Wayne', 'Roy', 'Dale', 'Glenn', 'Billy', 'Larry', 'Terry', 'Randy',
    'Dennis', 'Gary', 'Donald', 'Jerry', 'Scott', 'Timothy', 'Greg', 'Keith',
    'Henry', 'Frank', 'George', 'Kenneth', 'Eugene', 'Bobby', 'Russell', 'Carl',
    'Clint', 'Dustin', 'Brett', 'Chad', 'Jake', 'Luke', 'Riley', 'Wyatt',
];

const LAST_NAMES = [
    'Martinez', 'Johnson', 'Gonzalez', 'Smith', 'Rodriguez', 'Garcia', 'Lopez',
    'Hernandez', 'Davis', 'Wilson', 'Brown', 'Jones', 'Williams', 'Miller',
    'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Moore',
    'Clark', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright',
    'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams', 'Nelson',
    'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts',
    'Ramirez', 'Sanchez', 'Morales', 'Cruz', 'Reyes', 'Ortiz', 'Gutierrez',
    'Chavez', 'Ramos', 'Vargas', 'Vasquez', 'Castillo', 'Jimenez', 'Diaz',
    'Mendoza', 'Ruiz', 'Alvarez', 'Romero', 'Medina', 'Aguilar', 'Pena',
    'Cooper', 'Reed', 'Bailey', 'Bell', 'Murphy', 'Sullivan', 'Peterson',
    'Howard', 'Cox', 'Ward', 'Brooks', 'Russell', 'Griffin', 'Price', 'Bennett',
    'Wood', 'Barnes', 'Ross', 'Henderson', 'Coleman', 'Jenkins', 'Perry',
    'Powell', 'Long', 'Patterson', 'Hughes', 'Washington', 'Butler', 'Simmons',
    'Foster', 'Bryant', 'Alexander', 'Sanders', 'Dixon', 'Hamilton', 'Graham',
];

const STATES = [
    'Texas', 'California', 'Florida', 'Illinois', 'Ohio', 'Georgia', 'Pennsylvania',
    'Indiana', 'Tennessee', 'Missouri', 'North Carolina', 'Michigan', 'Arizona',
    'Wisconsin', 'New Jersey', 'Virginia', 'Washington', 'Colorado', 'Minnesota',
    'Oklahoma', 'Kentucky', 'Louisiana', 'Alabama', 'Oregon', 'Arkansas', 'Nevada',
    'Kansas', 'Mississippi', 'Iowa', 'Utah', 'Nebraska', 'New Mexico', 'Idaho',
    'Montana', 'South Dakota', 'Wyoming',
];

const LICENSE_TYPES = ['CDL Class A', 'CDL Class B', 'CDL Class A'];  // weighted toward Class A
const OP_TYPES = ['OTR', 'Regional', 'Local', 'Dedicated', 'OTR', 'OTR']; // weighted OTR
const TRUCK_TYPES = ['Dry Van', 'Reefer', 'Flatbed', 'Tanker', 'Hazmat', 'Car Hauler', 'Intermodal', 'LTL', 'Oversized'];
const EXTRAS = [
    'Owner operator', 'Company driver', 'Team driver available', 'Solo driver',
    'Clean MVR', 'No accidents', 'TWIC card', 'Passport ready', 'Bilingual EN/ES',
    'Willing to relocate', 'Available immediately', 'Night shift OK',
    'Doubles/Triples endorsed', 'Hazmat endorsed', 'Tanker endorsed',
];

const AREA_CODES = [
    '832', '713', '281', '346', '214', '972', '469', '817', '682', '254',
    '210', '512', '361', '956', '915', '806', '903', '430', '325', '940',
    '310', '323', '213', '818', '626', '562', '714', '949', '951', '909',
    '305', '786', '954', '561', '407', '321', '813', '727', '941', '239',
    '312', '773', '630', '708', '847', '815', '309', '217', '618', '618',
    '614', '216', '513', '419', '330', '740', '937', '567', '380', '234',
    '404', '678', '770', '470', '706', '762', '229', '912', '478', '478',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateLead(usedEmails) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const name = `${first} ${last}`;

    // Unique email
    let email;
    let attempts = 0;
    do {
        const suffix = attempts > 0 ? randInt(10, 9999) : '';
        email = `${first.toLowerCase()}.${last.toLowerCase()}${suffix}@gmail.com`;
        attempts++;
    } while (usedEmails.has(email) && attempts < 50);
    usedEmails.add(email);

    // Phone
    const area = pick(AREA_CODES);
    const phone = `${area}${randInt(200, 999)}${String(randInt(1000, 9999))}`;

    // Notes
    const license = pick(LICENSE_TYPES);
    const state = pick(STATES);
    const years = randInt(1, 25);
    const op = pick(OP_TYPES);
    const truck = pick(TRUCK_TYPES);
    const extra = Math.random() > 0.5 ? ` ${pick(EXTRAS)}` : '';
    const notes = `${license} ${state} ${years}yr ${op} ${truck}${extra}`;

    return { name, email, phone, notes };
}

(async () => {
    const COUNT = parseInt(process.argv[2]) || 1000;
    const COMPANY_ID = parseInt(process.argv[3]) || 1;
    const BATCH_SIZE = 100;

    console.log(`[LeadSeeder] Generating ${COUNT} leads for company_id=${COMPANY_ID}...`);

    const usedEmails = new Set();
    const leads = [];
    for (let i = 0; i < COUNT; i++) {
        leads.push(generateLead(usedEmails));
    }

    console.log(`[LeadSeeder] ${leads.length} leads generated. Inserting in batches of ${BATCH_SIZE}...`);

    let inserted = 0, skipped = 0;

    for (let b = 0; b < leads.length; b += BATCH_SIZE) {
        const batch = leads.slice(b, b + BATCH_SIZE);
        const batchNum = Math.floor(b / BATCH_SIZE) + 1;
        console.log(`[LeadSeeder] inserting batch ${batchNum} (${batch.length} rows)`);

        for (const lead of batch) {
            try {
                await db.run(
                    `INSERT INTO driver_leads (company_id, name, phone, email, notes, status)
                     VALUES (?, ?, ?, ?, ?, 'NEW') ON CONFLICT DO NOTHING`,
                    COMPANY_ID, lead.name, lead.phone, lead.email, lead.notes
                );
                inserted++;
            } catch (e) {
                if (e.code === '23505' || (e.message && e.message.includes('duplicate'))) {
                    skipped++;
                } else {
                    skipped++;
                    console.error('[LeadSeeder] Row error:', e.message);
                }
            }
        }
    }

    console.log(`[LeadSeeder] done inserted=${inserted} skipped=${skipped} total=${leads.length}`);
    process.exit(0);
})();
