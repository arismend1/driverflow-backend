# Checklist de Verificación - Fase 14: Dunning y Reintentos Automáticos

Este checklist te guiará para desplegar manualmente y validar la robustez de los cobros en producción sin riesgo de romper el sistema live.

### [ ] 1. Migración SQL Manual 
Ejecutar el siguiente bloque en la plataforma destino (Render DB o DBeaver conectada a Producción).
```sql
-- 1. Añade columnas de control a weekly_invoices
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS last_error_message TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0;

-- 2. Crear tabla de auditoría
CREATE TABLE IF NOT EXISTS invoice_attempts (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES weekly_invoices(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    stripe_payment_intent_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Crear índices de rendimiento
CREATE INDEX IF NOT EXISTS idx_invoices_next_retry ON weekly_invoices(next_retry_at) WHERE status IN ('failed', 'retrying');
CREATE INDEX IF NOT EXISTS idx_invoice_attempts_inv_id ON invoice_attempts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_suspended ON weekly_invoices(suspended_at) WHERE suspended_at IS NOT NULL;
```

### [ ] 2. Despliegue de Archivos (Deploy)
Archivos afectados/creados que debes subir al repositorio (`git push`):
- `scripts/manual_migration_phase14_dunning.sql` (Nuevo)
- `src/notifications.js` (Nuevo stub)
- `worker_queue.js` (Modificado)
- `server.js` (Modificado)

### [ ] 3. Pruebas Funcionales en DBeaver (Simulación de Morosidad)
Sigue exactamente estos pasos para probar que todo es seguro.

#### A) Inserción del Escenario Base
```sql
-- Inserta factura de prueba ($10)
INSERT INTO weekly_invoices (company_id, week_start, week_end, total_requests, active_drivers, amount_cents, status, created_at) 
VALUES (TU_EMPRESA_AQUI, CURRENT_DATE, CURRENT_DATE, 1, 1, 1000, 'pending', NOW()) RETURNING id;
```

#### B) Forzar el Fallo en Stripe
Para que falle, debes ir a Stripe y *borrar la tarjeta de pago* adosada al `customer` de esa empresa temporalmente, o usar el ID de una empresa de pruebas que **no tenga** tarjeta en Stripe. 
O simplemente ejecuta:
`curl -X POST https://TU_URL/admin/invoices/NUEVO_ID/retry -H "x-admin-secret: TU_ADMIN"`

#### C) Validar la Auditoría y el Backoff (Reintento programado)
Ejecuta esto en DBeaver después de que falle:
```sql
SELECT status, attempt_count, next_retry_at, last_error_message FROM weekly_invoices WHERE id = NUEVO_ID;
-- Esperado: status = 'failed' o 'retrying', attempt_count = 1, next_retry_at = hoy + 24 horas.

SELECT * FROM invoice_attempts WHERE invoice_id = NUEVO_ID;
-- Esperado: Ver una fila con un error ("No such payment method", etc).
```

#### D) Validar Suspensión Automática (MAX_ATTEMPTS = 3)
Acelera el reloj base para engañar al sistema dos veces seguidas:
```sql
-- Mueve su reintento al pasado
UPDATE weekly_invoices SET attempt_count = 2, next_retry_at = NOW() - INTERVAL '1 hour' WHERE id = NUEVO_ID;
```
Vuelve a disparar el curl del retry o espera al Dunning Scheduler cada hora.
```sql
SELECT status, suspended_at FROM weekly_invoices WHERE id = NUEVO_ID;
-- Esperado: status = 'suspended', suspended_at no está vacío.
```

#### E) Confirmar Logs de Email Stubs
Ve a la consola de Render y confirma la presencia de estas líneas de texto:
- `[NOTIFY] PAYMENT FAILED (Attempt 1/3)`
- `[NOTIFY] ACCOUNT SUSPENDED: Invoice #... max retries reached.`
