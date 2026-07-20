DROP TABLE `deployment_states`;--> statement-breakpoint
ALTER TABLE `publish_targets` ADD `last_reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `publish_targets` ADD `last_error_detail` text;--> statement-breakpoint
ALTER TABLE `publish_targets` ADD `last_error_at` integer;--> statement-breakpoint
CREATE TABLE `deployment_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`store` text NOT NULL,
	`version` text NOT NULL,
	`artifact_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`status_detail` text,
	`submitted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deployment_versions_ext_store_idx` ON `deployment_versions` (`extension_id`,`store`);--> statement-breakpoint
CREATE INDEX `deployment_versions_ext_store_status_idx` ON `deployment_versions` (`extension_id`,`store`,`status`);--> statement-breakpoint
CREATE INDEX `deployment_versions_tenant_idx` ON `deployment_versions` (`tenant_id`);
