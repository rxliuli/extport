CREATE TABLE `announced_releases` (
	`tenant_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`version` text NOT NULL,
	`announced_at` text NOT NULL,
	PRIMARY KEY(`extension_id`, `version`)
);
--> statement-breakpoint
CREATE INDEX `announced_releases_tenant_idx` ON `announced_releases` (`tenant_id`);--> statement-breakpoint
-- Backfill: every release already live on its baseline store counts as
-- announced, so the inbox starts empty instead of listing all history.
INSERT OR IGNORE INTO `announced_releases` (`tenant_id`, `extension_id`, `version`, `announced_at`)
SELECT `tenant_id`, `extension_id`, `version`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `deployment_versions`
WHERE `status` = 'online'
  AND (`store` = 'chrome'
    OR `extension_id` NOT IN (SELECT `extension_id` FROM `publish_targets` WHERE `store` = 'chrome'));
