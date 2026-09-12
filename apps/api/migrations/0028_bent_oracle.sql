DROP INDEX `analytics_installs_last_seen_idx`;--> statement-breakpoint
DROP INDEX `analytics_installs_ext_seen_idx`;--> statement-breakpoint
ALTER TABLE `analytics_daily` DROP COLUMN `departures`;--> statement-breakpoint
ALTER TABLE `analytics_daily` DROP COLUMN `mau`;