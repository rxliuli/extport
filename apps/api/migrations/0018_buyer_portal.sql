CREATE TABLE `buyer_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `buyer_sessions_token_idx` ON `buyer_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `buyer_sessions_email_idx` ON `buyer_sessions` (`email`);--> statement-breakpoint
CREATE TABLE `magic_links` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `magic_links_code_idx` ON `magic_links` (`code_hash`);--> statement-breakpoint
CREATE INDEX `magic_links_email_idx` ON `magic_links` (`email`);--> statement-breakpoint
ALTER TABLE `licenses` ADD `checkout_session_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_checkout_session_idx` ON `licenses` (`checkout_session_id`);