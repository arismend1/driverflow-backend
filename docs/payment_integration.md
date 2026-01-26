# Payment Webhook Integration

DriverFlow now supports an automated Payment -> Unblock flow via Webhooks.

## Endpoint
`POST /webhooks/payment`

## Security
Requires a Shared Secret to be sent in the headers.
*   **Env Var**: `WEBHOOK_SECRET` (defaults to `simulated_webhook_secret` in dev).
*   **Header**: `x-webhook-secret`

## Payload Format (JSON)
Compatible with Stripe-like event structures (simplified).

```json
{
  "type": "invoice.paid",
  "data": {
    "invoice_id": 123,
    "amount_paid_cents": 15000,
    "external_ref": "ch_3Lz..."
  }
}
```

## Behavior
1.  **Validates** the Invoice ID.
2.  **Updates Invoice**: Sets status to `paid`, records `paid_at` and `paid_method='webhook'`.
3.  **Logs Event**: Emits `invoice_paid` event to `events_outbox`.
4.  **Auto-Unblock**: Immediately runs `enforceCompanyCanOperate`. If the payment clears the blocking debt (older than 28 days), the company is **immediately unblocked**.

## Testing
Use `test_payment_webhook.js` to simulate a payment against a local test database.

```bash
$env:DB_PATH="driverflow_test_webhook.db"
node test_payment_webhook.js
```
