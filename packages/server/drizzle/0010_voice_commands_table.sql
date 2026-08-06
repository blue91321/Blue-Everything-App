CREATE TABLE `voice_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`phrases` text DEFAULT '[]' NOT NULL,
	`target` text,
	`pause_minutes` integer,
	`label` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `voice_commands_enabled_idx` ON `voice_commands` (`enabled`);--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_paused_until` integer;--> statement-breakpoint
INSERT INTO `voice_commands` (`id`, `kind`, `phrases`, `target`, `sort_order`, `created_at`, `updated_at`)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  'habit',
  `voice_phrases`,
  `id`,
  `sort_order`,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `habits`
WHERE `voice_phrases` IS NOT NULL AND `voice_phrases` <> '[]' AND `voice_phrases` <> '';
