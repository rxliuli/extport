PRAGMA defer_foreign_keys=true;--> statement-breakpoint
CREATE TABLE `__new_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`tier` text NOT NULL,
	`entitlement_type` text NOT NULL,
	`billing_interval` text DEFAULT 'one_time' NOT NULL,
	`max_activations` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`amount` integer NOT NULL,
	`stripe_product_id` text,
	`stripe_price_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_plans`("id", "tenant_id", "extension_id", "tier", "entitlement_type", "billing_interval", "max_activations", "currency", "amount", "stripe_product_id", "stripe_price_id", "created_at", "updated_at") SELECT "id", "tenant_id", "extension_id", "tier", "entitlement_type", "billing_interval", "max_activations", "currency", "amount", "stripe_product_id", "stripe_price_id", "created_at", "updated_at" FROM `plans`;--> statement-breakpoint
DROP TABLE `plans`;--> statement-breakpoint
ALTER TABLE `__new_plans` RENAME TO `plans`;--> statement-breakpoint
PRAGMA defer_foreign_keys=false;--> statement-breakpoint
CREATE INDEX `plans_tenant_idx` ON `plans` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `plans_ext_tier_idx` ON `plans` (`extension_id`,`tier`,`entitlement_type`,`billing_interval`);