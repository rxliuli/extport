CREATE TABLE `subscription_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscription_events_sub_idx` ON `subscription_events` (`subscription_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`external_user_id` text,
	`buyer_email` text NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text NOT NULL,
	`checkout_session_id` text,
	`status` text NOT NULL,
	`current_period_start` text,
	`current_period_end` text,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`amount_total` integer,
	`currency` text,
	`country` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscriptions_tenant_idx` ON `subscriptions` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_ext_created_idx` ON `subscriptions` (`extension_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `subscriptions_ext_user_idx` ON `subscriptions` (`tenant_id`,`extension_id`,`external_user_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_ext_email_idx` ON `subscriptions` (`tenant_id`,`extension_id`,`buyer_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_stripe_sub_idx` ON `subscriptions` (`stripe_subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_checkout_session_idx` ON `subscriptions` (`checkout_session_id`);--> statement-breakpoint
ALTER TABLE `extensions` ADD `billing_mode` text;--> statement-breakpoint
ALTER TABLE `licenses` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `payment_credentials` ADD `api_key_hint` text;--> statement-breakpoint
ALTER TABLE `pending_stripe_subscriptions` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `plans` ADD `currency` text;--> statement-breakpoint
ALTER TABLE `plans` ADD `amount` integer;--> statement-breakpoint
ALTER TABLE `plans` ADD `monthly_amount` integer;--> statement-breakpoint
ALTER TABLE `plans` ADD `yearly_amount` integer;--> statement-breakpoint
ALTER TABLE `plans` ADD `stripe_product_id` text;--> statement-breakpoint
ALTER TABLE `plans` ADD `stripe_price_id` text;--> statement-breakpoint
ALTER TABLE `plans` ADD `stripe_monthly_price_id` text;--> statement-breakpoint
ALTER TABLE `plans` ADD `stripe_yearly_price_id` text;