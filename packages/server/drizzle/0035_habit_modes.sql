-- Two more shapes a habit can take, beside "N times a day".
--
-- `interval` is due again a fixed time after the last tick; `gauge` is a level
-- that drains and is topped up by doing the thing. Everything already here is
-- `target`, which is the default, so no existing habit changes behaviour.
ALTER TABLE `habits` ADD `mode` text DEFAULT 'target' NOT NULL;--> statement-breakpoint
ALTER TABLE `habits` ADD `interval_minutes` integer;--> statement-breakpoint

-- The gauge is stored as an anchor — a level, and when that level was true —
-- so it drains without anything running on a timer. 0 for `gauge_level_at` is
-- fine for every existing row: they are all `target` mode and nothing reads it,
-- and switching one to `gauge` re-anchors it on the way through.
ALTER TABLE `habits` ADD `gauge_level` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `habits` ADD `gauge_level_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `habits` ADD `gauge_drain_per_day` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `habits` ADD `gauge_fill_percent` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `habits` ADD `gauge_shape` text DEFAULT 'circle' NOT NULL;
