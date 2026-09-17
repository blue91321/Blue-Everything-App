ALTER TABLE `notes` ADD `title_key` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `notes` ADD `folder` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX `notes_title_key_idx` ON `notes` (`title_key`);
--> statement-breakpoint
CREATE INDEX `notes_folder_idx` ON `notes` (`folder`);
--> statement-breakpoint
CREATE TABLE `note_links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_id` text NOT NULL,
	`target` text NOT NULL,
	`display` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_links_from_idx` ON `note_links` (`from_id`);
--> statement-breakpoint
CREATE INDEX `note_links_target_idx` ON `note_links` (`target`);
--> statement-breakpoint
CREATE TABLE `note_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`tag` text NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_tags_note_idx` ON `note_tags` (`note_id`);
--> statement-breakpoint
CREATE INDEX `note_tags_tag_idx` ON `note_tags` (`tag`);
--> statement-breakpoint
CREATE TABLE `note_files` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text,
	`name` text NOT NULL,
	`ext` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_files_note_idx` ON `note_files` (`note_id`);
