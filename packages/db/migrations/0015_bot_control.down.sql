DROP TRIGGER bots_control_display_audit ON bots;
DROP FUNCTION bot_control_display_audit();
DROP TRIGGER bots_control_revision ON bots;
DROP FUNCTION bot_control_revision();
DROP TABLE wallet_preparations;
ALTER TABLE bots DROP COLUMN revision;
