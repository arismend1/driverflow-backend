const https = require('https');

const API_URL = "https://driverflow-backend.onrender.com";
const ADMIN_SECRET = process.argv[2];

if (!ADMIN_SECRET) {
    console.error("\n❌ Error: Falta el Admin Secret.");
    console.error("Uso: node scripts/verify_retry_endpoint.js <TU_ADMIN_SECRET>\n");
    process.exit(1);
}

// Helper simple para hacer requests sin dependencias externas
function request(method, path) {
    return new Promise((resolve, reject) => {
        const options = {
            method: method,
            headers: {
                'x-admin-secret': ADMIN_SECRET
            }
        };

        const req = https.request(`${API_URL}${path}`, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                resolve({ status: res.statusCode, body: data });
            });
        });

        req.on('error', (e) => reject(e));
        req.end();
    });
}

async function runTests() {
    console.log(`\n🔍 Iniciando pruebas de seguridad en: ${API_URL}\n`);

    // 1. Prueba: Reintentar factura inexistente (Debe fallar con 404)
    console.log("1️⃣  Prueba: Reintento de factura inexistente (ID: 999999)...");
    try {
        const res = await request('POST', '/admin/invoices/999999/retry');

        if (res.status === 404) {
            console.log("✅ ÉXITO: Recibido 404 Not Found (Correcto).");
        } else if (res.status === 401 || res.status === 403) {
            console.log("❌ FALLO: Error de autenticación. Verifica tu Admin Secret.");
            console.log(`   Status: ${res.status}`);
            process.exit(1);
        } else {
            console.log(`⚠️  INESPERADO: Recibido status ${res.status}`);
            console.log(`   Respuesta: ${res.body}`);
        }
    } catch (e) {
        console.error("❌ Error de red:", e.message);
    }

    console.log("\n---------------------------------------------------\n");
    console.log("🏁 Pruebas finalizadas.");
}

runTests();
