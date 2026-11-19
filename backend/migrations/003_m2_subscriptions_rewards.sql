-- M2: mock subscription lifecycle, introductory trial, rewarded ads and analytics events.
-- Rules: product-requirements.md §2.1, §2.4, §3.1, §3.2, §4; decisions D-027..D-036 (docs/decisions.md).
--
-- Data lifecycle:
--   subscriptions         one MUTABLE current-state row per (user, subscription group), derived from the immutable
--                         records below. It is the only mutable table added here.
--   subscription_periods  IMMUTABLE: one row per verified provider transaction (trial, paid period, renewal, upgrade).
--   subscription_events   IMMUTABLE: every lifecycle request/notification received, with its idempotency key and result.
--   trial_redemptions     IMMUTABLE: the authoritative backend record that a customer used the introductory trial.
--   subscription_revocations IMMUTABLE: one row per refunded/revoked period.
--   ad_rewards            IMMUTABLE: every rewarded-ad attempt (successful or not). The daily cap is enforced by a
--                         unique (user, UTC day, slot 1..10) constraint.
--   analytics_events      append-only analytics stream, deliberately separate from ledger accounting.
-- Credits move only through credit_ledger (append-only); balances follow via the 002 trigger.

-- Subscription catalog (PRD §2.1) -------------------------------------------------
CREATE TABLE subscription_plans (
  id                text PRIMARY KEY CHECK (id ~ '^[A-Z0-9_]{1,50}$'),
  group_id          text NOT NULL CHECK (group_id ~ '^[A-Z0-9_]{1,50}$'),
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  tier              integer NOT NULL CHECK (tier > 0),
  period_days       integer NOT NULL CHECK (period_days > 0),
  credits_per_period integer NOT NULL CHECK (credits_per_period > 0),
  CONSTRAINT subscription_plans_group_tier_uq UNIQUE (group_id, tier)
);
INSERT INTO subscription_plans (id, group_id, display_name, tier, period_days, credits_per_period) VALUES
  ('BASIC_WEEKLY',   'MONETALAB_WEEKLY', 'Basic',   1, 7, 3000),
  ('PREMIUM_WEEKLY', 'MONETALAB_WEEKLY', 'Premium', 2, 7, 6000),
  ('ULTRA_WEEKLY',   'MONETALAB_WEEKLY', 'Ultra',   3, 7, 12000);

-- Introductory offers. Only Basic has one (PRD §2.1, open decision #4: do not assume others exist).
CREATE TABLE subscription_intro_offers (
  plan_id  text PRIMARY KEY REFERENCES subscription_plans (id),
  kind     text NOT NULL CHECK (kind IN ('FREE_TRIAL')),
  days     integer NOT NULL CHECK (days > 0),
  credits  integer NOT NULL CHECK (credits > 0)
);
INSERT INTO subscription_intro_offers (plan_id, kind, days, credits) VALUES ('BASIC_WEEKLY', 'FREE_TRIAL', 3, 1000);

-- Current subscription state (mutable, derived) -----------------------------------
CREATE TABLE subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id),
  group_id         text NOT NULL CHECK (group_id ~ '^[A-Z0-9_]{1,50}$'),
  provider         text NOT NULL CHECK (provider IN ('mock')),
  status           text NOT NULL CHECK (status IN ('TRIAL', 'ACTIVE', 'EXPIRED', 'REVOKED')),
  plan_id          text NOT NULL REFERENCES subscription_plans (id),
  pending_plan_id  text REFERENCES subscription_plans (id),
  auto_renew       boolean NOT NULL,
  current_period_id uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_user_group_uq UNIQUE (user_id, group_id),
  CONSTRAINT subscriptions_id_user_uq UNIQUE (id, user_id),
  CONSTRAINT subscriptions_pending_differs CHECK (pending_plan_id IS NULL OR pending_plan_id <> plan_id),
  -- An ended subscription has no scheduled change and does not auto-renew.
  CONSTRAINT subscriptions_ended_shape CHECK (status IN ('TRIAL', 'ACTIVE') OR (pending_plan_id IS NULL AND NOT auto_renew))
);

