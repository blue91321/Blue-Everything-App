-- Canvas: coursework as tasks.
--
-- `source` and `source_url` are on `tasks` rather than in the integrations
-- feature because they are facts about the task — where it came from, and where
-- to go and look at it. Opaque slugs, never validated against the provider list:
-- that list lives in a deletable folder and core must not depend on it.
ALTER TABLE `tasks` ADD `source` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `source_url` text;--> statement-breakpoint

-- Which installation to talk to, for a service that is not one address.
ALTER TABLE `integration_accounts` ADD `base_url` text;--> statement-breakpoint

-- The record that an item has already been turned into a task, which has to
-- outlive the task itself: dedupe by looking for the task would recreate one you
-- deliberately deleted, on the very next sync.
CREATE TABLE `integration_task_links` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`task_id` text,
	`last_due_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_task_links_idx` ON `integration_task_links` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `integration_task_links_task_idx` ON `integration_task_links` (`task_id`);
