-- The menu drawer: when it docks itself, and whether it starts docked.
--
-- 1200 rather than the 900 that was hard-coded: 900 was "is there room for a
-- drawer beside the content", answered for a task list. A screen with three
-- columns of its own is squeezed long before that, so the honest default is
-- higher and the number is yours either way.
ALTER TABLE `settings` ADD `drawer_breakpoint` integer DEFAULT 1200 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `drawer_docked` integer DEFAULT 1 NOT NULL;