-- Verified provider transactions = entitlement periods (immutable) -----------------
CREATE TABLE subscription_periods (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid NOT NULL,
  user_id          uuid NOT NULL REFERENCES users (id),
  provider         text NOT NULL CHECK (provider IN ('mock')),
  transaction_id   text NOT NULL CHECK (length(transaction_id) BETWEEN 1 AND 200),
  plan_id          text NOT NULL REFERENCES subscription_plans (id),
  kind             text NOT NULL CHECK (kind IN ('TRIAL', 'INITIAL', 'RENEWAL', 'UPGRADE')),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  credits          integer NOT NULL CHECK (credits > 0),
  -- APPLIED: became the current period. SUPERSEDED: a verified but out-of-order/late transaction, kept for audit only.
  disposition      text NOT NULL CHECK (disposition IN ('APPLIED', 'SUPERSEDED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_periods_subscription_fk FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions (id, user_id),
  CONSTRAINT subscription_periods_provider_tx_uq UNIQUE (provider, transaction_id),
  CONSTRAINT subscription_periods_id_user_uq UNIQUE (id, user_id),
  CONSTRAINT subscription_periods_ends_after_start CHECK (ends_at > starts_at)
);
CREATE INDEX subscription_periods_subscription_idx ON subscription_periods (subscription_id, starts_at);
-- TRIAL-01/02: at most one introductory trial period per user, ever (DB-enforced, independent of app logic).
CREATE UNIQUE INDEX subscription_periods_one_trial_per_user_uq ON subscription_periods (user_id) WHERE kind = 'TRIAL';

-- The current period must belong to the same subscription and user (deferred: both rows are written in one transaction).
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_current_period_fk FOREIGN KEY (current_period_id, user_id)
  REFERENCES subscription_periods (id, user_id) DEFERRABLE INITIALLY DEFERRED;

-- Authoritative trial eligibility record (persistent, not a UI flag) ---------------
CREATE TABLE trial_redemptions (
  user_id     uuid NOT NULL REFERENCES users (id),
  group_id    text NOT NULL,
  period_id   uuid NOT NULL,
  -- Where eligibility was confirmed. M2 only has the backend's own record; M3 adds Apple-verified eligibility.
  source      text NOT NULL CHECK (source IN ('MOCK_PROVIDER')),
  redeemed_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_id),
  CONSTRAINT trial_redemptions_period_fk FOREIGN KEY (period_id, user_id) REFERENCES subscription_periods (id, user_id),
  CONSTRAINT trial_redemptions_period_uq UNIQUE (period_id)
);

CREATE TABLE subscription_revocations (
  period_id   uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id),
  reason      text NOT NULL CHECK (reason IN ('REFUNDED', 'REVOKED')),
  revoked_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_revocations_period_fk FOREIGN KEY (period_id, user_id) REFERENCES subscription_periods (id, user_id)
);

-- Lifecycle requests and provider notifications (immutable, idempotent) -----------
CREATE TABLE subscription_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  provider      text NOT NULL CHECK (provider IN ('mock')),
  -- Namespaced idempotency key, e.g. "purchase:<transactionId>", "notification:<eventId>", "cancel:<requestId>".
  event_key     text NOT NULL CHECK (length(event_key) BETWEEN 3 AND 230),
  type          text NOT NULL CHECK (type IN ('PURCHASE', 'CHANGE_PLAN', 'CANCEL_AUTO_RENEW', 'RESUME_AUTO_RENEW',
                                              'RENEWED', 'EXPIRED', 'REFUNDED', 'REVOKED')),
  request       jsonb NOT NULL,
  -- What happened: an APPLIED change, a no-op (IGNORED_*), a recorded mock decline/cancel, or a REJECTED request.
  result        text NOT NULL CHECK (length(result) BETWEEN 1 AND 60),
  http_status   integer NOT NULL CHECK (http_status BETWEEN 200 AND 499),
  response      jsonb NOT NULL,
  business_time timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_events_provider_key_uq UNIQUE (provider, event_key)
);
CREATE INDEX subscription_events_user_idx ON subscription_events (user_id, created_at);

