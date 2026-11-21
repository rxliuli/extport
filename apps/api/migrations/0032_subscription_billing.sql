CREATE TABLE `pending_stripe_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`stripe_subscription_id` text NOT NULL,
	`subscription_status` text NOT NULL,
	`current_period_start` text,
	`current_period_end` text,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`last_event_created` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_stripe_subs_tenant_sub_idx` ON `pending_stripe_subscriptions` (`tenant_id`,`stripe_subscription_id`);--> statement-breakpoint
DROP INDEX `plans_ext_tier_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `plans_ext_tier_idx` ON `plans` (`extension_id`,`tier`,`entitlement_type`);--> statement-breakpoint
ALTER TABLE `licenses` ADD `external_user_id` text;--> statement-breakpoint
ALTER TABLE `licenses` ADD `stripe_subscription_id` text;--> statement-breakpoint
ALTER TABLE `licenses` ADD `subscription_status` text;--> statement-breakpoint
ALTER TABLE `licenses` ADD `current_period_start` text;--> statement-breakpoint
ALTER TABLE `licenses` ADD `current_period_end` text;--> statement-breakpoint
ALTER TABLE `licenses` ADD `cancel_at_period_end` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `licenses_tenant_external_user_idx` ON `licenses` (`tenant_id`,`external_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_stripe_subscription_idx` ON `licenses` (`stripe_subscription_id`);