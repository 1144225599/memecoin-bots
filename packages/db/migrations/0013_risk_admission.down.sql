-- A rollback must not erase active policy commitments or accumulated budget usage.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM risk_reservations WHERE state='active') OR EXISTS(SELECT 1 FROM risk_paper_accounts WHERE consumed_lamports>0)
 OR EXISTS(SELECT 1 FROM risk_position_commitments WHERE loss_remaining>0)
 OR EXISTS(SELECT 1 FROM risk_pnl_events) OR EXISTS(SELECT 1 FROM risk_decisions) THEN
 RAISE EXCEPTION 'risk accounting in use: retain risk migration and reconcile/archive explicitly'; END IF;
END $$;
DROP TABLE risk_pnl_events, risk_position_commitments, risk_reservations, risk_admissions, risk_streaks, risk_days, risk_paper_accounts, risk_decisions;
DROP FUNCTION protect_risk_day();
DROP TRIGGER risk_order_terminal ON orders;
DROP FUNCTION release_terminal_risk_order();
