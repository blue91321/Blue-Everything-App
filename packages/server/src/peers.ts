/**
 * Linked servers: two people's own Blue Everything servers, on two PCs, that
 * have agreed to share with each other (2026-11-21). Not a friend's copy on
 * this PC (`instances.ts`), which shares this server's Suwayomi and disk: a
 * linked server is somebody else's whole install, with its own everything, on
 * the other side of Tailscale.
 *
 * Core holds only the link: who, where, the two keys and what this side shares.
 * What is shared is the packages' to say (the manga package's Local collection,
 * chapter catalogue and ratings), under `/api/peer/<package>/`.
 *
 * ### The rules, chosen with security first
 *
 * - **Tailscale only.** A linked server's address must be `https://…ts.net`:
 *   reached over the tailnet, by node sharing between two tailnets, never the
 *   public internet, and nothing opened on a router. This server listens on
 *   127.0.0.1 and is reached only through `tailscale serve`, which is https.
 * - **Both sides on purpose.** One side makes a link code (single use, a day,
 *   kept only as a hash); the other pastes it into their own server. Pasting it
 *   is the second yes: their server mints a key for this one and sends it with
 *   the code, and this one answers with a key for theirs. A key each way.
 * - **A linked server's key opens `/api/peer/` and nothing else**
 *   (`PEER_PREFIX`, enforced in `authenticate`), at most `PEER_PER_MINUTE`
 *   requests a minute. Never Suwayomi, extensions, settings, devices or data.
 *   Each route under it checks what this side has chosen to share with that
 *   server (`share`), and answers read-only.
 * - **Either side can unlink**: its key is revoked and the other side is told,
 *   so its key here goes too. A link the other side cannot be told about is
 *   still gone from here; the key it holds is refused from then on.
 * - **Nothing they send is trusted as more than data.** Their address is held
 *   to the same shape on every call, redirects are refused, and answers are
 *   capped in size (`peerFetch`).
 *
 * Kept in `data/peers.json`, with the key this side shows the other in it, as a
 * copy's `host-key` is kept: a server cannot ask a person for a password at
 * three in the morning when it fetches a page.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db/client.js';
import { devices } from './db/schema.js';
import { hashToken } from './auth.js';
import { config, isGuest } from './config.js';
import { dataDir } from './paths.js';
import { writeFileAtomic } from './atomic-write.js';
import { tailscale, tailnetName } from './tailscale.js';
import { ownName } from './names.js';
import { changes } from './events.js';
import { VERSION } from './version.js';

/**
 * The only routes a linked server's key opens (`PEER_PREFIX`); the one of them
 * that answers without a key, pasting a link code (`PEER_LINK_PATH`); and a
 * linked server's requests a minute, each (`PEER_PER_MINUTE`: a chapter read
 * quickly is fifty, a copy is paced well under). Enforced in `authenticate`.
 */
import { PEER_LINK_PATH, PEER_PREFIX } from './auth.js';
export { PEER_LINK_PATH, PEER_PER_MINUTE, PEER_PREFIX } from './auth.js';

const FILE = () => resolve(dataDir, 'peers.json');
/** How long a link code works. */
const CODE_MS = 24 * 60 * 60_000;

/** What one side shares with the other. Each side sets its own; neither can set the other's. */
export interface PeerShare {
  /** Its Local collection: the series, their kept chapters, their pages, to read. */
  collection: boolean;
  /** Copying from it into their own Local collection, not only reading. */
  copy: boolean;
  /** The chapter catalogue: which sources have which series, and how many chapters each copy has. */
  catalogue: boolean;
  /** Ratings. Off unless chosen, as with friends' copies: what you thought of something is yours. */
  ratings: boolean;
}
export const DEFAULT_SHARE: PeerShare = { collection: true, copy: true, catalogue: true, ratings: false };
const SHARE_KEYS = Object.keys(DEFAULT_SHARE) as (keyof PeerShare)[];

