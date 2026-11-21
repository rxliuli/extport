DROP INDEX `plans_ext_tier_idx`;--> statement-breakpoint
ALTER TABLE `plans` ADD `billing_interval` text DEFAULT 'one_time' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `plans_ext_tier_idx` ON `plans` (`extension_id`,`tier`,`entitlement_type`,`billing_interval`);--> statement-breakpoint
ALTER TABLE `plans` DROP COLUMN `monthly_amount`;--> statement-breakpoint
ALTER TABLE `plans` DROP COLUMN `yearly_amount`;--> statement-breakpoint
ALTER TABLE `plans` DROP COLUMN `stripe_monthly_price_id`;--> statement-breakpoint
ALTER TABLE `plans` DROP COLUMN `stripe_yearly_price_id`;