ALTER TABLE `subscriptions` ADD `pending_plan_id` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `pending_effective_at` text;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `stripe_schedule_id` text;