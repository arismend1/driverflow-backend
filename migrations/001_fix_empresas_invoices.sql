-- empresas fix
ALTER TABLE IF EXISTS public.empresas
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- invoices fix

CREATE TABLE IF NOT EXISTS public.invoices (
id BIGSERIAL PRIMARY KEY,
company_id BIGINT,
status TEXT DEFAULT 'open',
total_cents INTEGER DEFAULT 0,
subtotal_cents INTEGER DEFAULT 0,
currency TEXT DEFAULT 'USD',
billing_week TEXT,
week_start TEXT,
issue_date TEXT,
due_date TEXT,
created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
paid_at TIMESTAMP WITH TIME ZONE,
paid_method TEXT,
failure_reason TEXT,
next_retry_at TIMESTAMP WITH TIME ZONE,
last_attempt_at TIMESTAMP WITH TIME ZONE,
suspended_at TIMESTAMP WITH TIME ZONE,
attempt_count INTEGER DEFAULT 0,
stripe_payment_intent_id TEXT,
stripe_charge_id TEXT,
receipt_url TEXT,
updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.invoices
ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT,
ADD COLUMN IF NOT EXISTS receipt_url TEXT,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
