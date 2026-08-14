ALTER TABLE `media_collections` ADD `ignored` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `media_collections` SET `ignored` = 1 WHERE `provider` = 'youtube' AND `kind` = 'saved';
