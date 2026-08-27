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

/**
 * Folders that only ever contain games.
 *
 * Matched against the executable's full path, and it is by far the strongest
 * signal available — far better than anything about the window, because it is
 * true whether the game is fullscreen, borderless, or in a little window in the
 * corner of the screen.
 *
 * Written with forward slashes and matched against a normalised path, so the
 * source carries no backslash escaping to get wrong.
 *
 * Deliberately unambiguous entries only. `Battle.net/` is the launcher's own
 * folder rather than where Blizzard games install, and `WindowsApps/` holds
 * every Store app including Notepad. A marker that catches non-games is worse
 * than one that misses games: a wrongly detected "game" silently holds your
 * reminders back, and nobody would think to blame this list for that.
 */
const LIBRARY_MARKERS = [
  '/steamapps/common/',
  '/epic games/',
  '/gog galaxy/games/',
  '/gog games/',
  '/riot games/',
  '/xboxgames/',
  '/xbox games/',
  '/origin games/',
  '/ea games/',
  '/ubisoft game launcher/games/',
];

/**
 * Does this executable live somewhere only games live?
 *
 * Decides whether a newly discovered app is treated as a game outright or merely
 * listed for you to say. Covering the screen gets it onto the list; the path is
 * what switches it on.
 */
export function looksLikeGameInstall(exePath: string): boolean {
  if (!exePath) return false;
  // `split` on a one-character string rather than a regex, so this file carries
  // exactly one escaped backslash and no character class to get wrong.
  const path = exePath.toLowerCase().split(String.fromCharCode(92)).join('/');
  return LIBRARY_MARKERS.some((marker) => path.includes(marker));
}

/**
 * Folders that never contain a game, whatever their windows look like.
 *
 * The counterpart to the markers above, and it exists because of one specific
 * report: **`explorer.exe` was listed as having filled the screen.** The desktop
 * *is* a window covering its whole monitor — that is what a desktop is — and it
 * becomes the foreground window every time you alt-tab out of a game or minimise
 * everything, so the geometry check was right and the conclusion was absurd.
 *
 * Only `C:/Windows/` is here, and the omission that matters is
 * `WindowsApps/`: every Game Pass title installs there alongside Notepad, so
 * excluding it would hide a whole library to be rid of a text editor. This list
 * stops something being a *candidate* at all, which is a stronger claim than
 * `LIBRARY_MARKERS` makes and has to be earned by the folder being unambiguous.
 */
const SYSTEM_MARKERS = ['/windows/system32/', '/windows/syswow64/', '/windows/explorer.exe'];

/**
 * Is this the operating system rather than something you ran?
 *
 * Checked before anything else, because a system component covering the screen
 * is the shell drawing the desktop rather than an app taking it over.
 */
export function looksLikeSystemApp(exePath: string): boolean {
  if (!exePath) return false;
  const path = exePath.toLowerCase().split(String.fromCharCode(92)).join('/');
  return SYSTEM_MARKERS.some((marker) => path.includes(marker));
}
