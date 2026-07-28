ALTER TABLE `products` RENAME TO `plans`;--> statement-breakpoint
ALTER TABLE `licenses` RENAME COLUMN `product_id` TO `plan_id`;--> statement-breakpoint
DROP INDEX `products_tenant_idx`;--> statement-breakpoint
DROP INDEX `products_ext_tier_idx`;--> statement-breakpoint
CREATE INDEX `plans_tenant_idx` ON `plans` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `plans_ext_tier_idx` ON `plans` (`extension_id`,`tier`);
