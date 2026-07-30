CREATE TABLE `analytics_daily` (
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`date` text NOT NULL,
	`browser` text NOT NULL,
	`dim` text NOT NULL,
	`dim_value` text NOT NULL,
	`dau` integer DEFAULT 0 NOT NULL,
	`installs` integer DEFAULT 0 NOT NULL,
	`departures` integer DEFAULT 0 NOT NULL,
	`mau` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`extension_id`, `date`, `browser`, `dim`, `dim_value`)
);
--> statement-breakpoint
CREATE INDEX `analytics_daily_series_idx` ON `analytics_daily` (`extension_id`,`dim`,`date`);--> statement-breakpoint
CREATE TABLE `analytics_installs` (
	`extension_id` text NOT NULL,
	`install_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`browser` text NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	`last_version` text NOT NULL,
	PRIMARY KEY(`extension_id`, `install_id`)
);
--> statement-breakpoint
CREATE INDEX `analytics_installs_last_seen_idx` ON `analytics_installs` (`last_seen`);--> statement-breakpoint
CREATE INDEX `analytics_installs_ext_seen_idx` ON `analytics_installs` (`extension_id`,`last_seen`);--> statement-breakpoint
CREATE INDEX `analytics_installs_ext_first_idx` ON `analytics_installs` (`extension_id`,`first_seen`);--> statement-breakpoint
CREATE TABLE `analytics_pings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`install_id` text NOT NULL,
	`date` text NOT NULL,
	`browser` text NOT NULL,
	`version` text NOT NULL,
	`os` text,
	`country` text,
	`language` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analytics_pings_date_idx` ON `analytics_pings` (`date`);