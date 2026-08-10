CREATE TABLE `follows` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`avatar_url` text,
	`genres` text DEFAULT '[]' NOT NULL,
	`category` text DEFAULT 'unknown' NOT NULL,
	`category_because` text,
	`follower_count` integer,
	`seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follows_provider_account_idx` ON `follows` (`provider`,`provider_account_id`);--> statement-breakpoint
DELETE FROM `media_collection_items` WHERE `collection_id` IN (SELECT `id` FROM `media_collections` WHERE `kind` = 'subscriptions');--> statement-breakpoint
DELETE FROM `media_collections` WHERE `kind` = 'subscriptions';--> statement-breakpoint
DELETE FROM `media_items` WHERE `provider_item_id` LIKE 'channel:%';
