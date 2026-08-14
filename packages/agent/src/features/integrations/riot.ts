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
  avatarUrl?: string;
  state: 'offline' | 'online' | 'away' | 'in-game' | 'dnd';
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
  // Its own state rather than folded into `away`. In League it nearly always
  // means a match or champion select, and the `lol` block below upgrades those
  // to `in-game` anyway — what is left is somebody at the keyboard who has
  // asked not to be bothered, which is not the same as somebody idle.
  dnd: 'dnd',
  offline: 'offline',
};

/**
 * Is the League client actually vouching for this person?
 *
 * **`availability` alone says far more than it knows.** It answers "is this
 * account signed in to Riot somewhere", which is true of a launcher sitting on
 * the desktop and of the phone companion app, and it reports both as `chat` —
 * the same value somebody sitting in champion select gets. Measured against a
 * live list: six friends were `chat` with `productName: "Riot Client"` and no
 * League data at all, and were being shown as online.
 *
 * The `lol` block is the honest signal. The client fills it in for anybody it
 * can see a League session for and leaves it empty otherwise, so an empty one
 * means "signed in, but not here" — which covers the launcher and the phone
 * with one rule rather than a list of product names to keep up with.
 *
 * Those people are still *around*, so they are `away` rather than dropped:
 * "reachable, but not about to join a game" is exactly what `away` means here
 * and is what the phone companion app has always been mapped to.
 */
function inLeagueClient(friend: LcuFriend): boolean {
  return Object.keys(friend.lol ?? {}).length > 0;
}

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
  icon?: number;
  lol?: {
    gameStatus?: string;
    gameQueueType?: string;
    gameMode?: string;
    /** Arrives as a string, like everything else in this block. */
    queueId?: string;
    championId?: string;
  };
}

/**
 * `outOfGame` is the idle state; everything else is something happening.
 *
 * **`hosting_` is a prefix, not a value.** The set listed a literal
 * `hosting_GAME` that never appears — the real ones name the queue, so a live
 * list had `hosting_JADE_RANKED_SOLO_5x5` and `hosting_PVE_PUZZLE_TFT` and both
 * fell through to merely `online`. Hosting a lobby is being in a game as far as
 * this list is concerned: they have picked a queue and are waiting on players.
 */
const IN_GAME_STATUSES = new Set(['inGame', 'championSelect', 'inQueue']);

function isPlaying(status: string | undefined): boolean {
  if (status === undefined) return false;
  return IN_GAME_STATUSES.has(status) || status.startsWith('hosting_');
}

/**
 * Readable names for what the client reports as enums.
 *
 * `gameQueueType` and `gameMode` are internal identifiers and reach the screen
 * verbatim without this — a friend showed as playing **RANKED_SOLO_5x5**, and
 * another as **CHERRY**, which is Riot's internal name for Arena and means
 * nothing to anybody.
 *
 * **This is the fallback, not the answer.** The client publishes the real names
 * itself and they are better than any table kept here: of seven friends in a
 * game while this was written, a hand-written table got two wrong — `KIWI` is
 * "ARAM: Mayhem" and queue 1740 is "Bravery Arena" specifically, not Arena. So
 * `loadQueues` asks, and this is only reached when it could not. Anything
 * unlisted falls through to the game's name rather than being guessed at, since
 * a wrong label is worse than a general one.
 */
const QUEUE_NAMES: Record<string, string> = {
  RANKED_SOLO_5x5: 'Ranked Solo/Duo',
  RANKED_FLEX_SR: 'Ranked Flex',
  RANKED_TFT: 'Ranked TFT',
  RANKED_TFT_DOUBLE_UP: 'TFT Double Up',
  RANKED_TFT_TURBO: 'TFT Hyper Roll',
  NORMAL: 'Normal',
  NORMAL_5V5_BLIND_PICK: 'Normal Blind',
  NORMAL_5V5_DRAFT_PICK: 'Normal Draft',
  ARAM_UNRANKED_5x5: 'ARAM',
  BOT: 'Co-op vs AI',
  BOT_5x5: 'Co-op vs AI',
};

const MODE_NAMES: Record<string, string> = {
  CLASSIC: "Summoner's Rift",
  ARAM: 'ARAM',
  CHERRY: 'Arena',
  STRAWBERRY: 'Swarm',
  TFT: 'Teamfight Tactics',
  URF: 'URF',
  NEXUSBLITZ: 'Nexus Blitz',
  ONEFORALL: 'One for All',
  PRACTICETOOL: 'Practice Tool',
  TUTORIAL: 'Tutorial',
};

