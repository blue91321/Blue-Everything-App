-- Games this machine has actually seen, and what to do about each.
--
-- Until now the game list was a constant in `games.ts` plus an `extraGames`
-- array in the agent's own config file, so adding one meant editing a file on
-- the PC by hand — and an app that grabbed exclusive fullscreen was written to
-- the console and nowhere else. Neither is reachable from the phone, and the
-- console line was the only evidence a game existed at all.
--
-- Rows are created by the agent reporting what it sees, so the list is a record
-- of this machine rather than a list somebody has to keep up to date.
CREATE TABLE `games` (
  `exe` text PRIMARY KEY NOT NULL,
  -- What to call it on screen. Seeded from the executable and editable, because
  -- `fortniteclient-win64-shipping.exe` is not what anybody calls that.
  `label` text NOT NULL,
  -- Treat it as a game at all. Off makes it an ordinary app again, which is the
  -- fix when something is detected that merely happened to go fullscreen.
  `is_game` integer DEFAULT 1 NOT NULL,
  -- Let nudges through while it is running. Null follows the global setting —
  -- the same three-state arrangement `push_to_phone` uses, and for the same
  -- reason: stamping every row with the default would make changing the default
  -- later leave every existing game answering the old question.
  `allow_interruptions` integer,
  -- Where to launch it from, when it is known. Filled in by hand or by a voice
  -- command that wants to open it.
  `launch_path` text,
  -- How it came to be here: `builtin` (shipped list), `seen` (running process),
  -- `fullscreen` (grabbed exclusive fullscreen), or `manual`.
  `source` text DEFAULT 'seen' NOT NULL,
  `first_seen_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL
);--> statement-breakpoint
-- Detection as a whole, and whether a game blocks nudges by default.
ALTER TABLE `settings` ADD `game_detection_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `interrupt_during_games` integer DEFAULT 0 NOT NULL;
