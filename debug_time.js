const db = require('./database');
const req = db.prepare('SELECT fecha_inicio_ronda FROM solicitudes WHERE id = 1').get();
console.log('DB Value:', req.fecha_inicio_ronda);
const now = new Date();
console.log('JS Now:', now.toISOString());
const dbDate = new Date(req.fecha_inicio_ronda);
console.log('Parsed DB Date:', dbDate.toISOString());
console.log('Diff seconds:', (now - dbDate) / 1000);
