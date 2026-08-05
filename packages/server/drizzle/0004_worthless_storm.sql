ALTER TABLE `settings` ADD `vapid_public_key` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `vapid_private_key` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `push_enabled` integer DEFAULT 1 NOT NULL;