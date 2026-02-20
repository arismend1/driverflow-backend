# Checklist de Verificación - Fase 15 (Client Billing Dashboard)

### A) Ejecutar migración en DBeaver
Copia y pega este script SQL idempotente:
```sql
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS receipt_url TEXT;
```

### B) Query para confirmar columnas
Revisa que ambas existan:
```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'weekly_invoices' AND column_name IN ('stripe_charge_id', 'receipt_url');
```

### C) Curl para `/api/billing/invoices/me`
Pide tus propias facturas. (Usa tu Bearer Token real de empresa)
```bash
curl -X GET "https://TU_RENDER_URL/api/billing/invoices/me?limit=20&offset=0" \
     -H "Authorization: Bearer <TU_TOKEN_JWT>"
```

### D) Prueba negativa (Invoice ajeno)
Intenta acceder al ID numérico de una factura que pertenece a un tercero:
```bash
curl -i -X GET "https://TU_RENDER_URL/api/billing/invoices/ID_AJENO" \
     -H "Authorization: Bearer <TU_TOKEN_JWT>"
```
**Esperado:** Http `404 Not Found`.

### E) Confirmar `receipt_url`
Ejecuta el query para ver la URL del recibo (Stripe):
```sql
SELECT id, status, receipt_url, stripe_charge_id 
FROM weekly_invoices 
WHERE status = 'charged' 
ORDER BY id DESC LIMIT 1;
```
*(Si no tienes facturas pagadas aún, mueve una pendiente temporalmente a `status='failed'` en DB, y ejecuta el Endpoint de `Retry` del Admin para que Stripe genere el Charge de nuevo bajo la misma Idempotency Key).*
