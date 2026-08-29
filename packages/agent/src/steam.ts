/**
 * Finding the Steam app id for a game already running on this PC.
 *
 * Reported from real use: `"start warframe"` launched `Warframe.x64.exe` and
 * got **"start warframe from launcher"** back. Plenty of Steam games are a thin
 * binary behind a launcher that expects Steam to have set things up first, so
 * the executable is the wrong thing to run even though it is the thing that was
 * running when we saw it.
 *
 * What works is what the desktop shortcut holds — `steam://rungameid/230410` —
 * and the app id in it is not derivable from the path. It is, however, sitting
 * right next to the game: Steam writes an `appmanifest_<appid>.acf` per install
 * into the library's `steamapps` folder, and each one records the `installdir`,
 * which *is* the folder name in the path.
 *
 * So the mapping is: the folder name in `steamapps/common/<here>/game.exe` finds
 * the manifest whose `installdir` matches it, and that manifest carries the app
 * id.
 *
 * **The agent does this, not the server.** It is a question about files on this
 * machine, which is the same division voice and the Riot presence reader draw:
 * the server owns the database and is meant to be movable, and a `steamapps`
 * folder is not something it should assume exists beside it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { steamInstallOf, steamLaunchUrl } from '@everything/shared/games';

/**
 * What each library folder holds, keyed by `steamapps` path.
 *
 * Manifests change only when something is installed or removed, and this is
 * consulted from the attention heartbeat — so reading a directory every few
 * seconds for an answer that is the same all week would be exactly the cost the
 * attention loop was tuned to avoid. Cleared on a miss, so a game installed
 * while the agent runs is found on the next look rather than after a restart.
 */
const cache = new Map<string, Map<string, string>>();

/**
 * `installdir` → app id for one library folder.
 *
 * The `.acf` format is Valve's own key-value text, and this reads it with a
 * regex rather than parsing it — the same call `zip.ts` makes about the zip
 * format. Two quoted strings on a line is the whole of what is needed, and a
 * parser for the rest would be code to trust for no gain.
 */
function manifestsIn(steamapps: string): Map<string, string> {
  const cached = cache.get(steamapps);
  if (cached) return cached;

  const found = new Map<string, string>();
  try {
    for (const name of readdirSync(steamapps)) {
      if (!name.startsWith('appmanifest_') || !name.endsWith('.acf')) continue;
      try {
        const text = readFileSync(join(steamapps, name), 'utf8');
        const appId = /"appid"\s+"(\d+)"/i.exec(text)?.[1];
        const installDir = /"installdir"\s+"([^"]+)"/i.exec(text)?.[1];
        // Both or neither: an id with nothing to match it against is unusable,
        // and a folder with no id cannot become a URL.
        if (appId && installDir) found.set(installDir.toLowerCase(), appId);
      } catch {
        // One unreadable manifest must not cost the whole library — a game
        // mid-install writes these, and a partial file is expected rather than
        // exceptional.
      }
    }
  } catch {
    // Not a Steam library, or not readable. Either way there is nothing here.
    return found;
  }

  cache.set(steamapps, found);
  return found;
}

/**
 * The `steam://` address that starts the game installed at this path, if any.
 *
 * Null for anything that is not under a Steam library, which is the ordinary
 * case for most of the list — those launch by path exactly as before.
 */
export function steamUrlFor(exePath: string): string | null {
  const install = steamInstallOf(exePath);
  if (!install) return null;

  const appId = manifestsIn(install.steamapps).get(install.installDir.toLowerCase());
  if (appId) return steamLaunchUrl(appId);

  // A game installed since this folder was last read. Dropping the entry costs
  // one directory listing and means the next poll finds it, rather than the URL
  // never appearing until the agent restarts.
  cache.delete(install.steamapps);
  return null;
}
