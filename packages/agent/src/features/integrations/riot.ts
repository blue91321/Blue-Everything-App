/**
 * The League client's friends list, read off this PC.
 *
 * Riot publishes no friends or presence API. What exists is the **LCU** — the
 * loopback HTTPS server the League client runs to talk to its own interface.
 * It is not a documented public API and Riot could change it tomorrow, which is
 * exactly why this file is small, defensive, and reports its own failures
 * rather than throwing them at the agent.
 *
 * How it is reached:
 *
 *   1. The client writes a `lockfile` next to its executable while it runs, of
 *      the form `LeagueClient:<pid>:<port>:<password>:https`. It is deleted on
 *      exit, so its presence is also the liveness check.
 *   2. Requests go to `https://127.0.0.1:<port>` with HTTP Basic auth as
 *      `riot:<password>`.
 *   3. The certificate is Riot's own self-signed one, so verification has to be
 *      switched off — see the note on that below, because it is the one thing
 *      here that would be alarming without an explanation.
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';

export interface RiotFriend {
  providerUserId: string;
  name: string;
  state: 'offline' | 'online' | 'away' | 'in-game';
  game?: string;
  detail?: string;
}

/**
 * Where the lockfile lives.
 *
 * The install path is configurable, so the common locations are tried in order
 * rather than one being assumed. `LOCALAPPDATA\Riot Games\Riot Client\Config`
 * is where the newer Riot Client keeps its own; the game's own directory is
 * where League's has always been.
 */
const LOCKFILE_PATHS = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Riot Games', 'League of Legends', 'lockfile'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Riot Games', 'League of Legends', 'lockfile'),
  join('C:\\Riot Games', 'League of Legends', 'lockfile'),
  join(process.env.LOCALAPPDATA ?? '', 'Riot Games', 'Riot Client', 'Config', 'lockfile'),
];

interface Lock {
  port: number;
  password: string;
}

/**
 * Read the lockfile, if the client is running.
 *
 * Null means "not running", and that is the only thing a missing lockfile can
 * mean — the client removes it on exit. A read that fails for any other reason
 * is also reported as not running, because a lockfile we cannot read is a
 * client we cannot talk to and the distinction changes nothing downstream.
 */
export function readLock(): Lock | null {
  for (const path of LOCKFILE_PATHS) {
    if (!existsSync(path)) continue;

    try {
      const parts = readFileSync(path, 'utf8').trim().split(':');
      // name:pid:port:password:protocol — anything shorter is a partial write,
      // which does happen if this lands in the moment the client is starting.
      if (parts.length < 5) continue;

      const port = Number(parts[2]);
      if (!Number.isInteger(port) || port <= 0) continue;

      return { port, password: parts[3] };
    } catch {
      // Locked by the client mid-write. The next poll will get it.
    }
  }

  return null;
}

/**
 * A GET against the LCU.
 *
 * `node:https` rather than `fetch`, for one reason: **the certificate is
 * self-signed and verification has to be off**, and `rejectUnauthorized` is a
 * plain option here while doing the same through `fetch` means constructing an
 * undici dispatcher.
 *
 * Switching off TLS verification is normally a serious thing to do, so it is
 * worth being precise about why it is not here. The connection is to
 * `127.0.0.1` on a port named by a file that only a process running as this
 * user could have written, authenticated with a password from that same file.
 * There is no network path to man-in-the-middle: an attacker able to sit
 * between this process and loopback is already inside the machine. The
 * certificate would add nothing, and Riot does not offer a verifiable one.
 */
function lcuGet<T>(lock: Lock, path: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: lock.port,
        path,
        method: 'GET',
        rejectUnauthorized: false,
        headers: {
          authorization: `Basic ${Buffer.from(`riot:${lock.password}`).toString('base64')}`,
          accept: 'application/json',
        },
        timeout: timeoutMs,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            return reject(new Error(`League client returned ${response.statusCode} for ${path}`));
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            reject(new Error(`League client sent something that is not JSON for ${path}`));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('League client did not answer in time')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * The client's own vocabulary for availability.
 *
 * `mobile` is someone signed in on the companion app — reachable, but not about
 * to join a game, which is what `away` means here. `dnd` in League is nearly
 * always "in champion select or a match", and the `lol` block below usually
 * upgrades it to `in-game` anyway.
 */
const AVAILABILITY: Record<string, RiotFriend['state']> = {
  chat: 'online',
  online: 'online',
  away: 'away',
  mobile: 'away',
  dnd: 'away',
  offline: 'offline',
};

interface LcuFriend {
  puuid?: string;
  id?: string;
  summonerId?: number;
  name?: string;
  gameName?: string;
  gameTag?: string;
  availability?: string;
  note?: string;
  productName?: string;
  lol?: { gameStatus?: string; gameQueueType?: string; championId?: string };
}

/** `outOfGame` is the idle state; everything else is something happening. */
const IN_GAME_STATUSES = new Set(['inGame', 'championSelect', 'inQueue', 'hosting_GAME']);

export async function readFriends(lock: Lock): Promise<RiotFriend[]> {
  const raw = await lcuGet<LcuFriend[]>(lock, '/lol-chat/v1/friends');

  return raw.map((friend) => {
    const state = AVAILABILITY[friend.availability ?? 'offline'] ?? 'offline';
    const status = friend.lol?.gameStatus;
    const playing = state !== 'offline' && status !== undefined && IN_GAME_STATUSES.has(status);

    return {
      // `puuid` is the stable one. `summonerId` is per-region and `name` is
      // changeable, so either would eventually re-key somebody as a new person.
      providerUserId: friend.puuid ?? friend.id ?? String(friend.summonerId ?? friend.name ?? 'unknown'),
      name: friend.gameName ? `${friend.gameName}${friend.gameTag ? `#${friend.gameTag}` : ''}` : friend.name ?? 'Unknown',
      state: playing ? 'in-game' : state,
      game: playing ? friend.lol?.gameQueueType ?? friend.productName ?? 'League of Legends' : undefined,
      // The personal note people set on themselves. Shown as detail, never as
      // the game — it is free text and frequently a joke.
      detail: friend.note || undefined,
    };
  });
}
