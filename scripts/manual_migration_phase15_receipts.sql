-- PHASE 15: CLIENT BILLING DASHBOARD (Receipts Support)
-- RUN THIS MANUALLY IN RENDER DASHBOARD OR DBEAVER (PROD DB)

-- Add receipt URL & Stripe Charge ID for the client dashboard
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS receipt_url TEXT;

-- Verification
SELECT column_name FROM information_schema.columns WHERE table_name = 'weekly_invoices' AND column_name IN ('stripe_charge_id', 'receipt_url');
