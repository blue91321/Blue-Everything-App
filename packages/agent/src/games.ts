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
 * Apply what the server says, on top of the shipped list.
 *
 * **Not a replacement**, which it was for about ten minutes and which deadlocked
 * the whole feature: the server's table starts empty, so "watch exactly these"
 * meant watch nothing, so nothing was ever detected to fill the table.
 *
 * The shipped names stay as *recognition* — how a game is known the first time
 * it runs — and the server only overrides: `extra` adds names it has learned or
 * you typed, `off` removes ones the screen has unticked. Nothing about the
 * shipped list reaches a screen unless it actually ran here.
 */
export function applyServerGames(extra: readonly string[], off: readonly string[]): void {
  extraGames.clear();
  suppressed.clear();
  for (const name of extra) {
    const normalised = name.trim().toLowerCase();
    if (normalised) extraGames.add(normalised);
  }
  for (const name of off) {
    const normalised = name.trim().toLowerCase();
    if (normalised) suppressed.add(normalised);
  }
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
