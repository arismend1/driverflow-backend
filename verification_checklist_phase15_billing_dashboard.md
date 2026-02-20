# Checklist de Pruebas - Fase 15: Client Billing Dashboard

### 1) Ejecutar migración en DBeaver
Abre DBeaver (conectado a PRD) y ejecuta este query idempotente:
```sql
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS receipt_url TEXT;
```

### 2) Query para confirmar columnas
Confirma que Postgres asimiló los campos correctamente:
```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'weekly_invoices' AND column_name IN ('stripe_charge_id', 'receipt_url');
```

### 3) Curl para `/api/billing/invoices/me`
Debes enviar una petición autenticada usando tu JWT real de rol `empresa`. Esto te traerá máximo 20 resultados por página.
```bash
curl -X GET "https://TU_URL_EN_RENDER/api/billing/invoices/me?limit=20&offset=0" \
     -H "Authorization: Bearer <TU_TOKEN_JWT>"
```
*(Si usas ThunderClient o Postman, simplemente haz GET a la ruta con el Bearer Token en Auth).*

### 4) Prueba negativa (Otra empresa)
Consigue el ID numérico de una factura que *sabes* que le pertenece a otro driver/company e intenta leerla.
```bash
curl -X GET "https://TU_URL_EN_RENDER/api/billing/invoices/ID_AJENO" \
     -H "Authorization: Bearer <TU_TOKEN_JWT>"
```
**Esperado:** Obtendrás un Http `404 Not Found`.

### 5) Confirmar receipt_url
Para no tener que volver a cobrarte en vivo ahora, busca una factura que *ya esté* en `status='charged'` y lánzale un cobro falso al endpoint manual Retry del Admin. Como usamos idempotencia y `confirm:true` no la doblará, pero Stripe regurgitará el PaymentIntent completo y de ahí extraerá el recibo.
O simplemente fíjate si las facturas del próximo lunes se llenan:
```sql
SELECT id, status, stripe_payment_intent_id, receipt_url 
FROM weekly_invoices 
WHERE status = 'charged' 
ORDER BY id DESC LIMIT 5;
```
