/**
 * People: a copy of the server each, on this PC. Plan A in "Blue Everything
 * for friends".
 *
 * The host is your own copy, run as it always has been. Each person's copy is
 * a folder under `instances/<name>/` with its own database, data, settings and
 * logs, on a port of its own. The copies share no file and trust each other no
 * more than any other caller.
 *
 * **Managed from the app.** Settings → People on the host lists the copies,
 * makes one, starts and stops it, hands out a sign-in link and removes it, from
 * the PC or from your phone: every device paired to the host is yours, so any
 * of them may (`isOwner`). The host starts each copy as a child process, the
 * way the manga package starts Suwayomi, and starts them again when it starts.
 * `start.ps1 -Instance <name>` does the same from a terminal.
 *
 * **Reached through Tailscale.** A phone needs `https`, and `tailscale serve`
 * was publishing only the host's port. Each copy is published at
 * `https://<machine>.ts.net:<port>`, inside the tailnet only.
 *
 * **Signed in by link.** A sign-in link carries a single-use code that expires
 * in a day. The host writes only the code's hash, into the copy's own
 * `invites.json`; the copy swaps a matching code for a device token
 * (`/api/invite/redeem`, the one route a copy answers without a token). The
 * host never opens a copy's database.
 *
 * **The one thing copies share is the host's Suwayomi.** A guest asks the host
 * to wake it, and asks for a source rather than installing one
 * (`/api/manga/host/*`), with a key: an `instance` device on the host, written
 * to `instances/<name>/host-key`, which opens only those routes
 * (`INSTANCE_PREFIXES` in `auth.ts`).
 *
 * **On one PC that key is a courtesy, not a wall.** Every copy runs as the same
 * Windows user, so a guest's process could read the host's database file
 * directly, and loopback requests are trusted by the host anyway. What the key
 * buys is the shape for later: in Docker each copy is its own container with
 * no loopback trust and no shared disk, and the key is then the whole of what
 * a guest can do to the host.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pairableDeviceKinds } from '@everything/shared';
import { db } from './db/client.js';
import { devices } from './db/schema.js';
import { hashToken } from './auth.js';
import { config, isGuest, instanceRoot } from './config.js';
import { dataDir, repoRoot, serverSrc } from './paths.js';
import { serveOnPort, serveStatus, stopServingPort, tailnetName } from './tailscale.js';

/** Where guest copies live. */
export const instancesRoot = resolve(repoRoot, 'instances');

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_FILE = 'host-key';
const INVITES_FILE = 'invites.json';
const PID_FILE = 'server.pid';
/** How long a sign-in link works. */
const INVITE_MS = 24 * 60 * 60_000;
/** The first port a copy may take; the host has 8787. */
const FIRST_PORT = 8788;

/** The name a copy's key goes by in the host's device list. */
const deviceName = (name: string) => `copy: ${name}`;
const folderOf = (name: string) => resolve(instancesRoot, name);

interface CopyInfo {
  port: number;
  created?: string;
  /** Started when the host starts. On unless the copy was stopped by hand. */
  autostart?: boolean;
  /** What its person is called, as the copy last told the host. See `names.ts`. */
  displayName?: string | null;
}

function readInfo(name: string): CopyInfo | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(folderOf(name), 'instance.json'), 'utf8').replace(/^﻿/, '')) as CopyInfo;
    return Number.isInteger(raw.port) ? raw : null;
  } catch {
    return null;
  }
}

