-- BOT-13: all balances here are SIMULATED PAPER policy, never live wallet reservations.
CREATE TABLE risk_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL,
 request_key text NOT NULL, request_hash text NOT NULL, bot_id uuid REFERENCES bots(id),
 status text NOT NULL CHECK(status IN ('approved','vetoed')), code text NOT NULL,
 metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metrics)='object'),
 intent jsonb, execution_attempt_id uuid UNIQUE REFERENCES paper_execution_attempts(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(scope,request_key)
);
CREATE TABLE risk_paper_accounts (
 bot_id uuid PRIMARY KEY REFERENCES bots(id), cap_lamports numeric(39,0) NOT NULL CHECK(cap_lamports>=0),
 consumed_lamports numeric(39,0) NOT NULL DEFAULT 0 CHECK(consumed_lamports>=0)
);
CREATE TABLE risk_days (
 bot_id uuid NOT NULL REFERENCES bots(id), day date NOT NULL,
 opening_book_lamports numeric(39,0) NOT NULL CHECK(opening_book_lamports>=0),
 limit_lamports numeric(39,0) NOT NULL CHECK(limit_lamports>=0),
 loss_used_lamports numeric(39,0) NOT NULL DEFAULT 0 CHECK(loss_used_lamports>=0),
 PRIMARY KEY(bot_id,day)
);
CREATE TABLE risk_streaks (bot_id uuid PRIMARY KEY REFERENCES bots(id), losses integer NOT NULL DEFAULT 0 CHECK(losses>=0));
CREATE TABLE risk_admissions (
 id uuid PRIMARY KEY, decision_id uuid NOT NULL UNIQUE REFERENCES risk_decisions(id),
 order_id uuid NOT NULL UNIQUE REFERENCES orders(id), bot_id uuid NOT NULL REFERENCES bots(id),
 intent jsonb NOT NULL, profile_id text NOT NULL REFERENCES risk_profiles(id), profile_revision bigint NOT NULL,
 config_hash text NOT NULL, model jsonb NOT NULL, max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 3),
 snapshot_id uuid NOT NULL REFERENCES token_safety_snapshots(id), safety_fingerprint text NOT NULL,
 assumptions jsonb NOT NULL, expires_at timestamptz NOT NULL,
 principal_lamports numeric(39,0) NOT NULL CHECK(principal_lamports>0),
 loss_lamports numeric(39,0) NOT NULL CHECK(loss_lamports>0)
);
CREATE TABLE risk_reservations (
 admission_id uuid PRIMARY KEY REFERENCES risk_admissions(id), bot_id uuid NOT NULL REFERENCES bots(id),
 debit_remaining numeric(39,0) NOT NULL CHECK(debit_remaining>=0),
 loss_remaining numeric(39,0) NOT NULL CHECK(loss_remaining>=0),
 state text NOT NULL CHECK(state IN ('active','terminal'))
);
CREATE INDEX risk_active_reservations ON risk_reservations(bot_id) WHERE state='active';
CREATE TABLE risk_position_commitments (
 position_id uuid PRIMARY KEY REFERENCES positions(id), bot_id uuid NOT NULL REFERENCES bots(id),
 loss_remaining numeric(39,0) NOT NULL CHECK(loss_remaining>=0),
 fee_cash numeric(39,0) NOT NULL CHECK(fee_cash>=0),
 max_slippage_bps integer NOT NULL CHECK(max_slippage_bps BETWEEN 0 AND 5000),
 adverse_bps integer NOT NULL CHECK(adverse_bps BETWEEN 0 AND 5000)
);
CREATE TABLE risk_pnl_events (
 attempt_id uuid PRIMARY KEY REFERENCES paper_execution_results(attempt_id), bot_id uuid NOT NULL REFERENCES bots(id),
 position_id uuid REFERENCES positions(id), day date NOT NULL, realized_lamports numeric(39,0) NOT NULL,
 closed boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX risk_closed_once ON risk_pnl_events(position_id) WHERE closed;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['risk_decisions','risk_admissions','risk_pnl_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_change()',t||'_immutable',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_change()',t||'_no_truncate',t);
 END LOOP;
END $$;
CREATE FUNCTION protect_risk_day() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.bot_id<>OLD.bot_id OR NEW.day<>OLD.day OR NEW.opening_book_lamports<>OLD.opening_book_lamports OR NEW.limit_lamports<>OLD.limit_lamports THEN
 RAISE EXCEPTION 'risk day snapshot is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER risk_day_snapshot BEFORE UPDATE ON risk_days FOR EACH ROW EXECUTE FUNCTION protect_risk_day();
CREATE FUNCTION release_terminal_risk_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status IN ('cancelled','failed','filled') THEN
 UPDATE risk_reservations SET state='terminal',debit_remaining=0,loss_remaining=0
 WHERE admission_id IN (SELECT id FROM risk_admissions WHERE order_id=NEW.id) AND state='active';
 END IF; RETURN NEW; END $$;
CREATE TRIGGER risk_order_terminal AFTER UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION release_terminal_risk_order();
