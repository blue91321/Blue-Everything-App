import { BUILTIN_GAMES, BUILTIN_LAUNCHERS } from '@everything/shared/games';
/**
 * Which executables mean "do not interrupt", and which only look like they do.
 *
 * The launcher list matters as much as the game list: `LeagueClientUx.exe` is
 * the lobby, which is the *best* time to interrupt, while
 * `League of Legends.exe` is a live match. Same brand, opposite answers.
 */

/** A live match / session is in progress whenever one of these is running. */
export const GAME_PROCESSES = new Set(BUILTIN_GAMES);

/** Storefronts and lobbies — running these is a green light, not a red one. */
export const LAUNCHER_PROCESSES = new Set(BUILTIN_LAUNCHERS);

/**
 * Games added at runtime from config, so the built-in list above doesn't have
 * to be exhaustive and adding a game never means editing source.
 */
const extraGames = new Set<string>();

export function registerExtraGames(names: readonly string[]): void {
  for (const name of names) {
    const normalised = name.trim().toLowerCase();
    if (normalised) extraGames.add(normalised);
  }
}

/**
 * Replace the list outright, rather than adding to it.
 *
 * The server owns this now — it is a table the Games screen edits — so a
 * *merge* would make unticking something on that screen have no effect until
 * the agent restarted, which is precisely the kind of change that looks like it
 * saved and did not.
 *
 * The shipped `GAME_PROCESSES` set is still consulted, so a fresh install knows
 * what League is before it has ever seen it run. Unticking one of those is what
 * `SUPPRESSED` is for.
 */
export function replaceKnownGames(names: readonly string[]): void {
  extraGames.clear();
  suppressed.clear();
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  for (const name of wanted) extraGames.add(name);
  // Anything the shipped list calls a game but the server does not: the screen
  // said no, and the screen wins.
  for (const name of GAME_PROCESSES) if (!wanted.has(name)) suppressed.add(name);
}

/** Shipped games the server's list has switched off. */
const suppressed = new Set<string>();

/**
 * Detection as a whole.
 *
 * Off makes `isGame` answer false for everything, so the monitor never reports
 * `in-game` and a match reads as ordinary use. The server also neutralises the
 * state on its side; this stops the agent doing the work at all.
 */
let detecting = true;

export function setGameDetection(enabled: boolean): void {
  detecting = enabled;
}

export const isGame = (exe: string): boolean => {
  if (!detecting) return false;
  const name = exe.toLowerCase();
  if (suppressed.has(name)) return false;
  return GAME_PROCESSES.has(name) || extraGames.has(name);
};

export const isLauncher = (exe: string): boolean => LAUNCHER_PROCESSES.has(exe.toLowerCase());
