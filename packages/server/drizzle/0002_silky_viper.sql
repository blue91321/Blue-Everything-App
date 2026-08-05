CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`quiet_start_minute` integer DEFAULT 1380 NOT NULL,
	`quiet_end_minute` integer DEFAULT 450 NOT NULL,
	`reminders_enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `habits` ADD `reminder_every_minutes` integer;--> statement-breakpoint
ALTER TABLE `nudges` ADD `expires_at` integer;