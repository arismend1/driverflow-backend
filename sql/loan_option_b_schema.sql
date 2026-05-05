-- Esquema inicial para Opción B (SQLite local)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lender_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  full_name TEXT NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'DOP',
  initial_capital NUMERIC NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lender_defaults (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_interest_rate_monthly NUMERIC NOT NULL DEFAULT 0,
  default_late_fee_rate NUMERIC NOT NULL DEFAULT 0,
  default_other_fee_rate NUMERIC NOT NULL DEFAULT 0,
  default_frequency TEXT NOT NULL CHECK (default_frequency IN ('SEMANAL','QUINCENAL','MENSUAL')),
  interest_mode TEXT NOT NULL CHECK (interest_mode IN ('SIMPLE','COMPUESTO')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  national_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  principal_original NUMERIC NOT NULL,
  principal_outstanding NUMERIC NOT NULL,
  interest_rate_monthly NUMERIC NOT NULL,
  late_fee_rate NUMERIC NOT NULL,
  other_fee_rate NUMERIC NOT NULL DEFAULT 0,
  payment_frequency TEXT NOT NULL CHECK (payment_frequency IN ('SEMANAL','QUINCENAL','MENSUAL')),
  interest_mode TEXT NOT NULL CHECK (interest_mode IN ('SIMPLE','COMPUESTO')),
  start_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVO','PAGADO','ATRASADO','CANCELADO')) DEFAULT 'ACTIVO',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS installments (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  installment_no INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  principal_due NUMERIC NOT NULL,
  interest_due NUMERIC NOT NULL,
  late_fee_due NUMERIC NOT NULL DEFAULT 0,
  principal_paid NUMERIC NOT NULL DEFAULT 0,
  interest_paid NUMERIC NOT NULL DEFAULT 0,
  late_fee_paid NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('PENDIENTE','PAGADA','VENCIDA','PARCIAL')) DEFAULT 'PENDIENTE',
  UNIQUE (loan_id, installment_no)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  method TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  installment_id INTEGER REFERENCES installments(id) ON DELETE SET NULL,
  component TEXT NOT NULL CHECK (component IN ('MORA','INTERES','CAPITAL','OTRO')),
  amount NUMERIC NOT NULL CHECK (amount > 0)
);

