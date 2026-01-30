-- PHASE 13: HARDENING & STRIPE RECONCILIATION
-- RUN THIS MANUALLY IN RENDER DASHBOARD OR DBEAVER (PROD DB)

-- 1. Add Stripe-specific columns to weekly_invoices if they don't exist
-- We strictly need 'charged' status, so we ensure status fits.
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS paid_at TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0;

-- 2. Indexes for Performance and Safety
CREATE INDEX IF NOT EXISTS idx_weekly_invoices_status ON weekly_invoices(status);

-- 3. STRICT IDEMPOTENCY CONSTRAINT
-- This ensures we physically cannot have two invoices for the same company in the same week.
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_invoice_weekly ON weekly_invoices(company_id, week_start);

-- 4. Verification Query (Run this to check schema)
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'weekly_invoices';
