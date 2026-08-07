ALTER TABLE `habits` ADD `reminder_start_minute` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `due_is_all_day` integer DEFAULT 0 NOT NULL;
