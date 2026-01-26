# Auditoría de Riesgos - DriverFlow v1.2-prod

## 1. Riesgos Legales y Regulatorios

| Riesgo | Descripción | Impacto | Nivel |
|---|---|---|---|
| **Clasificación Laboral** | Riesgo de que los Drivers sean considerados empleados en lugar de contratistas independientes debido al control ejercido (asignación, tiempos). | Demandas laborales, multas masivas, pago de seguridad social retroactivo. | **ALTO** |
| **Responsabilidad Civil (Vicarious Liability)** | Responsabilidad solidaria de la plataforma ante accidentes de tránsito, daños a terceros o pérdida de carga mientras el driver está "En Servicio". | Costos legales, indemnizaciones, daño reputacional irreversible. | **ALTO** |
| **Cumplimiento Regulatorio (Licencias)** | Uso de la plataforma por drivers sin licencias válidas (A/B/C) o vehículos no habilitados para carga/transporte comercial. | Multas regulatorias, bloqueo de la operación por autoridades de transporte. | **MEDIO** |
| **Protección de Datos (Privacidad)** | Almacenamiento de PII (nombres, contactos, ubicaciones, patentes) sin encriptación en reposo (SQLite estándar) ni políticas de retención. | Sanciones por violación de leyes de privacidad (GDPR/Local), robo de identidad. | **MEDIO** |

## 2. Riesgos Operativos

| Riesgo | Descripción | Impacto | Nivel |
|---|---|---|---|
| **Efecto "Starvation" (Prioridad)** | La priorización agresiva a empresas `GOLD` (Ronda 2 directa) puede dejar a empresas `STANDARD` sin drivers en momentos de alta demanda, causando churn masivo de clientes base. | Pérdida de liquidez del mercado, abandono de usuarios no-premium. | **ALTO** |
| **Punto Único de Fallo (SPOF)** | Arquitectura monolítica con SQLite y un solo proceso Node.js. Si el proceso falla o se corrompe la DB (ej: disco lleno), toda la operación nacional se detiene. | Parada total del servicio, pérdida de ingresos, pérdida de confianza. | **ALTO** |
| **Escalabilidad del Gating** | El mecanismo de `advance_rounds` atado a `GET /list` funciona mecánicamente, pero con 10,000 drivers consultando simultáneamente, bloqueará el Event Loop de Node.js. | Degradación severa del performance, timeouts, imposibilidad de aceptar solicitudes. | **MEDIO** |
| **Fraude de Identidad (KYC)** | Ausencia de validación documental real (KYC). Cualquiera puede registrarse como "Driver" o "Empresa" con datos falsos. | Robos de mercancía, conductores peligrosos, estafas a empresas. | **ALTO** |

## 3. Riesgos de Uso Indebido (Gameability)

| Riesgo | Descripción | Impacto | Nivel |
|---|---|---|---|
| **Colusión (Platform Bypass)** | Drivers y Empresas utilizan la plataforma solo para el primer contacto y luego operan por fuera ("Off-platforming") para evitar control/tarifas futuras. | Pérdida de valor de la plataforma, irrelevancia del sistema a largo plazo. | **ALTO** |
| **Aceptación Fantasma** | Drivers que aceptan solicitudes para bloquear a la competencia sin intención de realizar el viaje (aunque se penalicen, el daño inmediato está hecho). | Bloqueo operativo de empresas, aumento de tiempos de espera reales. | **MEDIO** |
