ALTER TABLE `settings` ADD `overlay_placement` text DEFAULT 'cursor' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `overlay_screen` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `overlay_avatar` text DEFAULT '' NOT NULL;
