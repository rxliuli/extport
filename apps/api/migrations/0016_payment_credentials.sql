CREATE TABLE `payment_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`hint` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`key_version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_credentials_tenant_provider_idx` ON `payment_credentials` (`tenant_id`,`provider`);