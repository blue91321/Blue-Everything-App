/**
 * Which executables mean "do not interrupt", and which only look like they do.
 *
 * **In `shared` rather than in the agent, and that is load-bearing.** The server
 * seeds its `games` table from this at boot, and the agent watches for whatever
 * the server then says — so if only the agent knew the list, a fresh install
 * would start with an empty table, the agent would be told to watch nothing, and
 * nothing would ever be detected to fill the table. That deadlock shipped for
 * about ten minutes and reported itself as `watching 0 games`.
 *
 * The launcher list matters as much as the game list: `LeagueClientUx.exe` is
 * the lobby, which is the *best* time to interrupt, while
 * `League of Legends.exe` is a live match. Same brand, opposite answers.
 */
export const BUILTIN_GAMES: string[] = [
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
];

/** Storefronts and lobbies — running these is a green light, not a red one. */
export const BUILTIN_LAUNCHERS: string[] = [
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
];