CREATE TABLE IF NOT EXISTS reenganches (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  balance_before NUMERIC NOT NULL CHECK (balance_before >= 0),
  balance_after NUMERIC NOT NULL CHECK (balance_after >= 0),
  applied_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cash_ledger (
  id INTEGER PRIMARY KEY,
  movement_date TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('CAPITAL_INICIAL','DESEMBOLSO','COBRO_CAPITAL','COBRO_INTERES','COBRO_MORA','PERDIDA','AJUSTE','REENGANCHE')),
  amount_in NUMERIC NOT NULL DEFAULT 0,
  amount_out NUMERIC NOT NULL DEFAULT 0,
  loan_id INTEGER REFERENCES loans(id) ON DELETE SET NULL,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS backup_registry (
  id INTEGER PRIMARY KEY,
  backup_filename TEXT NOT NULL,
  backup_sha256 TEXT,
  exported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  restored_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('EXPORTADO','RESTAURADO','FALLIDO')) DEFAULT 'EXPORTADO',
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_loans_customer_id ON loans(customer_id);
CREATE INDEX IF NOT EXISTS idx_installments_loan_id ON installments(loan_id);
CREATE INDEX IF NOT EXISTS idx_installments_due_date ON installments(due_date);
CREATE INDEX IF NOT EXISTS idx_payments_loan_id ON payments(loan_id);
CREATE INDEX IF NOT EXISTS idx_reenganches_loan_id ON reenganches(loan_id);
CREATE INDEX IF NOT EXISTS idx_cash_ledger_movement_date ON cash_ledger(movement_date);

CREATE TRIGGER IF NOT EXISTS trg_reenganches_apply
AFTER INSERT ON reenganches
BEGIN
  UPDATE loans
     SET principal_outstanding = principal_outstanding + NEW.amount,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.loan_id;

  INSERT INTO cash_ledger (
    movement_date,
    movement_type,
    amount_in,
    amount_out,
    loan_id,
    reference
  ) VALUES (
    NEW.applied_date,
    'REENGANCHE',
    0,
    NEW.amount,
    NEW.loan_id,
    COALESCE(NEW.note, 'Reenganche aplicado')
  );

  INSERT INTO audit_log (entity_type, entity_id, action, details_json)
  VALUES (
    'LOAN',
    NEW.loan_id,
    'REENGANCHE_APLICADO',
    json_object(
      'reenganche_id', NEW.id,
      'monto', NEW.amount,
      'saldo_antes', NEW.balance_before,
      'saldo_despues', NEW.balance_after
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_allocations_capital
AFTER INSERT ON payment_allocations
WHEN NEW.component = 'CAPITAL'
BEGIN
  UPDATE loans
     SET principal_outstanding = MAX(principal_outstanding - NEW.amount, 0),
         updated_at = CURRENT_TIMESTAMP
   WHERE id = (SELECT loan_id FROM payments WHERE id = NEW.payment_id);

  INSERT INTO cash_ledger (
    movement_date,
    movement_type,
    amount_in,
    amount_out,
    loan_id,
    reference
  ) VALUES (
    (SELECT payment_date FROM payments WHERE id = NEW.payment_id),
    'COBRO_CAPITAL',
    NEW.amount,
    0,
    (SELECT loan_id FROM payments WHERE id = NEW.payment_id),
    'Pago aplicado a capital'
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_allocations_interest
AFTER INSERT ON payment_allocations
WHEN NEW.component = 'INTERES'
BEGIN
  INSERT INTO cash_ledger (
    movement_date,
    movement_type,
    amount_in,
    amount_out,
    loan_id,
    reference
  ) VALUES (
    (SELECT payment_date FROM payments WHERE id = NEW.payment_id),
    'COBRO_INTERES',
    NEW.amount,
    0,
    (SELECT loan_id FROM payments WHERE id = NEW.payment_id),
    'Pago aplicado a interés'
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_payment_allocations_late_fee
AFTER INSERT ON payment_allocations
WHEN NEW.component = 'MORA'
BEGIN
  INSERT INTO cash_ledger (
    movement_date,
    movement_type,
    amount_in,
    amount_out,
    loan_id,
    reference
  ) VALUES (
    (SELECT payment_date FROM payments WHERE id = NEW.payment_id),
    'COBRO_MORA',
    NEW.amount,
    0,
    (SELECT loan_id FROM payments WHERE id = NEW.payment_id),
    'Pago aplicado a mora'
  );
END;



CREATE TRIGGER IF NOT EXISTS trg_payment_allocations_installment
AFTER INSERT ON payment_allocations
WHEN NEW.installment_id IS NOT NULL
BEGIN
  UPDATE installments
     SET late_fee_paid = CASE WHEN NEW.component = 'MORA' THEN late_fee_paid + NEW.amount ELSE late_fee_paid END,
         interest_paid = CASE WHEN NEW.component = 'INTERES' THEN interest_paid + NEW.amount ELSE interest_paid END,
         principal_paid = CASE WHEN NEW.component = 'CAPITAL' THEN principal_paid + NEW.amount ELSE principal_paid END
   WHERE id = NEW.installment_id;

  UPDATE installments
     SET status = CASE
       WHEN (principal_paid >= principal_due) AND (interest_paid >= interest_due) AND (late_fee_paid >= late_fee_due) THEN 'PAGADA'
       WHEN (principal_paid > 0 OR interest_paid > 0 OR late_fee_paid > 0) THEN 'PARCIAL'
       WHEN date(due_date) < date('now') THEN 'VENCIDA'
       ELSE status
     END
   WHERE id = NEW.installment_id;
END;

CREATE VIEW IF NOT EXISTS v_cash_position AS
SELECT
  COALESCE(SUM(amount_in), 0) AS total_in,
  COALESCE(SUM(amount_out), 0) AS total_out,
  COALESCE(SUM(amount_in - amount_out), 0) AS cash_available
FROM cash_ledger;

CREATE VIEW IF NOT EXISTS v_portfolio_summary AS
SELECT
  COUNT(*) AS active_loans,
  COALESCE(SUM(principal_outstanding), 0) AS principal_outstanding,
  COALESCE(SUM(CASE WHEN status = 'ATRASADO' THEN principal_outstanding ELSE 0 END), 0) AS overdue_principal
FROM loans
WHERE status IN ('ACTIVO', 'ATRASADO');


CREATE VIEW IF NOT EXISTS v_quarterly_report AS
SELECT
  strftime('%Y', movement_date) AS year,
  CAST(((CAST(strftime('%m', movement_date) AS INTEGER) - 1) / 3) + 1 AS INTEGER) AS quarter,
  COALESCE(SUM(CASE WHEN movement_type IN ('COBRO_INTERES', 'COBRO_MORA') THEN amount_in ELSE 0 END), 0) AS earnings_income,
  COALESCE(SUM(CASE WHEN movement_type IN ('DESEMBOLSO', 'REENGANCHE') THEN amount_out ELSE 0 END), 0) AS capital_out,
  COALESCE(SUM(amount_in - amount_out), 0) AS net_cash_flow
FROM cash_ledger
GROUP BY 1, 2
ORDER BY 1 DESC, 2 DESC;

CREATE VIEW IF NOT EXISTS v_loan_customer_overview AS
SELECT
  l.id AS loan_id,
  c.full_name AS customer_name,
  l.status,
  l.principal_original,
  l.principal_outstanding,
  l.interest_rate_monthly,
  l.late_fee_rate,
  COALESCE((SELECT SUM(r.amount) FROM reenganches r WHERE r.loan_id = l.id), 0) AS total_reenganches
FROM loans l
JOIN customers c ON c.id = l.customer_id;
