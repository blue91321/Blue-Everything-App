ALTER TABLE `follows` ADD `group_id` text;--> statement-breakpoint
ALTER TABLE `follows` ADD `is_primary` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `follows_group_idx` ON `follows` (`group_id`);
