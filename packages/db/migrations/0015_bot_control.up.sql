-- Public offline preparation receipts only; never keys, envelopes or paths.
ALTER TABLE bots ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE TABLE wallet_preparations (
  wallet_id uuid PRIMARY KEY REFERENCES wallets(id),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_bot_id uuid UNIQUE REFERENCES bots(id),
  claimed_at timestamptz,
  CHECK ((claimed_bot_id IS NULL) = (claimed_at IS NULL))
);
CREATE FUNCTION bot_control_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.name,NEW.strategy,NEW.strategy_params,NEW.risk_profile_id,NEW.wallet_id,NEW.mode)
    IS DISTINCT FROM ROW(OLD.name,OLD.strategy,OLD.strategy_params,OLD.risk_profile_id,OLD.wallet_id,OLD.mode) THEN
    NEW.revision := OLD.revision + 1;
  ELSE NEW.revision := OLD.revision; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bots_control_revision BEFORE UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION bot_control_revision();
-- The canonical policy audit excludes free-form names. Record a safe marker for name-only edits.
CREATE FUNCTION bot_control_display_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    INSERT INTO audit_log(actor,action,entity_type,entity_id,details)
      VALUES(audit_actor(),'bot.display_changed','bots',NEW.id::text,
        jsonb_build_object('nameChanged',true,'revision',NEW.revision::text));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bots_control_display_audit AFTER UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION bot_control_display_audit();
