DROP INDEX `extensions_slug_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `extensions_name_idx` ON `extensions` (`tenant_id`,`name`);--> statement-breakpoint
ALTER TABLE `extensions` DROP COLUMN `slug`;