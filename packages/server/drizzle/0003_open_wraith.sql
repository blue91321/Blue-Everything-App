ALTER TABLE `settings` ADD `quiet_hours_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `follow_windows_dnd` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `dnd_until` integer;