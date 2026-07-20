PRAGMA defer_foreign_keys=true;--> statement-breakpoint
CREATE TABLE `__new_activations` (
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
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`license_id`) REFERENCES `licenses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_activations`("id", "tenant_id", "license_id", "device_fingerprint", "last_heartbeat_at", "activated_at", "released_at", "ip_hint", "ua_hint", "created_at", "updated_at") SELECT "id", "tenant_id", "license_id", "device_fingerprint", strftime('%Y-%m-%dT%H:%M:%fZ', "last_heartbeat_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "activated_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "released_at" / 1000.0, 'unixepoch'), "ip_hint", "ua_hint", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `activations`;--> statement-breakpoint
DROP TABLE `activations`;--> statement-breakpoint
ALTER TABLE `__new_activations` RENAME TO `activations`;--> statement-breakpoint
CREATE INDEX `activations_license_idx` ON `activations` (`license_id`);--> statement-breakpoint
CREATE INDEX `activations_tenant_idx` ON `activations` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `__new_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`last4` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_api_keys`("id", "tenant_id", "name", "key_hash", "last4", "last_used_at", "revoked_at", "created_at", "updated_at") SELECT "id", "tenant_id", "name", "key_hash", "last4", strftime('%Y-%m-%dT%H:%M:%fZ', "last_used_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "revoked_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `api_keys`;--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_tenant_idx` ON `api_keys` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `__new_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`version` text NOT NULL,
	`store` text,
	`source` text NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_artifacts`("id", "tenant_id", "extension_id", "version", "store", "source", "r2_key", "sha256", "size", "created_at", "updated_at") SELECT "id", "tenant_id", "extension_id", "version", "store", "source", "r2_key", "sha256", "size", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `artifacts`;--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_ext_version_store_idx` ON `artifacts` (`extension_id`,`version`,`store`);--> statement-breakpoint
CREATE INDEX `artifacts_tenant_idx` ON `artifacts` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `artifacts_ext_idx` ON `artifacts` (`extension_id`);--> statement-breakpoint
CREATE TABLE `__new_deployment_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`store` text NOT NULL,
	`version` text NOT NULL,
	`artifact_id` text,
	`status` text NOT NULL,
	`status_detail` text,
	`submitted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_deployment_versions`("id", "tenant_id", "extension_id", "store", "version", "artifact_id", "status", "status_detail", "submitted_at", "created_at", "updated_at") SELECT "id", "tenant_id", "extension_id", "store", "version", "artifact_id", "status", "status_detail", strftime('%Y-%m-%dT%H:%M:%fZ', "submitted_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `deployment_versions`;--> statement-breakpoint
DROP TABLE `deployment_versions`;--> statement-breakpoint
ALTER TABLE `__new_deployment_versions` RENAME TO `deployment_versions`;--> statement-breakpoint
CREATE INDEX `deployment_versions_ext_store_idx` ON `deployment_versions` (`extension_id`,`store`);--> statement-breakpoint
CREATE INDEX `deployment_versions_ext_store_status_idx` ON `deployment_versions` (`extension_id`,`store`,`status`);--> statement-breakpoint
CREATE INDEX `deployment_versions_tenant_idx` ON `deployment_versions` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `__new_extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`icon_url` text,
	`publishing_enabled` integer NOT NULL,
	`licensing_enabled` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_extensions`("id", "tenant_id", "name", "slug", "icon_url", "publishing_enabled", "licensing_enabled", "created_at", "updated_at") SELECT "id", "tenant_id", "name", "slug", "icon_url", "publishing_enabled", "licensing_enabled", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `extensions`;--> statement-breakpoint
DROP TABLE `extensions`;--> statement-breakpoint
ALTER TABLE `__new_extensions` RENAME TO `extensions`;--> statement-breakpoint
CREATE UNIQUE INDEX `extensions_slug_idx` ON `extensions` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `extensions_tenant_idx` ON `extensions` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `__new_license_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`license_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`license_id`) REFERENCES `licenses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_license_events`("id", "tenant_id", "license_id", "type", "payload_json", "created_at") SELECT "id", "tenant_id", "license_id", "type", "payload_json", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch') FROM `license_events`;--> statement-breakpoint
DROP TABLE `license_events`;--> statement-breakpoint
ALTER TABLE `__new_license_events` RENAME TO `license_events`;--> statement-breakpoint
CREATE INDEX `license_events_license_idx` ON `license_events` (`license_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_licenses` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_id` text NOT NULL,
	`key` text NOT NULL,
	`buyer_email` text NOT NULL,
	`entitlement_type` text NOT NULL,
	`balance` integer,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_licenses`("id", "tenant_id", "product_id", "key", "buyer_email", "entitlement_type", "balance", "status", "source", "source_ref", "created_at", "updated_at") SELECT "id", "tenant_id", "product_id", "key", "buyer_email", "entitlement_type", "balance", "status", "source", "source_ref", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `licenses`;--> statement-breakpoint
DROP TABLE `licenses`;--> statement-breakpoint
ALTER TABLE `__new_licenses` RENAME TO `licenses`;--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_key_idx` ON `licenses` (`key`);--> statement-breakpoint
CREATE INDEX `licenses_tenant_idx` ON `licenses` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `licenses_buyer_idx` ON `licenses` (`tenant_id`,`buyer_email`);--> statement-breakpoint
CREATE TABLE `__new_products` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`name` text NOT NULL,
	`entitlement_type` text NOT NULL,
	`max_activations` integer NOT NULL,
	`stripe_metadata_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_products`("id", "tenant_id", "extension_id", "name", "entitlement_type", "max_activations", "stripe_metadata_key", "created_at", "updated_at") SELECT "id", "tenant_id", "extension_id", "name", "entitlement_type", "max_activations", "stripe_metadata_key", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `products`;--> statement-breakpoint
DROP TABLE `products`;--> statement-breakpoint
ALTER TABLE `__new_products` RENAME TO `products`;--> statement-breakpoint
CREATE INDEX `products_tenant_idx` ON `products` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `__new_publish_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`store` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_publish_events`("id", "tenant_id", "extension_id", "store", "type", "payload_json", "created_at") SELECT "id", "tenant_id", "extension_id", "store", "type", "payload_json", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch') FROM `publish_events`;--> statement-breakpoint
DROP TABLE `publish_events`;--> statement-breakpoint
ALTER TABLE `__new_publish_events` RENAME TO `publish_events`;--> statement-breakpoint
CREATE INDEX `publish_events_tenant_idx` ON `publish_events` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `publish_events_ext_idx` ON `publish_events` (`extension_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_publish_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`store` text NOT NULL,
	`store_item_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`last_reconciled_at` text,
	`last_error_detail` text,
	`last_error_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `store_credentials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_publish_targets`("id", "tenant_id", "extension_id", "store", "store_item_id", "credential_id", "enabled", "last_reconciled_at", "last_error_detail", "last_error_at", "created_at", "updated_at") SELECT "id", "tenant_id", "extension_id", "store", "store_item_id", "credential_id", "enabled", strftime('%Y-%m-%dT%H:%M:%fZ', "last_reconciled_at" / 1000.0, 'unixepoch'), "last_error_detail", strftime('%Y-%m-%dT%H:%M:%fZ', "last_error_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `publish_targets`;--> statement-breakpoint
DROP TABLE `publish_targets`;--> statement-breakpoint
ALTER TABLE `__new_publish_targets` RENAME TO `publish_targets`;--> statement-breakpoint
CREATE UNIQUE INDEX `publish_targets_ext_store_idx` ON `publish_targets` (`extension_id`,`store`);--> statement-breakpoint
CREATE INDEX `publish_targets_tenant_idx` ON `publish_targets` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "user_id", "token_hash", "expires_at", "created_at") SELECT "id", "user_id", "token_hash", strftime('%Y-%m-%dT%H:%M:%fZ', "expires_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch') FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `__new_store_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store` text NOT NULL,
	`label` text NOT NULL,
	`hint` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`key_version` integer NOT NULL,
	`expires_at` text,
	`last_verified_at` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_store_credentials`("id", "tenant_id", "store", "label", "hint", "encrypted_payload", "key_version", "expires_at", "last_verified_at", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "store", "label", "hint", "encrypted_payload", "key_version", strftime('%Y-%m-%dT%H:%M:%fZ', "expires_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "last_verified_at" / 1000.0, 'unixepoch'), "status", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `store_credentials`;--> statement-breakpoint
DROP TABLE `store_credentials`;--> statement-breakpoint
ALTER TABLE `__new_store_credentials` RENAME TO `store_credentials`;--> statement-breakpoint
CREATE INDEX `store_credentials_tenant_idx` ON `store_credentials` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `__new_tenant_signing_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`private_key_encrypted` text NOT NULL,
	`public_key` text NOT NULL,
	`key_version` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_tenant_signing_keys`("id", "tenant_id", "private_key_encrypted", "public_key", "key_version", "status", "created_at", "updated_at") SELECT "id", "tenant_id", "private_key_encrypted", "public_key", "key_version", "status", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `tenant_signing_keys`;--> statement-breakpoint
DROP TABLE `tenant_signing_keys`;--> statement-breakpoint
ALTER TABLE `__new_tenant_signing_keys` RENAME TO `tenant_signing_keys`;--> statement-breakpoint
CREATE INDEX `tenant_signing_keys_tenant_idx` ON `tenant_signing_keys` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `__new_tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`plan` text NOT NULL,
	`settings_json` text NOT NULL,
	`dek_encrypted` text NOT NULL,
	`dek_key_version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tenants`("id", "name", "email", "plan", "settings_json", "dek_encrypted", "dek_key_version", "created_at", "updated_at") SELECT "id", "name", "email", "plan", "settings_json", "dek_encrypted", "dek_key_version", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `tenants`;--> statement-breakpoint
DROP TABLE `tenants`;--> statement-breakpoint
ALTER TABLE `__new_tenants` RENAME TO `tenants`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`auth_provider` text NOT NULL,
	`auth_subject` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "tenant_id", "email", "display_name", "auth_provider", "auth_subject", "created_at", "updated_at") SELECT "id", "tenant_id", "email", "display_name", "auth_provider", "auth_subject", strftime('%Y-%m-%dT%H:%M:%fZ', "created_at" / 1000.0, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at" / 1000.0, 'unixepoch') FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_auth_idx` ON `users` (`auth_provider`,`auth_subject`);--> statement-breakpoint
CREATE INDEX `users_tenant_idx` ON `users` (`tenant_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys=false;