interface LcuQueue {
  id?: number;
  name?: string;
  shortName?: string;
}

/**
 * The client's own queue table, fetched once per client session.
 *
 * Keyed on the port because a new port means the client restarted, which is the
 * only moment this could have changed — a patch adds modes, and the list is
 * otherwise fixed for as long as League is open. It is ~150KB, so fetching it
 * on every 30s poll would be absurd for something that cannot move.
 *
 * Best-effort throughout: a client that will not answer this still has a
 * perfectly good friends list, and `QUEUE_NAMES` covers the common modes
 * meanwhile. Losing the whole list over a nicer label would be a poor trade.
 */
const queueCache = new Map<number, Map<number, string>>();

async function loadQueues(lock: Lock): Promise<Map<number, string>> {
  const cached = queueCache.get(lock.port);
  if (cached) return cached;

  const names = new Map<number, string>();
  try {
    for (const queue of await lcuGet<LcuQueue[]>(lock, '/lol-game-queues/v1/queues', 5000)) {
      const label = queue.shortName || queue.name;
      if (queue.id !== undefined && label) names.set(queue.id, label);
    }
  } catch {
    // Starting up, or the endpoint has moved. The fallback table applies, and
    // the next client session tries again.
  }

  // Cached even when empty, so a client that has no such endpoint is not asked
  // every thirty seconds forever.
  queueCache.set(lock.port, names);
  return names;
}

/**
 * What to call what they are playing.
 *
 * The queue is more specific than the mode ("Ranked Solo/Duo" beats "Summoner's
 * Rift"), so it is preferred where it is named. **These arrive as empty strings
 * rather than absent** when the client has no answer, which is why this tests
 * for truthiness — `??` treats `''` as a perfectly good value and let an empty
 * label win over the fallback, putting friends on screen playing nothing at all.
 */
function gameLabel(friend: LcuFriend, queues: Map<number, string>): string {
  const queueId = Number(friend.lol?.queueId);
  const live = Number.isInteger(queueId) ? queues.get(queueId) : undefined;
  if (live) return live;

  const queue = friend.lol?.gameQueueType;
  if (queue && QUEUE_NAMES[queue]) return QUEUE_NAMES[queue];

  const mode = friend.lol?.gameMode;
  if (mode && MODE_NAMES[mode]) return MODE_NAMES[mode];

  return friend.productName || 'League of Legends';
}

/**
 * The summoner icon, from Community Dragon.
 *
 * Riot serves no avatar URL — the client ships the images and reports only an
 * icon id. Community Dragon is the long-standing public mirror of exactly those
 * assets, and it is the same arrangement Steam and Discord avatars already
 * arrive under: a URL the browser fetches, never anything this app stores.
 * A missing or zero id yields nothing rather than a broken image.
 */
function iconUrl(icon: number | undefined): string | undefined {
  if (!icon || icon < 0) return undefined;
  return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${icon}.jpg`;
}

export async function readFriends(lock: Lock): Promise<RiotFriend[]> {
  const raw = await lcuGet<LcuFriend[]>(lock, '/lol-chat/v1/friends');
  const queues = await loadQueues(lock);

  return raw.map((friend) => {
    const said = AVAILABILITY[friend.availability ?? 'offline'] ?? 'offline';
    const playing = said !== 'offline' && isPlaying(friend.lol?.gameStatus);

    /*
     * `online` has to be earned; `offline` and `away` are taken as given.
     *
     * Demoting rather than overriding, so this can only ever make a claim
     * weaker. Somebody the client reports as away is away whatever else is
     * true, and somebody it cannot see in League is at most away — which is the
     * whole fix. Only the strongest state, "online right now", requires the
     * client to actually have League data for them.
     */
    const state = said === 'online' && !inLeagueClient(friend) ? 'away' : said;

    return {
      // `puuid` is the stable one. `summonerId` is per-region and `name` is
      // changeable, so either would eventually re-key somebody as a new person.
      providerUserId: friend.puuid ?? friend.id ?? String(friend.summonerId ?? friend.name ?? 'unknown'),
      name: friend.gameName ? `${friend.gameName}${friend.gameTag ? `#${friend.gameTag}` : ''}` : friend.name ?? 'Unknown',
      avatarUrl: iconUrl(friend.icon),
      state: playing ? 'in-game' : state,
      game: playing ? gameLabel(friend, queues) : undefined,
      // The personal note people set on themselves. Shown as detail, never as
      // the game — it is free text and frequently a joke.
      detail: friend.note || undefined,
    };
  });
}
