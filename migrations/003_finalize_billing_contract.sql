ALTER TABLE IF EXISTS public.empresas
ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
ADD COLUMN IF NOT EXISTS billing_suspended BOOLEAN DEFAULT FALSE;

ALTER TABLE IF EXISTS public.invoices
ADD COLUMN IF NOT EXISTS week_start DATE,
ADD COLUMN IF NOT EXISTS week_end DATE,
ADD COLUMN IF NOT EXISTS billing_week TEXT,
ADD COLUMN IF NOT EXISTS subtotal_cents INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_cents INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD',
ADD COLUMN IF NOT EXISTS issue_date TIMESTAMPTZ DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS paid_method TEXT,
ADD COLUMN IF NOT EXISTS failure_reason TEXT,
ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT,
ADD COLUMN IF NOT EXISTS receipt_url TEXT,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE public.invoices
SET week_start = NULLIF(split_part(billing_week, ' to ', 1), '')::date,
    week_end = NULLIF(split_part(billing_week, ' to ', 2), '')::date
WHERE billing_week LIKE '% to %'
  AND (week_start IS NULL OR week_end IS NULL);

UPDATE public.invoices
SET billing_week = week_start::text || ' to ' || week_end::text
WHERE billing_week IS NULL
  AND week_start IS NOT NULL
  AND week_end IS NOT NULL;

UPDATE public.invoices SET status = 'pending' WHERE status = 'open';
UPDATE public.invoices SET status = 'charged' WHERE status = 'paid';

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_company_week_start
ON public.invoices(company_id, week_start)
WHERE week_start IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_items_ticket_id
ON public.invoice_items(ticket_id);

CREATE INDEX IF NOT EXISTS idx_invoices_status
ON public.invoices(status);

CREATE INDEX IF NOT EXISTS idx_invoices_next_retry
ON public.invoices(next_retry_at)
WHERE status = 'retrying';

CREATE INDEX IF NOT EXISTS idx_invoices_stripe_pi
ON public.invoices(stripe_payment_intent_id);

CREATE TABLE IF NOT EXISTS public.invoice_attempts (
    id BIGSERIAL PRIMARY KEY,
    invoice_id BIGINT NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    stripe_payment_intent_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_attempts_invoice_id
ON public.invoice_attempts(invoice_id);

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
    stripe_event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status
ON public.stripe_webhook_events(status);
