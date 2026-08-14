ALTER TABLE `friends` ADD `person_id` text;--> statement-breakpoint
CREATE INDEX `friends_person_idx` ON `friends` (`person_id`);
