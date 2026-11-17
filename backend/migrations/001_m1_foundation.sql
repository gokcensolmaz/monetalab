-- M1 database foundation (Slice 1).
-- Rules: product-requirements.md §2.2–§2.4, CLAUDE.md architecture rules 1–5, decisions D-006/D-007/D-009.
-- Only M1 concepts appear here. Subscription, trial, reward and expiration entry types arrive with their milestones.

-- Users ---------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  password_hash text NOT NULL CHECK (length(password_hash) > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- Sessions: only a hash of the opaque bearer token is stored. Logout sets revoked_at.
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Credit buckets ------------------------------------------------------------
-- Consumption priority (SUBSCRIPTION -> CONSUMABLE -> REWARD -> PROMOTIONAL) lives in application code
-- (src/credits/allocate.ts). The enum only restricts the set of buckets.
CREATE TYPE credit_bucket AS ENUM ('SUBSCRIPTION', 'CONSUMABLE', 'REWARD', 'PROMOTIONAL');

CREATE TABLE bucket_balances (
  user_id    uuid NOT NULL REFERENCES users (id),
  bucket     credit_bucket NOT NULL,
  balance    integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket),
  CONSTRAINT bucket_balances_non_negative CHECK (balance >= 0)
);

-- Every user always has exactly the four bucket rows, so a spend can lock them with SELECT ... FOR UPDATE.
CREATE FUNCTION create_user_bucket_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO bucket_balances (user_id, bucket)
  SELECT NEW.id, b FROM unnest(enum_range(NULL::credit_bucket)) AS b;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_create_bucket_balances
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION create_user_bucket_balances();

-- Purchases (mock consumables in M1) ----------------------------------------
-- One row per provider transaction. All outcomes are recorded so an identical replay can return the original result (D-006).
CREATE TABLE purchases (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users (id),
  provider                text NOT NULL CHECK (provider IN ('mock')),
  provider_transaction_id text NOT NULL CHECK (length(provider_transaction_id) BETWEEN 1 AND 200),
  package_id              text NOT NULL CHECK (length(package_id) BETWEEN 1 AND 100),
  credits                 integer NOT NULL CHECK (credits > 0),
  outcome                 text NOT NULL CHECK (outcome IN ('APPROVED', 'DECLINED', 'CANCELLED')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchases_provider_transaction_uq UNIQUE (provider, provider_transaction_id),
  CONSTRAINT purchases_id_user_uq UNIQUE (id, user_id)
);

-- Spend operations (idempotent by per-user request ID) ----------------------
CREATE TABLE operations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  action     text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  cost       integer NOT NULL CHECK (cost > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_user_request_uq UNIQUE (user_id, request_id),
  CONSTRAINT operations_id_user_uq UNIQUE (id, user_id)
);

-- Credit ledger (append-only) -----------------------------------------------
CREATE TABLE credit_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id),
  bucket       credit_bucket NOT NULL,
  delta        integer NOT NULL CHECK (delta <> 0),
  entry_type   text NOT NULL CHECK (entry_type IN ('PURCHASE_GRANT', 'OPERATION_DEBIT')),
  purchase_id  uuid,
  operation_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The composite FKs also guarantee the referenced purchase or operation belongs to the same user.
  CONSTRAINT credit_ledger_purchase_fk  FOREIGN KEY (purchase_id, user_id)  REFERENCES purchases (id, user_id),
  CONSTRAINT credit_ledger_operation_fk FOREIGN KEY (operation_id, user_id) REFERENCES operations (id, user_id),
  CONSTRAINT credit_ledger_entry_shape CHECK (
    (entry_type = 'PURCHASE_GRANT'
       AND purchase_id IS NOT NULL AND operation_id IS NULL
       AND bucket = 'CONSUMABLE' AND delta > 0)
    OR
    (entry_type = 'OPERATION_DEBIT'
       AND operation_id IS NOT NULL AND purchase_id IS NULL
       AND delta < 0)
  )
);
CREATE INDEX credit_ledger_user_created_idx ON credit_ledger (user_id, created_at, id);

-- No duplicate fulfillment: a purchase grants at most once.
CREATE UNIQUE INDEX credit_ledger_one_grant_per_purchase_uq
  ON credit_ledger (purchase_id) WHERE entry_type = 'PURCHASE_GRANT';
-- An operation debits each bucket at most once.
CREATE UNIQUE INDEX credit_ledger_one_debit_per_operation_bucket_uq
  ON credit_ledger (operation_id, bucket) WHERE entry_type = 'OPERATION_DEBIT';

CREATE FUNCTION reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER credit_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER credit_ledger_no_truncate
  BEFORE TRUNCATE ON credit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