export interface PeerLink {
  /** This side's name for the link, in addresses: eight hex characters. */
  id: string;
  /** What they are called, as their server last said. */
  name: string;
  /** Their server: `https://<machine>.<tailnet>.ts.net[:port]`. */
  url: string;
  /** The key their server gave this one, shown with every request to them. */
  key: string;
  /** The device on this side whose key they hold. Revoked to unlink. */
  deviceId: string;
  linkedAt: number;
  /** What this side shares with them. */
  share: PeerShare;
  /** What they share with this side, as they last said, and when. */
  theirs: { share: PeerShare; version: string | null; at: number } | null;
  /** Why asking them last failed, or null. */
  problem: string | null;
  checkedAt: number | null;
}

interface Stored {
  links: PeerLink[];
  codes: Array<{ hash: string; expiresAt: number }>;
}

function readStore(): Stored {
  try {
    const raw = JSON.parse(readFileSync(FILE(), 'utf8').replace(/^﻿/, '')) as Partial<Stored>;
    return {
      links: Array.isArray(raw.links) ? raw.links.map((l) => ({ ...l, share: cleanShare(l.share) })) : [],
      codes: Array.isArray(raw.codes) ? raw.codes.filter((c) => typeof c?.hash === 'string' && typeof c?.expiresAt === 'number') : [],
    };
  } catch {
    return { links: [], codes: [] };
  }
}

function writeStore(store: Stored): void {
  writeFileAtomic(FILE(), JSON.stringify(store, null, 2));
}

function cleanShare(value: unknown, base: PeerShare = DEFAULT_SHARE): PeerShare {
  const v = (value ?? {}) as Partial<Record<keyof PeerShare, unknown>>;
  const out = { ...base };
  for (const k of SHARE_KEYS) if (typeof v[k] === 'boolean') out[k] = v[k] as boolean;
  return out;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/* ---- addresses ------------------------------------------------------ */

/**
 * A linked server's address, held to one shape: `https://`, a name under
 * `.ts.net` (MagicDNS, which every tailnet has and only a tailnet has), an
 * optional port, nothing else. Null for anything else. With
 * `PEERS_ALLOW_LOOPBACK` (`peer-check` only) `http://127.0.0.1:<port>` too.
 */
export function cleanPeerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash.length > 1) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (config.PEERS_ALLOW_LOOPBACK && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port) {
    return `http://127.0.0.1:${url.port}`;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(host)) return null;
  // At least machine.tailnet.ts.net: `ts.net` itself and `x.ts.net` are not a tailnet's machine.
  if (host.split('.').length < 4) return null;
  return `https://${host}${url.port && url.port !== '443' ? `:${url.port}` : ''}`;
}

/**
 * This server's own address on the tailnet, as `tailscale serve` publishes it:
 * the entry whose proxy is this server's port. Null when Tailscale is not
 * running or is not publishing this server, which is what the screen says to
 * fix before a link can be made.
 */
export async function ownPeerUrl(): Promise<string | null> {
  if (config.PEERS_ALLOW_LOOPBACK) return `http://127.0.0.1:${config.PORT}`;
  const raw = await tailscale(['serve', 'status', '--json']);
  if (raw) {
    try {
      const status = JSON.parse(raw) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
      for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
        const proxies = Object.values(web.Handlers ?? {}).map((h) => h.Proxy ?? '');
        if (proxies.some((p) => new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost):${config.PORT}/?$`).test(p))) {
          return cleanPeerUrl(`https://${hostPort}`);
        }
      }
    } catch {
      // Fall through: not publishing, as far as can be told.
    }
  }
  return null;
}

/** What this server is called to a linked one: the name chosen, or its machine's. */
async function ownLabel(): Promise<string> {
  const chosen = ownName();
  if (chosen) return chosen;
  const machine = (await tailnetName())?.split('.')[0];
  return machine || 'Blue Everything';
}

const cleanLabel = (value: unknown): string => {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
  return text.slice(0, 40) || 'a linked server';
};

