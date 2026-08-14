ALTER TABLE `media_items` ADD `creator_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
DROP TABLE IF EXISTS `media_plays`;