-- Rewarded ads (immutable attempts; DB-enforced daily cap) -------------------------
CREATE TABLE ad_rewards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  provider      text NOT NULL CHECK (provider IN ('mock')),
  ad_event_id   text NOT NULL CHECK (length(ad_event_id) BETWEEN 1 AND 200),
  action        text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  ad_outcome    text NOT NULL CHECK (ad_outcome IN ('COMPLETED', 'INCOMPLETE', 'FAILED')),
  status        text NOT NULL CHECK (status IN ('REWARDED', 'NOT_REWARDED', 'LIMIT_REACHED', 'NOT_ELIGIBLE')),
  utc_day       date NOT NULL,
  -- 1..10 for rewarded attempts only: UNIQUE (user, day, slot) makes an 11th grant impossible even under races.
  reward_slot   smallint CHECK (reward_slot BETWEEN 1 AND 10),
  credits       integer NOT NULL CHECK (credits IN (0, 100)),
  business_time timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_rewards_provider_event_uq UNIQUE (provider, ad_event_id),
  CONSTRAINT ad_rewards_id_user_uq UNIQUE (id, user_id),
  CONSTRAINT ad_rewards_daily_slot_uq UNIQUE (user_id, utc_day, reward_slot),
  CONSTRAINT ad_rewards_status_shape CHECK (
    (status = 'REWARDED' AND ad_outcome = 'COMPLETED' AND reward_slot IS NOT NULL AND credits = 100)
    OR (status <> 'REWARDED' AND reward_slot IS NULL AND credits = 0)
  ),
  CONSTRAINT ad_rewards_utc_day_matches CHECK (utc_day = (business_time AT TIME ZONE 'UTC')::date)
);

-- Analytics (append-only, separate from accounting) --------------------------------
CREATE TABLE analytics_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id),
  name         text NOT NULL CHECK (name IN (
                 'trial_started', 'trial_expired', 'subscription_started', 'subscription_renewed',
                 'subscription_cancelled', 'subscription_expired', 'subscription_refunded',
                 'subscription_upgraded', 'subscription_downgraded', 'reward_granted')),
  -- Idempotency: one analytics event of a given name per source fact (provider event / ad event).
  dedupe_key   text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  occurred_at  timestamptz NOT NULL,
  properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_events_name_dedupe_uq UNIQUE (name, dedupe_key)
);
CREATE INDEX analytics_events_name_time_idx ON analytics_events (name, occurred_at);

-- Ledger: subscription grants/expirations and reward grants ------------------------
ALTER TABLE credit_ledger ADD COLUMN subscription_period_id uuid;
ALTER TABLE credit_ledger ADD COLUMN ad_reward_id uuid;
ALTER TABLE credit_ledger ADD COLUMN expiration_reason text;
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_period_fk FOREIGN KEY (subscription_period_id, user_id) REFERENCES subscription_periods (id, user_id);
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_ad_reward_fk FOREIGN KEY (ad_reward_id, user_id) REFERENCES ad_rewards (id, user_id);

ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_entry_type_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_entry_type_check CHECK (entry_type IN (
  'PURCHASE_GRANT', 'OPERATION_DEBIT', 'SEED', 'SUBSCRIPTION_GRANT', 'SUBSCRIPTION_EXPIRATION', 'REWARD_GRANT'));

ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_entry_shape;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_entry_shape CHECK (
  (entry_type = 'PURCHASE_GRANT'
     AND purchase_id IS NOT NULL AND operation_id IS NULL AND seed_reason IS NULL
     AND subscription_period_id IS NULL AND ad_reward_id IS NULL AND expiration_reason IS NULL
     AND bucket = 'CONSUMABLE' AND delta > 0)
  OR
  (entry_type = 'OPERATION_DEBIT'
     AND operation_id IS NOT NULL AND purchase_id IS NULL AND seed_reason IS NULL
     AND subscription_period_id IS NULL AND ad_reward_id IS NULL AND expiration_reason IS NULL
     AND delta < 0)
  OR
  (entry_type = 'SEED'
     AND purchase_id IS NULL AND operation_id IS NULL
     AND subscription_period_id IS NULL AND ad_reward_id IS NULL AND expiration_reason IS NULL
     AND bucket <> 'CONSUMABLE' AND delta > 0
     AND seed_reason IS NOT NULL AND length(seed_reason) BETWEEN 1 AND 200)
  OR
  -- Subscription credits are only ever granted into SUBSCRIPTION, for a verified period.
  (entry_type = 'SUBSCRIPTION_GRANT'
     AND subscription_period_id IS NOT NULL
     AND purchase_id IS NULL AND operation_id IS NULL AND ad_reward_id IS NULL
     AND seed_reason IS NULL AND expiration_reason IS NULL
     AND bucket = 'SUBSCRIPTION' AND delta > 0)
  OR
  -- Expiration only removes SUBSCRIPTION credits (never consumable/reward/promotional), recorded against the period.
  (entry_type = 'SUBSCRIPTION_EXPIRATION'
     AND subscription_period_id IS NOT NULL
     AND purchase_id IS NULL AND operation_id IS NULL AND ad_reward_id IS NULL AND seed_reason IS NULL
     AND expiration_reason IN ('SUPERSEDED', 'PERIOD_ENDED', 'EXPIRED', 'REVOKED')
     AND bucket = 'SUBSCRIPTION' AND delta < 0)
  OR
  (entry_type = 'REWARD_GRANT'
     AND ad_reward_id IS NOT NULL
     AND purchase_id IS NULL AND operation_id IS NULL AND subscription_period_id IS NULL
     AND seed_reason IS NULL AND expiration_reason IS NULL
     AND bucket = 'REWARD' AND delta = 100)
);

