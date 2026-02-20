const https = require('https');

const API_URL = "https://driverflow-backend.onrender.com";
const ADMIN_SECRET = process.argv[2];

if (!ADMIN_SECRET) {
    console.error("\n❌ Error: Falta el Admin Secret.");
    console.error("Uso: node scripts/verify_invoices.js <TU_ADMIN_SECRET>\n");
    process.exit(1);
}

function request(method, path) {
    return new Promise((resolve, reject) => {
        const options = {
            method: method,
            headers: { 'x-admin-secret': ADMIN_SECRET }
        };
        const req = https.request(`${API_URL}${path}`, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, body: json });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.end();
    });
}

async function runCheck() {
    console.log(`\n🔍 Verificando Facturas y Esquema de Base de Datos en: ${API_URL}\n`);

    try {
        const res = await request('GET', '/admin/invoices');

        if (res.status !== 200) {
            console.error(`❌ Error al obtener facturas. Status: ${res.status}`);
            console.error("Body:", res.body);
            process.exit(1);
        }

        const invoices = res.body;

        if (!Array.isArray(invoices)) {
            console.error("❌ Respuesta inesperada (no es un array):", invoices);
            process.exit(1);
        }

        if (invoices.length === 0) {
            console.log("⚠️  No hay facturas encontradas. No se puede verificar el esquema completo (nuevas columnas) sin datos.");
            console.log("   -> Sugerencia: Genera facturas usando el endpoint /create (o espera al cron).");
            return;
        }

        // Check Schema via first invoice
        const sample = invoices[0];
        const hasAttemptCount = 'attempt_count' in sample;
        const hasFailureReason = 'failure_reason' in sample;

        console.log("📊 Verificación de Esquema (DB Migration):");
        if (hasAttemptCount && hasFailureReason) {
            console.log("✅ PASS: Las columnas nuevas ('attempt_count', 'failure_reason') fueron detectadas.");
        } else {
            console.log("❌ FAIL: Faltan columnas en la respuesta.");
            console.log("   ¿Ejecutaste 'scripts/manual_migration_phase13_hardening.sql' en producción?");
            console.log("   Columnas detectadas:", Object.keys(sample));
            process.exit(1);
        }

        console.log("\n📋 Últimas 5 Facturas:");
        console.log("---------------------------------------------------------------");
        console.log("ID      | Empresa           | Semana       | Status    | Intentos");
        console.log("---------------------------------------------------------------");

        invoices.slice(0, 5).forEach(inv => {
            const id = String(inv.id).padEnd(7);
            const comp = String(inv.company_name || 'N/A').substring(0, 15).padEnd(17);
            const week = String(inv.week_start).padEnd(12);
            const status = String(inv.status).padEnd(9);
            const att = String(inv.attempt_count ?? 0).padEnd(8);
            console.log(`${id} | ${comp} | ${week} | ${status} | ${att}`);
        });
        console.log("---------------------------------------------------------------\n");

    } catch (e) {
        console.error("❌ Error de red:", e.message);
    }
}

runCheck();
