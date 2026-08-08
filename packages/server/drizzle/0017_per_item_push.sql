ALTER TABLE `settings` ADD `push_default` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `push_to_phone` integer;--> statement-breakpoint
ALTER TABLE `habits` ADD `push_to_phone` integer;--> statement-breakpoint
ALTER TABLE `nudges` ADD `push_to_phone` integer DEFAULT 1 NOT NULL;
