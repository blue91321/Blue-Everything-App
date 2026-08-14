CREATE TABLE `integration_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_name` text,
	`account_id` text,
	`access_token` text,
	`refresh_token` text,
	`expires_at` integer,
	`scopes` text DEFAULT '[]' NOT NULL,
	`api_key` text,
	`external_id` text,
	`synced_at` text DEFAULT '{}' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_items` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`creator` text,
	`album` text,
	`duration_ms` integer,
	`url` text,
	`art_url` text,
	`genres` text DEFAULT '[]' NOT NULL,
	`category` text DEFAULT 'unknown' NOT NULL,
	`category_because` text,
	`released_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_items_provider_idx` ON `media_items` (`provider`,`provider_item_id`);--> statement-breakpoint
CREATE INDEX `media_items_category_idx` ON `media_items` (`category`);--> statement-breakpoint
CREATE TABLE `media_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_collection_id` text NOT NULL,
	`kind` text DEFAULT 'playlist' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`art_url` text,
	`item_count` integer DEFAULT 0 NOT NULL,
	`snapshot_id` text,
	`synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_collections_provider_idx` ON `media_collections` (`provider`,`provider_collection_id`);--> statement-breakpoint
CREATE TABLE `media_collection_items` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`added_at` integer,
	FOREIGN KEY (`collection_id`) REFERENCES `media_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_collection_items_collection_idx` ON `media_collection_items` (`collection_id`,`position`);--> statement-breakpoint
CREATE TABLE `media_plays` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`played_at` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_plays_item_at_idx` ON `media_plays` (`item_id`,`played_at`,`source`);--> statement-breakpoint
CREATE TABLE `friends` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`state` text DEFAULT 'offline' NOT NULL,
	`game` text,
	`detail` text,
	`last_online_at` integer,
	`seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `friends_provider_user_idx` ON `friends` (`provider`,`provider_user_id`);
