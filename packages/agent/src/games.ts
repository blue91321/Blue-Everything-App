/**
 * Which executables mean "do not interrupt", and which only look like they do.
 *
 * The launcher list matters as much as the game list: `LeagueClientUx.exe` is
 * the lobby, which is the *best* time to interrupt, while
 * `League of Legends.exe` is a live match. Same brand, opposite answers.
 */

/** A live match / session is in progress whenever one of these is running. */
export const GAME_PROCESSES = new Set([
  'league of legends.exe',
  'valorant-win64-shipping.exe',
  'cs2.exe',
  'dota2.exe',
  'deadlock.exe',
  'overwatch.exe',
  'r5apex.exe',
  'destiny2.exe',
  'fortniteclient-win64-shipping.exe',
  'rocketleague.exe',
  'marvel-win64-shipping.exe',
  'helldivers2.exe',
  'palworld-win64-shipping.exe',
  'eldenring.exe',
  'gta5.exe',
  'rdr2.exe',
]);

/** Storefronts and lobbies — running these is a green light, not a red one. */
export const LAUNCHER_PROCESSES = new Set([
  'leagueclientux.exe',
  'leagueclient.exe',
  'riotclientux.exe',
  'riotclientservices.exe',
  'steam.exe',
  'steamwebhelper.exe',
  'epicgameslauncher.exe',
  'battle.net.exe',
  'ealauncher.exe',
  'galaxyclient.exe',
]);

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

export const isGame = (exe: string): boolean => {
  const name = exe.toLowerCase();
  return GAME_PROCESSES.has(name) || extraGames.has(name);
};

export const isLauncher = (exe: string): boolean => LAUNCHER_PROCESSES.has(exe.toLowerCase());