const KEY = /^[A-Za-z0-9_-]{32,128}$/;

/* ---- talking to them ------------------------------------------------ */

export type PeerAnswer = { ok: true; status: number; type: string; body: Buffer } | { ok: false; error: string; status?: number };

/**
 * Ask a linked server something, with the key it gave this one. The address is
 * checked again (a stored one could have been edited by hand), redirects are
 * refused, and the answer is read to `maxBytes` and no further.
 */
export async function peerFetch(
  peer: PeerLink | string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; maxBytes?: number } = {}
): Promise<PeerAnswer> {
  const link = typeof peer === 'string' ? peerById(peer) : peer;
  if (!link) return { ok: false, error: 'that server is not linked' };
  const base = cleanPeerUrl(link.url);
  if (!base) return { ok: false, error: 'its address is not a Tailscale one' };
  if (!path.startsWith(PEER_PREFIX)) return { ok: false, error: 'only what servers share' };
  return fetchPeer(`${base}${path}`, link.key, init);
}

async function fetchPeer(
  url: string,
  key: string | null,
  init: { method?: string; body?: unknown; timeoutMs?: number; maxBytes?: number } = {}
): Promise<PeerAnswer> {
  const maxBytes = init.maxBytes ?? 4 * 1024 * 1024;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch (error) {
    const why = error instanceof Error && error.name === 'TimeoutError' ? 'it did not answer in time' : 'it could not be reached';
    return { ok: false, error: `${why}; is it on, and shared with you in Tailscale?` };
  }
  if (response.status >= 300 && response.status < 400) return { ok: false, error: 'it answered with a redirect, which is refused', status: response.status };
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) return { ok: false, error: 'its answer was too big', status: response.status };
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done || !value) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: 'its answer was too big', status: response.status };
      }
      chunks.push(Buffer.from(value));
    }
  }
  const body = Buffer.concat(chunks);
  const type = response.headers.get('content-type') ?? 'application/octet-stream';
  if (!response.ok) {
    let said = `it answered ${response.status}`;
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { error?: unknown };
      if (typeof parsed.error === 'string') said = parsed.error.slice(0, 200);
    } catch {
      // Not JSON; the status will do.
    }
    return { ok: false, error: said, status: response.status };
  }
  return { ok: true, status: response.status, type, body };
}

/** A linked server's answer as JSON. */
export async function peerJson<T>(
  peer: PeerLink | string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; maxBytes?: number } = {}
): Promise<T | { error: string; status?: number }> {
  const got = await peerFetch(peer, path, init);
  if (!got.ok) return { error: got.error, status: got.status };
  try {
    return JSON.parse(got.body.toString('utf8')) as T;
  } catch {
    return { error: 'its answer was not readable' };
  }
}

/* ---- the links ------------------------------------------------------ */

export const linkedPeers = (): PeerLink[] => readStore().links;
export const peerById = (id: string): PeerLink | null => readStore().links.find((l) => l.id === id) ?? null;

/** The linked server a request is from, by the key it showed; null for anything else. */
export function peerOf(request: FastifyRequest): PeerLink | null {
  if (request.deviceKind !== 'peer' || !request.deviceId) return null;
  return readStore().links.find((l) => l.deviceId === request.deviceId) ?? null;
}

/** Whether this side shares `what` with the server a request is from. */
export function sharesWith(request: FastifyRequest, what: keyof PeerShare): PeerLink | null {
  const peer = peerOf(request);
  return peer && peer.share[what] ? peer : null;
}

function updateLink(id: string, change: (link: PeerLink) => void): PeerLink | null {
  const store = readStore();
  const link = store.links.find((l) => l.id === id);
  if (!link) return null;
  change(link);
  writeStore(store);
  return link;
}

async function mintPeerKey(label: string): Promise<{ token: string; deviceId: string }> {
  const token = randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(devices)
    .values({ name: `server: ${label}`, kind: 'peer', tokenHash: hashToken(token) })
    .returning({ id: devices.id });
  return { token, deviceId: row!.id };
}

