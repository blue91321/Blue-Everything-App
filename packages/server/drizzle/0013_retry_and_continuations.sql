ALTER TABLE `settings` ADD `voice_retry_seconds` integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE `voice_commands` ADD `allow_follow_up` integer DEFAULT 1 NOT NULL;
