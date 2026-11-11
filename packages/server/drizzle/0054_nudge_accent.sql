-- A colour of its own for a nudge's popup title, `#rrggbb`, set by a
-- blueprint's "Nudge me". Null is the app's accent, which every other nudge
-- keeps. The phone's notification has no colour to give it.
ALTER TABLE `nudges` ADD `accent` text;
