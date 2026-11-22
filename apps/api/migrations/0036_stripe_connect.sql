ALTER TABLE `payment_credentials` ADD `stripe_account_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_credentials_stripe_account_idx` ON `payment_credentials` (`stripe_account_id`);