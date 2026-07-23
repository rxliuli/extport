-- Closed-beta gate: adds tenants.status ('pending' | 'active'). Every
-- pre-existing tenant is backfilled to 'active' here so the gate only
-- applies to signups going forward — see requireActiveTenant in
-- middleware/auth.ts. No FK constraints remain on this table (migration
-- 0008), so a plain recreate-and-backfill is safe.
CREATE TABLE `__new_tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`plan` text NOT NULL,
	`status` text NOT NULL,
	`settings_json` text NOT NULL,
	`dek_encrypted` text NOT NULL,
	`dek_key_version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tenants` ("id", "name", "email", "plan", "status", "settings_json", "dek_encrypted", "dek_key_version", "created_at", "updated_at")
SELECT "id", "name", "email", "plan", 'active', "settings_json", "dek_encrypted", "dek_key_version", "created_at", "updated_at" FROM `tenants`;
--> statement-breakpoint
DROP TABLE `tenants`;
--> statement-breakpoint
ALTER TABLE `__new_tenants` RENAME TO `tenants`;
