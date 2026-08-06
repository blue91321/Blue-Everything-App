ALTER TABLE `habits` ADD `voice_phrases` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `wake_word` text DEFAULT 'hey everything' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `require_known_speaker` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `speaker_threshold_pct` integer DEFAULT 55 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `voiceprint` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `voiceprint_samples` integer DEFAULT 0 NOT NULL;
