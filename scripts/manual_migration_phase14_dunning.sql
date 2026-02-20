-- PHASE 14: DUNNING & AUTO-RETRY
-- RUN THIS MANUALLY IN RENDER DASHBOARD OR DBEAVER (PROD DB)

-- 1. Add Dunning control columns to weekly_invoices
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS last_error_code TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS last_error_message TEXT;
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

-- (The attempt_count column should already exist from Phase 13, but let's be safe)
ALTER TABLE weekly_invoices ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0;

-- 2. Create Audit Log Table for Payment Attempts
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

-- 3. Indexes for scheduling and auditing
CREATE INDEX IF NOT EXISTS idx_invoices_next_retry ON weekly_invoices(next_retry_at) WHERE status IN ('failed', 'retrying');
CREATE INDEX IF NOT EXISTS idx_invoice_attempts_inv_id ON invoice_attempts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_suspended ON weekly_invoices(suspended_at) WHERE suspended_at IS NOT NULL;

-- 4. Verification Check
SELECT table_name FROM information_schema.tables WHERE table_name = 'invoice_attempts';
