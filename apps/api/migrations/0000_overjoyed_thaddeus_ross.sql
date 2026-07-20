CREATE TABLE `activations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`license_id` text NOT NULL,
	`device_fingerprint` text NOT NULL,
	`last_heartbeat_at` integer,
	`activated_at` integer NOT NULL,
	`released_at` integer,
	`ip_hint` text,
	`ua_hint` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`license_id`) REFERENCES `licenses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activations_license_idx` ON `activations` (`license_id`);--> statement-breakpoint
CREATE INDEX `activations_tenant_idx` ON `activations` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`last4` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_tenant_idx` ON `api_keys` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`version` text NOT NULL,
	`store` text,
	`source` text NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_ext_version_store_idx` ON `artifacts` (`extension_id`,`version`,`store`);--> statement-breakpoint
CREATE INDEX `artifacts_tenant_idx` ON `artifacts` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `artifacts_ext_idx` ON `artifacts` (`extension_id`);--> statement-breakpoint
CREATE TABLE `deployment_states` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`store` text NOT NULL,
	`desired_version` text,
	`live_version` text,
	`in_review_version` text,
	`status` text DEFAULT 'synced' NOT NULL,
	`status_detail` text,
	`last_reconciled_at` integer,
	`submitted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_states_ext_store_idx` ON `deployment_states` (`extension_id`,`store`);--> statement-breakpoint
CREATE INDEX `deployment_states_tenant_idx` ON `deployment_states` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`icon_url` text,
	`publishing_enabled` integer DEFAULT false NOT NULL,
	`licensing_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extensions_slug_idx` ON `extensions` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `extensions_tenant_idx` ON `extensions` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `license_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`license_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`license_id`) REFERENCES `licenses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `license_events_license_idx` ON `license_events` (`license_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `licenses` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`key` text NOT NULL,
	`buyer_email` text NOT NULL,
	`entitlement_type` text DEFAULT 'perpetual' NOT NULL,
	`balance` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_key_idx` ON `licenses` (`key`);--> statement-breakpoint
CREATE INDEX `licenses_tenant_idx` ON `licenses` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `licenses_buyer_idx` ON `licenses` (`tenant_id`,`buyer_email`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`name` text NOT NULL,
	`entitlement_type` text DEFAULT 'perpetual' NOT NULL,
	`max_activations` integer DEFAULT 3 NOT NULL,
	`stripe_metadata_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `products_tenant_idx` ON `products` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `publish_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`store` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `publish_events_tenant_idx` ON `publish_events` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `publish_events_ext_idx` ON `publish_events` (`extension_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `publish_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`store` text NOT NULL,
	`store_item_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `store_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_targets_ext_store_idx` ON `publish_targets` (`extension_id`,`store`);--> statement-breakpoint
CREATE INDEX `publish_targets_tenant_idx` ON `publish_targets` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `store_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`last_verified_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `store_credentials_tenant_idx` ON `store_credentials` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `tenant_signing_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`private_key_encrypted` text NOT NULL,
	`public_key` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tenant_signing_keys_tenant_idx` ON `tenant_signing_keys` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`dek_encrypted` text NOT NULL,
	`dek_key_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`auth_provider` text NOT NULL,
	`auth_subject` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_idx` ON `users` (`auth_provider`,`auth_subject`);--> statement-breakpoint
CREATE INDEX `users_tenant_idx` ON `users` (`tenant_id`);