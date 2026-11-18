-- M1 credit integrity (Slices 4–6). Enforces deferred verification requirements in the database itself:
--   DV-001: a PURCHASE_GRANT is only possible for an APPROVED purchase, for exactly that package's credits.
--   DV-002: every ledger insert updates the matching bucket balance in the same statement (same transaction),
--           so balance == SUM(ledger.delta) per (user, bucket) as long as balances are only changed through the
--           ledger. The non-negative CHECK on bucket_balances then rejects any overdraft atomically.
--   DV-003 / P-001: auditable SEED entries (test/demo funding of non-consumable buckets) with a mandatory reason.
--                   There is no HTTP route for seeding. See src/db/seed.ts.

-- Consumable package catalog (PRD §2.2) ----------------------------------------
CREATE TABLE credit_packages (
  id           text PRIMARY KEY CHECK (id ~ '^[A-Z0-9_]{1,50}$'),
  credits      integer NOT NULL CHECK (credits > 0),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  sort_order   integer NOT NULL,
  CONSTRAINT credit_packages_id_credits_uq UNIQUE (id, credits)
);
INSERT INTO credit_packages (id, credits, display_name, sort_order) VALUES
  ('CREDITS_S', 5000, 'Credits S', 1),
  ('CREDITS_M', 7000, 'Credits M', 2),
  ('CREDITS_L', 10000, 'Credits L', 3);

-- A purchase records exactly the catalog amount of its package.
ALTER TABLE purchases
  ADD CONSTRAINT purchases_package_fk FOREIGN KEY (package_id, credits) REFERENCES credit_packages (id, credits);

-- Ledger: SEED entry type ------------------------------------------------------
ALTER TABLE credit_ledger ADD COLUMN seed_reason text;
ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_entry_type_check;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_entry_type_check CHECK (entry_type IN ('PURCHASE_GRANT', 'OPERATION_DEBIT', 'SEED'));
ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_entry_shape;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_entry_shape CHECK (
  (entry_type = 'PURCHASE_GRANT'
     AND purchase_id IS NOT NULL AND operation_id IS NULL AND seed_reason IS NULL
     AND bucket = 'CONSUMABLE' AND delta > 0)
  OR
  (entry_type = 'OPERATION_DEBIT'
     AND operation_id IS NOT NULL AND purchase_id IS NULL AND seed_reason IS NULL
     AND delta < 0)
  OR
  -- Consumable credits only ever come from verified purchases, never from seeding.
  (entry_type = 'SEED'
     AND purchase_id IS NULL AND operation_id IS NULL
     AND bucket <> 'CONSUMABLE' AND delta > 0
     AND seed_reason IS NOT NULL AND length(seed_reason) BETWEEN 1 AND 200)
);

-- DV-001: grants only for approved purchases, exact amount ---------------------
CREATE FUNCTION verify_purchase_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p_outcome text;
  p_credits integer;
BEGIN
  IF NEW.entry_type <> 'PURCHASE_GRANT' OR NEW.purchase_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT outcome, credits INTO p_outcome, p_credits FROM purchases WHERE id = NEW.purchase_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing purchase
  END IF;
  IF p_outcome <> 'APPROVED' THEN
    RAISE EXCEPTION 'purchase grant rejected: purchase outcome is %, only APPROVED purchases grant credits', p_outcome
      USING ERRCODE = 'check_violation', CONSTRAINT = 'credit_ledger_grant_requires_approved_purchase';
  END IF;
  IF NEW.delta IS DISTINCT FROM p_credits THEN
    RAISE EXCEPTION 'purchase grant rejected: amount % does not match the purchased package (% credits)', NEW.delta, p_credits
      USING ERRCODE = 'check_violation', CONSTRAINT = 'credit_ledger_grant_amount_matches_purchase';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_ledger_verify_purchase_grant
  BEFORE INSERT ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION verify_purchase_grant();

-- DV-002: ledger insert and balance change happen together ---------------------
-- AFTER trigger. Its name sorts after the foreign-key ("RI_…") triggers, so FK errors are reported first.
CREATE FUNCTION apply_ledger_entry_to_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bucket_balances
     SET balance = balance + NEW.delta, updated_at = now()
   WHERE user_id = NEW.user_id AND bucket = NEW.bucket;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no balance row for user % bucket %', NEW.user_id, NEW.bucket
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER credit_ledger_apply_to_balance
  AFTER INSERT ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry_to_balance();

-- Immutable audit records: purchases, operations, catalog ----------------------
CREATE FUNCTION reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER purchases_immutable BEFORE UPDATE OR DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER purchases_no_truncate BEFORE TRUNCATE ON purchases
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER operations_immutable BEFORE UPDATE OR DELETE ON operations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER operations_no_truncate BEFORE TRUNCATE ON operations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER credit_packages_immutable BEFORE UPDATE OR DELETE ON credit_packages
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE INDEX purchases_user_created_idx ON purchases (user_id, created_at, id);
