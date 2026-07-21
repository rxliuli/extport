ALTER TABLE `deployment_versions` ADD `platform` text;--> statement-breakpoint
UPDATE `deployment_versions` SET `platform` = 'macos' WHERE `store` = 'safari';
