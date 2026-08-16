-- What sits in the Dashboard's side column, if anything.
--
-- An opaque id, never validated against a list: the panels worth having come
-- from features that can be deleted, and core checking the value against them
-- would be core depending on a feature. Empty means one column, which is the
-- default and what every existing install gets.
ALTER TABLE `settings` ADD `dashboard_panel` text DEFAULT '' NOT NULL;