-- Exactly-once accounting per source record.
CREATE UNIQUE INDEX credit_ledger_one_grant_per_period_uq
  ON credit_ledger (subscription_period_id) WHERE entry_type = 'SUBSCRIPTION_GRANT';
CREATE UNIQUE INDEX credit_ledger_one_expiration_per_period_uq
  ON credit_ledger (subscription_period_id) WHERE entry_type = 'SUBSCRIPTION_EXPIRATION';
CREATE UNIQUE INDEX credit_ledger_one_grant_per_ad_reward_uq
  ON credit_ledger (ad_reward_id) WHERE entry_type = 'REWARD_GRANT';

-- Grants must match their source exactly (same pattern as DV-001) -----------------
CREATE FUNCTION verify_m2_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p_credits integer;
  p_disposition text;
  a_status text;
BEGIN
  IF NEW.entry_type = 'SUBSCRIPTION_GRANT' THEN
    SELECT credits, disposition INTO p_credits, p_disposition FROM subscription_periods WHERE id = NEW.subscription_period_id;
    IF NOT FOUND THEN
      RETURN NEW; -- the foreign key reports it
    END IF;
    IF p_disposition <> 'APPLIED' THEN
      RAISE EXCEPTION 'subscription grant rejected: period disposition is %', p_disposition
        USING ERRCODE = 'check_violation', CONSTRAINT = 'credit_ledger_grant_requires_applied_period';
    END IF;
    IF NEW.delta IS DISTINCT FROM p_credits THEN
      RAISE EXCEPTION 'subscription grant rejected: amount % does not match the period (% credits)', NEW.delta, p_credits
        USING ERRCODE = 'check_violation', CONSTRAINT = 'credit_ledger_grant_amount_matches_period';
    END IF;
  ELSIF NEW.entry_type = 'REWARD_GRANT' THEN
    SELECT status INTO a_status FROM ad_rewards WHERE id = NEW.ad_reward_id;
    IF FOUND AND a_status <> 'REWARDED' THEN
      RAISE EXCEPTION 'reward grant rejected: ad attempt status is %', a_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'credit_ledger_reward_requires_rewarded_ad';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_ledger_verify_m2_grant
  BEFORE INSERT ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION verify_m2_grant();

-- Immutability -----------------------------------------------------------------
CREATE TRIGGER subscription_periods_immutable BEFORE UPDATE OR DELETE ON subscription_periods
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER subscription_events_immutable BEFORE UPDATE OR DELETE ON subscription_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER trial_redemptions_immutable BEFORE UPDATE OR DELETE ON trial_redemptions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER subscription_revocations_immutable BEFORE UPDATE OR DELETE ON subscription_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER ad_rewards_immutable BEFORE UPDATE OR DELETE ON ad_rewards
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER analytics_events_immutable BEFORE UPDATE OR DELETE ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER subscription_plans_immutable BEFORE UPDATE OR DELETE ON subscription_plans
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER subscription_intro_offers_immutable BEFORE UPDATE OR DELETE ON subscription_intro_offers
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
-- The subscriptions state row may change, but never be deleted (history must stay attached to it).
CREATE TRIGGER subscriptions_no_delete BEFORE DELETE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
-- A revoked subscription can never be reactivated by a later (delayed/out-of-order) event: only a new purchase,
-- which records a new APPLIED period, may move it out of REVOKED.
CREATE FUNCTION guard_subscription_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' AND NEW.current_period_id = OLD.current_period_id THEN
    RAISE EXCEPTION 'a revoked subscription can only be reactivated by a new purchase'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'subscriptions_revoked_needs_new_period';
  END IF;
  IF NEW.status IN ('TRIAL', 'ACTIVE') AND EXISTS (SELECT 1 FROM subscription_revocations WHERE period_id = NEW.current_period_id) THEN
    RAISE EXCEPTION 'the current period was revoked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'subscriptions_current_period_not_revoked';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER subscriptions_guard_transition BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION guard_subscription_transition();
