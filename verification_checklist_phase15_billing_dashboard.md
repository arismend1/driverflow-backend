# Checklist de Verificación - Fase 15: Client Billing Dashboard

### [ ] 1. Migración SQL Manual 
Ejecutar el siguiente script idempotente en Base de Datos (Render DBeaver):
```sql
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS receipt_url TEXT;
```

### [ ] 2. Despliegue de Código (Deploy)
Asegurar que estos cambios estén en producción:
- `scripts/manual_migration_phase15_receipts.sql` (agregado).
- `worker_queue.js` modificado para guardar `receipt_url` al pagar exitosamente.
- `server.js` modificado añadiendo el API `GET /api/billing/invoices/me` autenticado con JWT de rol empresa.

### [ ] 3. Validación de Endpoints y Requerimientos 
Abre un cliente REST (ThunderClient, Hoppscotch, Postman) o haz la prueba vía cURL si tienes la Consola. Genera un Token Bearer de inicio de sesión de una empresa de pruebas (vía la App o tu API `/login`).

#### A) Obtener Facturas Propias
```bash
curl -X GET https://driverflow-backend.onrender.com/api/billing/invoices/me \
     -H "Authorization: Bearer <TU_JWT_AQUI>"
```
- **Esperado:** Lista JSON `[ {...} ]` con facturas ordenadas por `week_start DESC`. Si no tiene, debe regresar `[]` con Status 200. Comprobar que solo salen las que te pertenecen a ti.

#### B) Factura Detallada (Incluye breakdowns)
Copia el `<ID>` de una factura del JSON anterior.
```bash
curl -X GET https://driverflow-backend.onrender.com/api/billing/invoices/<ID> \
     -H "Authorization: Bearer <TU_JWT_AQUI>"
```
- **Esperado:** Devuelve exactamente el objeto JSON de la factura.

#### C) Prueba de Privacidad Negativa
Intenta acceder al mismo `/api/billing/invoices/<ID>` pero usando el `<ID>` de una factura que pertenece a una **empresa distinta**.
- **Esperado:** Http 404 `{ "error": "Not Found" }` (No expone que la factura existe).

### [ ] 4. Comprobación Generación `receipt_url`
Cuando sea lunes y corra el worker de Stripe, revisar la columna en base de datos de una factura que fue puesta en "status = 'charged'".
```sql
SELECT status, receipt_url, stripe_charge_id FROM weekly_invoices WHERE id = <ID_FACTURA_COBRADA_HOY>;
```
- **Esperado:** `receipt_url` NO debe ser Null. Debe contener `https://pay.stripe.com/receipts/...`
