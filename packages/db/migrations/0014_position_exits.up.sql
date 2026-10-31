-- BOT-14: policy is captured once, including for pre-existing positions.
CREATE TABLE position_exit_policies (
 position_id uuid PRIMARY KEY REFERENCES positions(id),
 policy jsonb NOT NULL,
 adopted boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION snapshot_position_exit_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO position_exit_policies(position_id,policy,adopted)
 SELECT NEW.id,jsonb_build_object('profileId',r.id,'revision',r.revision::text,
 'stopPriceSol',NEW.stop_price_sol::text,'takeProfit',NEW.take_profit_remaining,
 'trailingFraction',r.trailing_stop_fraction::text,'maxHoldMinutes',r.max_hold_minutes,
 'maxSlippageBps',r.max_slippage_bps,'priceFeeAllowanceLamports','5000','pricePolicy','net_exchange_less_fee_MODEL_v1','quoteRequirements',jsonb_build_object(
 'freshnessPolicy','bounded_request_age','maxAgeMs',5000,'maxSlotLag',0,'fullyObservedCosts',false)),false
 FROM bots b JOIN risk_profiles r ON r.id=b.risk_profile_id WHERE b.id=NEW.bot_id;
 RETURN NEW;
END $$;
CREATE TRIGGER positions_exit_policy AFTER INSERT ON positions FOR EACH ROW EXECUTE FUNCTION snapshot_position_exit_policy();
INSERT INTO position_exit_policies(position_id,policy,adopted)
 SELECT p.id,jsonb_build_object('profileId',r.id,'revision',r.revision::text,
 'stopPriceSol',p.stop_price_sol::text,'takeProfit',p.take_profit_remaining,
 'trailingFraction',r.trailing_stop_fraction::text,'maxHoldMinutes',r.max_hold_minutes,
 'maxSlippageBps',r.max_slippage_bps,'priceFeeAllowanceLamports','5000','pricePolicy','net_exchange_less_fee_MODEL_v1','quoteRequirements',jsonb_build_object(
 'freshnessPolicy','bounded_request_age','maxAgeMs',5000,'maxSlotLag',0,'fullyObservedCosts',false)),true
 FROM positions p JOIN bots b ON b.id=p.bot_id JOIN risk_profiles r ON r.id=b.risk_profile_id;
CREATE TABLE position_exit_state (
 position_id uuid PRIMARY KEY REFERENCES position_exit_policies(position_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 original_raw numeric(39,0),
 high_n numeric NOT NULL DEFAULT 0, high_d numeric NOT NULL DEFAULT 1 CHECK(high_d>0),
 observed_at_ms bigint NOT NULL DEFAULT 0,
 filled_steps jsonb NOT NULL DEFAULT '[]',
 dust_steps jsonb NOT NULL DEFAULT '[]',
 active_decision uuid,
 lease_owner uuid, lease_generation bigint NOT NULL DEFAULT 0,
 lease_until timestamptz,
 last_checked_at timestamptz NOT NULL DEFAULT 'epoch',
 retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 6),
 retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(original_raw IS NULL OR original_raw>0)
);
CREATE TABLE position_exit_decisions (
 id uuid PRIMARY KEY,
 position_id uuid NOT NULL REFERENCES position_exit_policies(position_id),
 sequence integer NOT NULL,
 intent jsonb NOT NULL,
 allocations jsonb NOT NULL,
 evidence jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(position_id,sequence)
);
ALTER TABLE position_exit_state ADD FOREIGN KEY(active_decision) REFERENCES position_exit_decisions(id);
CREATE TABLE position_exit_observations (
 position_id uuid NOT NULL REFERENCES position_exit_policies(position_id),
 observed_at_ms bigint NOT NULL,
 evidence jsonb NOT NULL,
 PRIMARY KEY(position_id,observed_at_ms)
);
CREATE TABLE position_exit_fill_receipts (
 attempt_id uuid PRIMARY KEY REFERENCES paper_execution_results(attempt_id),
 decision_id uuid NOT NULL REFERENCES position_exit_decisions(id),
 input_raw numeric(39,0) NOT NULL CHECK(input_raw>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX position_exit_fill_receipts_decision ON position_exit_fill_receipts(decision_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['position_exit_policies','position_exit_decisions','position_exit_fill_receipts','position_exit_observations'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_change()',t||'_append_only',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_change()',t||'_no_truncate',t);
 END LOOP;
END $$;
