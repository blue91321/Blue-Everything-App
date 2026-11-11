-- How loud the app's own tones are, 0 to 100: a nudge arriving, voice
-- listening, a command working or missing. 50 by default, quieter than the
-- tones were before this column, which played as 100 does.
ALTER TABLE `settings` ADD `sound_volume` integer DEFAULT 50 NOT NULL;
