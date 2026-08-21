-- The side column holds a list now, in the order you want them.
--
-- Backfilled from the single `dashboard_panel` so nobody loses the panel they
-- had. That column stays and is kept in step with the first entry: the PWA and
-- the server update independently, so an older bundle still reads one panel and
-- draws something rather than an empty column.
ALTER TABLE `settings` ADD `dashboard_panels` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `settings` SET `dashboard_panels` = '["' || `dashboard_panel` || '"]' WHERE `dashboard_panel` != '';
