CREATE TABLE `activations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`license_id` text NOT NULL,
	`device_fingerprint` text NOT NULL,
	`last_heartbeat_at` text,
	`activated_at` text NOT NULL,
	`released_at` text,
	`ip_hint` text,
	`ua_hint` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activations_license_device_idx` ON `activations` (`license_id`,`device_fingerprint`);--> statement-breakpoint
CREATE INDEX `activations_tenant_idx` ON `activations` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `license_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`license_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `license_events_license_idx` ON `license_events` (`license_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `licenses` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`key` text NOT NULL,
	`buyer_email` text NOT NULL,
	`entitlement_type` text NOT NULL,
	`max_activations` integer NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_key_idx` ON `licenses` (`key`);--> statement-breakpoint
CREATE INDEX `licenses_tenant_idx` ON `licenses` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `licenses_buyer_idx` ON `licenses` (`tenant_id`,`buyer_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_source_ref_idx` ON `licenses` (`source_ref`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`name` text NOT NULL,
	`tier` text NOT NULL,
	`entitlement_type` text NOT NULL,
	`max_activations` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `products_tenant_idx` ON `products` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_ext_tier_idx` ON `products` (`extension_id`,`tier`);