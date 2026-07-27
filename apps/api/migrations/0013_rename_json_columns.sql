-- Drop the "_json" suffix now that these columns are read/written via
-- Drizzle's mode: 'json' instead of manual JSON.stringify/parse — the type
-- signature documents the content now, the suffix was the old signal for it.
ALTER TABLE `tenants` RENAME COLUMN `settings_json` TO `settings`;--> statement-breakpoint
ALTER TABLE `publish_events` RENAME COLUMN `payload_json` TO `payload`;--> statement-breakpoint
ALTER TABLE `license_events` RENAME COLUMN `payload_json` TO `payload`;
