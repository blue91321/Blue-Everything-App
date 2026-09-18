-- Folders that exist before anything is in them.
--
-- Until now a folder was purely a path prefix on notes, which meant an empty one
-- could not exist: "New folder" would have had nothing to create. This records
-- the ones made by hand, and `folderTree` unions them with the derived ones — so
-- a folder you make stays until you remove it, and one that appears because a
-- note is filed there still needs no row.
CREATE TABLE `note_folders` (
	`path` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
