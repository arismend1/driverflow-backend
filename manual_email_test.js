try { require('dotenv').config(); } catch (e) { console.log('Note: dotenv not found, relying on system env vars.'); }

const API_KEY = process.env.SENDGRID_API_KEY || "TU_API_KEY_AQUI";
const FROM_EMAIL = process.env.FROM_EMAIL || "no-reply@driverflow.app";
const TO_EMAIL = "test@example.com"; // Se pedira al usuario cambiar esto o lo pasamos por arg

async function testSend() {
    console.log("--- Prueba Manual de SendGrid ---");
    console.log(`API KEY: ${API_KEY.substring(0, 5)}...`);
    console.log(`FROM:    ${FROM_EMAIL}`);

    if (API_KEY === "TU_API_KEY_AQUI") {
        console.error("❌ ERROR: No se encontró SENDGRID_API_KEY en variables de entorno.");
        console.log("   --> Ejecuta: set SENDGRID_API_KEY=SG.tullave... && node manual_email_test.js");
        return;
    }

    const payload = {
        personalizations: [{ to: [{ email: process.argv[2] || TO_EMAIL }] }],
        from: { email: FROM_EMAIL, name: "DriverFlow Test" },
        subject: "Prueba de Diagnostico DriverFlow",
        content: [{ type: "text/plain", value: "Si lees esto, SendGrid funciona correctamente." }]
    };

    try {
        console.log(`Intentando enviar a: ${payload.personalizations[0].to[0].email}...`);

        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const txt = await res.text();
            console.error("\n❌ FALLO EL ENVIO (Error de SendGrid):");
            console.error("------------------------------------------------");
            console.error(`Status: ${res.status}`);
            console.error(`Detalle: ${txt}`);
            console.error("------------------------------------------------");
            console.log("\nPosibles causas:");
            console.log("1. La API Key es inválida.");
            console.log("2. El remitente (FROM_EMAIL) no está verificado en SendGrid.");
            console.log("3. Tu cuenta de SendGrid está suspendida o en revisión.");
        } else {
            console.log("\n✅ ENVIO EXITOSO (Status 202)");
            console.log("El correo salió de nuestro sistema hacia SendGrid.");
            console.log("Si no llega a la bandeja, revisa SPAM o los logs de SendGrid.");
        }

    } catch (error) {
        console.error("❌ Error de Red / Código:", error.message);
    }
}

testSend();
