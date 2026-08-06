CREATE TABLE `vault` (
	`id` text PRIMARY KEY NOT NULL,
	`kdf_salt` text NOT NULL,
	`kdf_version` integer DEFAULT 1 NOT NULL,
	`kdf_memory_kib` integer NOT NULL,
	`kdf_passes` integer NOT NULL,
	`kdf_parallelism` integer NOT NULL,
	`wrapped_by_password` text NOT NULL,
	`wrapped_by_recovery` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
