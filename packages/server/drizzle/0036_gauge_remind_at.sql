-- The level at which a gauge starts asking, rather than only at empty.
--
-- 0 is the default and is exactly the old behaviour, so no existing gauge
-- changes when it wants doing.
ALTER TABLE `habits` ADD `gauge_remind_at` integer DEFAULT 0 NOT NULL;
