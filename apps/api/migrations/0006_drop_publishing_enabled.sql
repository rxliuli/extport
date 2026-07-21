-- Publishing has no extension-level switch: configuring a store target is the
-- opt-in, pausing is per-target (publish_targets.enabled). The old default-off
-- flag silently ignored fully-configured targets — a trap, not a kill switch.
ALTER TABLE `extensions` DROP COLUMN `publishing_enabled`;