async function revokeDevice(deviceId: string): Promise<void> {
  await db.update(devices).set({ revokedAt: Date.now() }).where(eq(devices.id, deviceId));
}

/** Ask them what they share with this side, and remember it. */
export async function checkPeer(id: string): Promise<PeerLink | null> {
  const link = peerById(id);
  if (!link) return null;
  const got = await peerJson<{ name?: unknown; share?: unknown; version?: unknown }>(link, '/api/peer/hello', { timeoutMs: 10_000 });
  return updateLink(id, (l) => {
    l.checkedAt = Date.now();
    if ('error' in got) {
      l.problem = got.status === 401 ? 'it no longer accepts this server: it may have unlinked' : got.error;
      return;
    }
    l.problem = null;
    l.name = cleanLabel(got.name);
    l.theirs = {
      share: cleanShare(got.share, { collection: false, copy: false, catalogue: false, ratings: false }),
      version: typeof got.version === 'string' ? got.version.slice(0, 20) : null,
      at: Date.now(),
    };
  });
}

/** What they share, asked again when the last answer is over five minutes old. */
export async function freshPeer(id: string): Promise<PeerLink | null> {
  const link = peerById(id);
  if (!link) return null;
  if (link.checkedAt && Date.now() - link.checkedAt < 5 * 60_000) return link;
  return checkPeer(id);
}

/* ---- routes --------------------------------------------------------- */

/** Yours to manage: this PC, or a device paired to it. Not a copy's key nor a linked server's. */
const isOwner = (request: FastifyRequest) =>
  !isGuest && (request.isLocal || (request.deviceId !== null && request.deviceKind !== 'instance' && request.deviceKind !== 'peer'));

/** Pasting a link code is the one way in without a key, so it is held to this many tries a minute, for everyone. */
const LINK_PER_MINUTE = 20;
let linkWindow = { at: 0, count: 0 };

const shown = (l: PeerLink) => ({
  id: l.id,
  name: l.name,
  url: l.url,
  linkedAt: l.linkedAt,
  share: l.share,
  theirs: l.theirs,
  problem: l.problem,
  checkedAt: l.checkedAt,
});

const refuse = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });

