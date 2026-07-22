-- r2_key/sha256 become nullable (a store whose adapter declares
-- requiresArtifact: false — Safari — pins a version with no real binary,
-- since it reaches App Store Connect directly). source_r2_key is new: a
-- companion source zip AMO requires for bundled/minified Firefox submissions.
PRAGMA defer_foreign_keys=true;--> statement-breakpoint
CREATE TABLE `__new_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`version` text NOT NULL,
	`store` text,
	`source` text NOT NULL,
	`r2_key` text,
	`sha256` text,
	`size` integer NOT NULL,
	`source_r2_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_artifacts`("id", "tenant_id", "extension_id", "version", "store", "source", "r2_key", "sha256", "size", "source_r2_key", "created_at", "updated_at")
SELECT "id", "tenant_id", "extension_id", "version", "store", "source", "r2_key", "sha256", "size", NULL, "created_at", "updated_at" FROM `artifacts`;--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
ALTER TABLE `__new_artifacts` RENAME TO `artifacts`;--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_ext_version_store_idx` ON `artifacts` (`extension_id`,`version`,`store`);--> statement-breakpoint
CREATE INDEX `artifacts_tenant_idx` ON `artifacts` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `artifacts_ext_idx` ON `artifacts` (`extension_id`);
