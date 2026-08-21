-- Channels that are on air right now.
--
-- Disposable by design: every sync replaces a provider's rows wholesale,
-- because "live" is not a fact that accumulates. Keyed by the channel rather
-- than the broadcast — a channel is live once or not at all, while `stream_id`
-- changes every time they go on.
CREATE TABLE `live_streams` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`channel_name` text NOT NULL,
	`title` text NOT NULL,
	`category` text,
	`viewers` integer,
	`started_at` integer,
	`thumbnail_url` text,
	`url` text NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_streams_channel_idx` ON `live_streams` (`provider`,`provider_account_id`);