export async function peerRoutes(app: FastifyInstance): Promise<void> {
  /* ---- what a linked server may ask ---- */

  /**
   * A link code, pasted into the other server, which sends it here with a key
   * it made for this server. Answered with a key for it. The code is spent
   * before any key exists, so it cannot be used twice even at once.
   */
  app.post(PEER_LINK_PATH, async (request, reply) => {
    if (isGuest) return refuse(reply, 404, "a friend's copy cannot be linked; link the host's");
    const now = Date.now();
    if (now - linkWindow.at > 60_000) linkWindow = { at: now, count: 0 };
    linkWindow.count += 1;
    if (linkWindow.count > LINK_PER_MINUTE) return refuse(reply, 429, 'too many tries; wait a minute');

    const body = (request.body ?? {}) as { code?: unknown; url?: unknown; key?: unknown; name?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const url = cleanPeerUrl(body.url);
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(code)) return refuse(reply, 400, 'that is not a link code');
    if (!url) return refuse(reply, 400, 'a linked server must be at an https://…ts.net address');
    if (typeof body.key !== 'string' || !KEY.test(body.key)) return refuse(reply, 400, 'no key was sent');

    const store = readStore();
    const presented = Buffer.from(sha(code));
    const match = store.codes.find((c) => c.expiresAt > now && c.hash.length === presented.length && timingSafeEqual(Buffer.from(c.hash), presented));
    if (!match) return refuse(reply, 410, 'that link code has been used or has expired; ask for a new one');
    store.codes = store.codes.filter((c) => c !== match && c.expiresAt > now);
    if (store.links.some((l) => l.url === url)) {
      writeStore(store);
      return refuse(reply, 409, 'these two servers are already linked');
    }
    writeStore(store);

    const name = cleanLabel(body.name);
    const { token, deviceId } = await mintPeerKey(name);
    const link: PeerLink = {
      id: randomBytes(4).toString('hex'),
      name,
      url,
      key: body.key,
      deviceId,
      linkedAt: now,
      share: { ...DEFAULT_SHARE },
      theirs: null,
      problem: null,
      checkedAt: null,
    };
    const fresh = readStore();
    fresh.links.push(link);
    writeStore(fresh);
    changes.emitChange('all');
    // Whether this side can reach them back, asked once they have the answer.
    setTimeout(() => void checkPeer(link.id).then(() => changes.emitChange('all')), 1500).unref();
    return { key: token, name: await ownLabel() };
  });

  /** Who this is, and what this side shares with the asker. */
  app.get('/api/peer/hello', async (request, reply) => {
    const peer = peerOf(request);
    if (!peer) return refuse(reply, 403, 'only for linked servers');
    return { name: await ownLabel(), share: peer.share, version: VERSION };
  });

  /** They changed what they share: asked again when next needed. */
  app.post('/api/peer/changed', async (request, reply) => {
    const peer = peerOf(request);
    if (!peer) return refuse(reply, 403, 'only for linked servers');
    updateLink(peer.id, (l) => {
      l.checkedAt = null;
    });
    changes.emitChange('all');
    return { ok: true };
  });

  /** They unlinked: their key here goes, and so does the link. */
  app.delete('/api/peer/link', async (request, reply) => {
    const peer = peerOf(request);
    if (!peer) return refuse(reply, 403, 'only for linked servers');
    await revokeDevice(peer.deviceId);
    const store = readStore();
    store.links = store.links.filter((l) => l.id !== peer.id);
    writeStore(store);
    changes.emitChange('all');
    return { ok: true };
  });

  /* ---- yours ---- */

  app.get('/api/peers', async (request, reply) => {
    if (!isOwner(request)) return refuse(reply, 403, 'only your own devices manage linked servers');
    const links = linkedPeers();
    // What they share, refreshed for any not asked in five minutes, all at once.
    await Promise.all(links.map((l) => freshPeer(l.id)));
    return {
      own: await ownPeerUrl(),
      links: linkedPeers().map(shown),
      codes: readStore().codes.filter((c) => c.expiresAt > Date.now()).length,
      defaults: DEFAULT_SHARE,
    };
  });

  /** A link code for somebody else's server to paste. */
  app.post('/api/peers/code', async (request, reply) => {
    if (!isOwner(request)) return refuse(reply, 403, 'only your own devices manage linked servers');
    const own = await ownPeerUrl();
    if (!own) {
      return refuse(
        reply,
        409,
        "Tailscale is not publishing this server, so no other server could reach it. Settings → Devices → Add a device says how to turn on 'tailscale serve'."
      );
    }
    const code = randomBytes(24).toString('base64url');
    const store = readStore();
    const now = Date.now();
    store.codes = [...store.codes.filter((c) => c.expiresAt > now), { hash: sha(code), expiresAt: now + CODE_MS }];
    writeStore(store);
    return { link: `${own}/#link=${code}`, expiresAt: now + CODE_MS };
  });

  /** Link with the server whose code was pasted. */
  app.post('/api/peers', async (request, reply) => {
    if (!isOwner(request)) return refuse(reply, 403, 'only your own devices manage linked servers');
    const pasted = typeof (request.body as { link?: unknown } | null)?.link === 'string' ? (request.body as { link: string }).link.trim() : '';
    const at = pasted.indexOf('#link=');
    const url = at > 0 ? cleanPeerUrl(pasted.slice(0, at)) : null;
    const code = at > 0 ? pasted.slice(at + '#link='.length) : '';
    if (!url || !/^[A-Za-z0-9_-]{20,128}$/.test(code)) {
      return refuse(reply, 400, 'paste the whole link code, starting https:// and with #link= in it');
    }
    const own = await ownPeerUrl();
    if (!own) return refuse(reply, 409, 'Tailscale is not publishing this server; turn on tailscale serve first');
    if (url === own) return refuse(reply, 400, 'that code is from this server; it goes into the other one');
    if (linkedPeers().some((l) => l.url === url)) return refuse(reply, 409, 'already linked with that server');

    // A key for them, made first so it can go with the code; taken back if they say no.
    const provisional = await mintPeerKey('linking…');
    const answer = await fetchPeer(`${url}${PEER_LINK_PATH}`, null, {
      body: { code, url: own, key: provisional.token, name: await ownLabel() },
      timeoutMs: 20_000,
    });
    let parsed: { key?: unknown; name?: unknown } = {};
    if (answer.ok) {
      try {
        parsed = JSON.parse(answer.body.toString('utf8')) as typeof parsed;
      } catch {
        parsed = {};
      }
    }
    if (!answer.ok || typeof parsed.key !== 'string' || !KEY.test(parsed.key)) {
      await revokeDevice(provisional.deviceId);
      return refuse(reply, 502, `the other server said no: ${answer.ok ? 'it sent no key' : answer.error}`);
    }
    const name = cleanLabel(parsed.name);
    await db.update(devices).set({ name: `server: ${name}` }).where(eq(devices.id, provisional.deviceId));
    const link: PeerLink = {
      id: randomBytes(4).toString('hex'),
      name,
      url,
      key: parsed.key,
      deviceId: provisional.deviceId,
      linkedAt: Date.now(),
      share: { ...DEFAULT_SHARE },
      theirs: null,
      problem: null,
      checkedAt: null,
    };
    const store = readStore();
    store.links.push(link);
    writeStore(store);
    await checkPeer(link.id);
    changes.emitChange('all');
    return shown(peerById(link.id) ?? link);
  });

  /** What this side shares with one server. Each switch is this side's own. */
  app.patch('/api/peers/:id', async (request, reply) => {
    if (!isOwner(request)) return refuse(reply, 403, 'only your own devices manage linked servers');
    const { id } = request.params as { id: string };
    const share = (request.body as { share?: unknown } | null)?.share;
    const link = updateLink(id, (l) => {
      l.share = cleanShare(share, l.share);
      // Copying is reading and keeping, so it needs reading.
      if (!l.share.collection) l.share.copy = false;
    });
    if (!link) return refuse(reply, 404, 'no such linked server');
    void peerFetch(link, '/api/peer/changed', { body: {}, timeoutMs: 8_000 });
    changes.emitChange('all');
    return shown(link);
  });

  app.post('/api/peers/:id/check', async (request, reply) => {
    if (!isOwner(request)) return refuse(reply, 403, 'only your own devices manage linked servers');
    const link = await checkPeer((request.params as { id: string }).id);
    if (!link) return refuse(reply, 404, 'no such linked server');
    return shown(link);
  });

  /** Unlink: their key here is revoked, and they are told, so this one's there goes too. */
  app.delete('/api/peers/:id', async (request, reply) => {
    if (!isOwner(request)) return refuse(reply, 403, 'only your own devices manage linked servers');
    const link = peerById((request.params as { id: string }).id);
    if (!link) return refuse(reply, 404, 'no such linked server');
    await revokeDevice(link.deviceId);
    const told = await peerFetch(link, '/api/peer/link', { method: 'DELETE', timeoutMs: 8_000 });
    const store = readStore();
    store.links = store.links.filter((l) => l.id !== link.id);
    writeStore(store);
    changes.emitChange('all');
    return { ok: true, told: told.ok };
  });

  /** Forget every code not yet used. */
  app.delete('/api/peers/codes', async (request, reply) => {
    if (!isOwner(request)) return refuse(reply, 403, 'only your own devices manage linked servers');
    const store = readStore();
    store.codes = [];
    writeStore(store);
    return { ok: true };
  });
}
