CREATE TABLE `cli_auth_exchanges` (
	`code` text PRIMARY KEY NOT NULL,
	`api_key` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