function writeInfo(name: string, info: CopyInfo): void {
  const file = resolve(folderOf(name), 'instance.json');
  writeFileSync(`${file}.tmp`, JSON.stringify(info, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** Every guest copy's name, from the folders under `instances/`. */
export function listInstances(): string[] {
  if (!existsSync(instancesRoot)) return [];
  return readdirSync(instancesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME.test(d.name) && existsSync(resolve(instancesRoot, d.name, 'instance.json')))
    .map((d) => d.name)
    .sort();
}

/* ---- the key to the host ------------------------------------------ */

/**
 * A fresh key for one copy, replacing any it had. The old one is revoked
 * first, so a copy only ever holds one that works.
 */
export async function mintInstanceKey(name: string): Promise<void> {
  if (!NAME.test(name)) throw new Error(`not a copy's name: ${name}`);
  const folder = folderOf(name);
  if (!existsSync(resolve(folder, 'instance.json'))) throw new Error(`no copy called ${name}`);
  await revokeInstanceKey(name);

  const token = randomBytes(32).toString('base64url');
  await db.insert(devices).values({ name: deviceName(name), kind: 'instance', tokenHash: hashToken(token) });

  const file = resolve(folder, KEY_FILE);
  writeFileSync(`${file}.tmp`, token);
  renameSync(`${file}.tmp`, file);
}

async function revokeInstanceKey(name: string): Promise<void> {
  await db
    .update(devices)
    .set({ revokedAt: Date.now() })
    .where(and(eq(devices.name, deviceName(name)), eq(devices.kind, 'instance'), isNull(devices.revokedAt)));
}

/** At the host's start: a key for every copy that has none. */
export async function giveCopiesTheirKeys(log: (line: string) => void): Promise<void> {
  if (isGuest) return;
  for (const name of listInstances()) {
    if (existsSync(resolve(folderOf(name), KEY_FILE))) continue;
    try {
      await mintInstanceKey(name);
      log(`gave the copy "${name}" its key to this server`);
    } catch (error) {
      log(`could not give the copy "${name}" its key: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** A guest's key to the host, or null when the host has not written one yet. */
export function readHostKey(): string | null {
  if (!isGuest) return null;
  try {
    const key = readFileSync(resolve(instanceRoot, KEY_FILE), 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

/* ---- running a copy ------------------------------------------------ */

/** Does something answer `/health` on this port? */
async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The copies answering now, by name: what closing the host's app would stop. */
export async function runningCopies(): Promise<string[]> {
  const names = listInstances();
  const up = await Promise.all(names.map(async (n) => (await answers(readInfo(n)?.port ?? 0)) ? displayNameOf(n) : null));
  return up.filter((n): n is string => n !== null);
}

/** The first port from 8788 that no copy has and nothing is listening on. */
async function freePort(): Promise<number> {
  const taken = new Set([config.PORT, ...listInstances().map((n) => readInfo(n)?.port ?? 0)]);
  for (let port = FIRST_PORT; port < FIRST_PORT + 200; port += 1) {
    if (!taken.has(port) && !(await answers(port))) return port;
  }
  throw new Error('no free port for another copy');
}

/**
 * What a copy is started with: this process's environment, less everything
 * that names *this* copy's database, packages, port or features. A guest
 * started with the host's `DATABASE_URL` would be the host.
 */
function copyEnvironment(name: string, port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'DATABASE_URL',
    'DATABASE_AUTH_TOKEN',
    'MODULES_SHIPPED',
    'MODULES_INSTALLED',
    'MODULES_STATE',
    'FEATURES',
    'OAUTH_REDIRECT_BASE',
  ]) {
    delete env[key];
  }
  env.EVERYTHING_INSTANCE = name;
  env.PORT = String(port);
  env.EXIT_WITHOUT_AGENT = 'false';
  env.EVERYTHING_HOST_URL = `http://127.0.0.1:${config.PORT}`;
  return env;
}

/** The last run's log kept as `.prev.log`, as `start.ps1` does. */
function freshLog(logs: string, file: string): number {
  const path = resolve(logs, file);
  try {
    if (existsSync(path) && statSync(path).size > 0) renameSync(path, path.replace(/\.log$/, '.prev.log'));
  } catch {
    // In use, or not ours to move: written over, as it always was.
  }
  return openSync(path, 'w');
}

/**
 * Start a copy, unless it already answers, and wait until it does.
 *
 * A child of this process, detached so it outlives a restart of the host:
 * `stop.ps1` stops your copy and leaves the guests, and a guest found
 * answering at the host's next start is simply left running. The command line
 * carries `--instance=<name>`, which is how `stop.ps1` tells copies apart.
 */
export async function startCopy(name: string): Promise<void> {
  const info = readInfo(name);
  if (!info) throw new Error(`no copy called ${name}`);
  if (await answers(info.port)) return;

  const logs = resolve(folderOf(name), 'logs');
  mkdirSync(logs, { recursive: true });
  const out = freshLog(logs, 'server.log');
  const err = freshLog(logs, 'server.err.log');
  const child = spawn(process.execPath, ['--import', 'tsx', resolve(serverSrc, 'main.ts'), `--instance=${name}`], {
    cwd: resolve(serverSrc, '..'),
    env: copyEnvironment(name, info.port),
    stdio: ['ignore', out, err],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  closeSync(out);
  closeSync(err);

  let exited: number | null = null;
  child.once('exit', (code) => {
    exited = code ?? -1;
  });
  for (let i = 0; i < 60; i += 1) {
    if (exited !== null) break;
    if (await answers(info.port)) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(
    exited !== null
      ? `the copy stopped as it started; instances\\${name}\\logs\\server.err.log says why`
      : 'the copy did not answer within 30 seconds'
  );
}

/**
 * Stop a copy. It writes its own process id when it starts (`writeOwnPid`),
 * which covers one started by `start.ps1` or by an earlier run of the host.
 */
export async function stopCopy(name: string): Promise<void> {
  const info = readInfo(name);
  if (!info) throw new Error(`no copy called ${name}`);
  const pidFile = resolve(folderOf(name), PID_FILE);
  const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : NaN);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  for (let i = 0; i < 20; i += 1) {
    if (!(await answers(info.port))) {
      rmSync(pidFile, { force: true });
      return;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('the copy is still answering; stop it with scripts\\stop.ps1 -Instance ' + name);
}

/** A copy writes its process id at its start, for `stopCopy`, and removes it on close. */
export function writeOwnPid(): () => void {
  if (!isGuest) return () => {};
  const file = resolve(instanceRoot, PID_FILE);
  writeFileSync(file, String(process.pid));
  return () => rmSync(file, { force: true });
}

/**
 * At the host's start: every copy that was running, running again, and
 * published on Tailscale. In the background, so the host answers first.
 */
export async function startCopies(log: (line: string) => void): Promise<void> {
  if (isGuest) return;
  const names = listInstances();
  if (names.length === 0) return;
  const served = await serveStatus();
  for (const name of names) {
    const info = readInfo(name);
    if (!info) continue;
    if (served && !served.includes(`:${info.port}`)) await serveOnPort(info.port);
    if (info.autostart === false) continue;
    try {
      await startCopy(name);
    } catch (error) {
      log(`could not start the copy "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/* ---- names --------------------------------------------------------- */

/** A copy's display name, or its own name until it has told the host one. */
export function displayNameOf(copy: string): string {
  return (NAME.test(copy) && readInfo(copy)?.displayName) || copy;
}

/** Recorded from the copy itself (`PUT /api/host/name`). */
export function setDisplayName(copy: string, name: string | null): void {
  const info = readInfo(copy);
  if (!info) throw new Error(`no copy called ${copy}`);
  writeInfo(copy, { ...info, displayName: name });
}

/** Which copy a device is: its key's name is `copy: <name>`. Null for anything else. */
export async function copyOfDevice(deviceId: string | null): Promise<string | null> {
  if (!deviceId) return null;
  const [device] = await db.select({ name: devices.name, kind: devices.kind }).from(devices).where(eq(devices.id, deviceId));
  if (device?.kind !== 'instance' || !device.name.startsWith('copy: ')) return null;
  return device.name.slice('copy: '.length);
}

/* ---- people, as the screen sees them ------------------------------- */

export interface Person {
  name: string;
  /** What they chose to be called, or null until they have. */
  displayName: string | null;
  port: number;
  running: boolean;
  /** Started when the host starts. */
  autostart: boolean;
  created: string | null;
  /** `https://<machine>.ts.net:<port>`, once Tailscale publishes it. */
  address: string | null;
  /** Always works, on this PC. */
  localAddress: string;
}

async function describe(name: string, machine: string | null, served: string): Promise<Person | null> {
  const info = readInfo(name);
  if (!info) return null;
  return {
    name,
    displayName: info.displayName ?? null,
    port: info.port,
    running: await answers(info.port),
    autostart: info.autostart !== false,
    created: info.created ?? null,
    address: machine && served.includes(`${machine}:${info.port}`) ? `https://${machine}:${info.port}` : null,
    localAddress: `http://127.0.0.1:${info.port}`,
  };
}

export async function listPeople(): Promise<Person[]> {
  const [machine, served] = await Promise.all([tailnetName(), serveStatus()]);
  const people = await Promise.all(listInstances().map((n) => describe(n, machine, served)));
  return people.filter((p): p is Person => p !== null);
}

async function person(name: string): Promise<Person> {
  const [machine, served] = await Promise.all([tailnetName(), serveStatus()]);
  const found = await describe(name, machine, served);
  if (!found) throw new Error(`no copy called ${name}`);
  return found;
}

/** Make a copy: folder, port, key, started, published. */
export async function createCopy(name: string): Promise<Person> {
  if (!NAME.test(name)) throw new Error('a name of lowercase letters, digits and hyphens, up to 32');
  if (existsSync(folderOf(name))) throw new Error(`there is already a copy called ${name}`);
  const port = await freePort();
  mkdirSync(folderOf(name), { recursive: true });
  writeInfo(name, { port, created: new Date().toISOString(), autostart: true });
  await mintInstanceKey(name);
  await startCopy(name);
  await serveOnPort(port);
  return person(name);
}

/**
 * A sign-in link for a copy: single use, a day long. Only the code's hash is
 * written, into the copy's folder for the copy to check.
 */
export async function inviteTo(name: string): Promise<{ url: string; expiresAt: number; person: Person }> {
  const who = await person(name);
  const code = randomBytes(24).toString('base64url');
  const expiresAt = addInvite(resolve(folderOf(name), INVITES_FILE), code, INVITE_MS);
  return { url: `${who.address ?? who.localAddress}/#invite=${code}`, expiresAt, person: who };
}

/**
 * Remove a copy: stopped, unpublished, its key revoked, and its folder moved
 * to `instances/_removed/` rather than deleted, because it is somebody's data
 * and a misplaced tap should not be the end of it.
 */
export async function removeCopy(name: string): Promise<void> {
  const info = readInfo(name);
  if (!info) throw new Error(`no copy called ${name}`);
  await stopCopy(name);
  await stopServingPort(info.port);
  await revokeInstanceKey(name);
  const removed = resolve(instancesRoot, '_removed');
  mkdirSync(removed, { recursive: true });
  renameSync(folderOf(name), resolve(removed, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
}

/* ---- the copy's own side of a sign-in link ------------------------- */

type Invite = { hash: string; expiresAt: number };

function readInvites(file: string): Invite[] {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(list)
      ? list.filter((i): i is Invite => typeof i?.hash === 'string' && typeof i?.expiresAt === 'number')
      : [];
  } catch {
    return [];
  }
}

/**
 * This copy's sign-in codes: a guest's, in its folder where the host writes its
 * links; the host's, beside its data.
 */
const invitesHere = () => (isGuest ? resolve(instanceRoot, INVITES_FILE) : resolve(dataDir, INVITES_FILE));

/**
 * A short code for adding one more device, made by a device already signed in.
 *
 * Mostly for the iPhone. A web app added to the Home Screen keeps its own
 * storage, apart from Safari's, so a phone signed in by a link in Safari opens
 * the installed app signed out. Onboarding's install step shows one of these
 * to type into the installed app. Eight letters from an alphabet with no
 * look-alikes, ten minutes, once.
 */
const HANDOFF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const HANDOFF_MS = 10 * 60_000;

function addInvite(file: string, code: string, lifeMs: number): number {
  const now = Date.now();
  const kept = readInvites(file).filter((i) => i.expiresAt > now);
  kept.push({ hash: createHash('sha256').update(code).digest('hex'), expiresAt: now + lifeMs });
  writeFileSync(`${file}.tmp`, JSON.stringify(kept));
  renameSync(`${file}.tmp`, file);
  return now + lifeMs;
}

export function makeHandoffCode(): { code: string; expiresAt: number } {
  const bytes = randomBytes(8);
  const code = [...bytes].map((b) => HANDOFF_ALPHABET[b % HANDOFF_ALPHABET.length]).join('');
  mkdirSync(isGuest ? instanceRoot : dataDir, { recursive: true });
  const expiresAt = addInvite(invitesHere(), code, HANDOFF_MS);
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
}

/** A typed short code, as it was made: no dash or spaces, capitals. A link's code is left as it is. */
const normaliseCode = (raw: string) => {
  const squeezed = raw.replace(/[\s-]/g, '');
  return squeezed.length <= 12 ? squeezed.toUpperCase() : raw.trim();
};

/**
 * At most this many tries a minute, for everyone: a short code is eight
 * letters, which is plenty against a few guesses a minute and not against
 * thousands.
 */
const REDEEM_PER_MINUTE = 20;
let redeemWindow = { at: 0, count: 0 };

/** Swap a sign-in code for a device token, once. Null when it is unknown, used or expired. */
async function redeem(code: string, deviceName: string, kind: (typeof pairableDeviceKinds)[number]): Promise<string | null> {
  const file = invitesHere();
  const presented = Buffer.from(createHash('sha256').update(code).digest('hex'));
  const now = Date.now();
  const invites = readInvites(file);
  const match = invites.find(
    (i) => i.expiresAt > now && i.hash.length === presented.length && timingSafeEqual(Buffer.from(i.hash), presented)
  );
  if (!match) return null;
  // Spent before the token exists, so the same link cannot be used twice even
  // by two devices opening it at once.
  writeFileSync(`${file}.tmp`, JSON.stringify(invites.filter((i) => i !== match && i.expiresAt > now)));
  renameSync(`${file}.tmp`, file);

  const token = randomBytes(32).toString('base64url');
  await db.insert(devices).values({ name: deviceName, kind, tokenHash: hashToken(token) });
  return token;
}

/** The one route a guest answers without a token. See `authenticate`. */
export const REDEEM_PATH = '/api/invite/redeem';

/* ---- routes --------------------------------------------------------- */

/**
 * Yours to manage: any device paired to the host, or this PC. Every device the
 * host has is yours, since friends pair to their own copies; a copy's key is
 * kept out by `INSTANCE_PREFIXES` before it gets here.
 */
function isOwner(request: FastifyRequest): boolean {
  return !isGuest && (request.isLocal || (request.deviceId !== null && request.deviceKind !== 'instance'));
}

const failed = (reply: FastifyReply, error: unknown, code = 400) =>
  reply.code(code).send({ error: error instanceof Error ? error.message : String(error) });

export async function instanceRoutes(app: FastifyInstance): Promise<void> {
  /** A sign-in link's code or a typed hand-off code, for a device token. On every copy. */
  app.post(REDEEM_PATH, async (request, reply) => {
    const now = Date.now();
    if (now - redeemWindow.at > 60_000) redeemWindow = { at: now, count: 0 };
    redeemWindow.count += 1;
    if (redeemWindow.count > REDEEM_PER_MINUTE) return reply.code(429).send({ error: 'too many tries; wait a minute' });

    const body = request.body as { code?: unknown; name?: unknown; kind?: unknown } | null;
    const code = typeof body?.code === 'string' ? normaliseCode(body.code) : '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) return reply.code(400).send({ error: 'that is not a sign-in code' });
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : 'Signed in by link';
    const kind = pairableDeviceKinds.find((k) => k === body?.kind) ?? 'browser';
    const token = await redeem(code, name, kind);
    if (!token) return reply.code(410).send({ error: 'that code has been used or has expired; make a new one' });
    return { token };
  });

  /** A hand-off code, from a device already signed in to this copy. */
  app.post('/api/devices/handoff', async (request, reply) => {
    if (!request.isLocal && (request.deviceId === null || request.deviceKind === 'instance')) {
      return reply.code(403).send({ error: 'only a signed-in device can add another' });
    }
    return makeHandoffCode();
  });

  if (isGuest) return;

  app.get('/api/people', async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ error: 'only the host manages people' });
    return { people: await listPeople() };
  });

  app.post('/api/people', async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ error: 'only the host manages people' });
    const body = request.body as { name?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name.trim().toLowerCase() : '';
    try {
      await createCopy(name);
      return await inviteTo(name);
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.post('/api/people/:name/start', async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ error: 'only the host manages people' });
    const { name } = request.params as { name: string };
    const info = readInfo(name);
    if (!info) return reply.code(404).send({ error: `no copy called ${name}` });
    try {
      writeInfo(name, { ...info, autostart: true });
      await startCopy(name);
      return await person(name);
    } catch (error) {
      return failed(reply, error, 502);
    }
  });

  app.post('/api/people/:name/stop', async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ error: 'only the host manages people' });
    const { name } = request.params as { name: string };
    const info = readInfo(name);
    if (!info) return reply.code(404).send({ error: `no copy called ${name}` });
    try {
      // Stopped by hand stays stopped when the host next starts.
      writeInfo(name, { ...info, autostart: false });
      await stopCopy(name);
      return await person(name);
    } catch (error) {
      return failed(reply, error, 502);
    }
  });

  app.post('/api/people/:name/invite', async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ error: 'only the host manages people' });
    const { name } = request.params as { name: string };
    try {
      return await inviteTo(name);
    } catch (error) {
      return failed(reply, error, 404);
    }
  });

  app.delete('/api/people/:name', async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ error: 'only the host manages people' });
    const { name } = request.params as { name: string };
    const body = request.body as { confirm?: unknown } | null;
    // The name typed again, because this stops somebody's copy and takes it off the menu.
    if (body?.confirm !== name) return reply.code(400).send({ error: 'type the name to confirm' });
    try {
      await removeCopy(name);
      return { ok: true };
    } catch (error) {
      return failed(reply, error);
    }
  });

  /**
   * A key for a copy, now. Local-only, like minting a device token: run by
   * `start.ps1 -Instance` when it makes a copy while the host is up.
   */
  app.post('/api/instances/:name/key', async (request, reply) => {
    if (!request.isLocal) return reply.code(403).send({ error: 'only from the PC running the server' });
    const { name } = request.params as { name: string };
    try {
      await mintInstanceKey(name);
      return { ok: true };
    } catch (error) {
      return failed(reply, error);
    }
  });
}
