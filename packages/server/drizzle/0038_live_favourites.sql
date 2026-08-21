-- Starred channels, and whether the Dashboard panel is narrowed to them.
--
-- `favourite` sits on `follows` rather than in its own table: `replaceFollows`
-- lists the columns it overwrites explicitly, so a sync leaves this alone, while
-- unfollowing prunes the row and takes the star with it — which is the right
-- answer rather than keeping a favourite for somebody you no longer follow.
--
-- `all` is the panel default, because one that starts empty until you have gone
-- and starred something looks broken.
ALTER TABLE `follows` ADD `favourite` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `live_panel_scope` text DEFAULT 'all' NOT NULL;
