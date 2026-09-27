/**
 * The app without the server: what you last saw, and what you did meanwhile.
 *
 * ### Reading
 *
 * Every successful read under `/api/` is kept on this device, keyed by its path.
 * When the server cannot be reached, a read is answered from there instead of
 * failing — so the Dashboard, your tasks, habits and notes open on the train
 * showing what this device last saw, under a banner saying so and since when.
 * A stale list presented as a live one is the thing this app is against, which
 * is why the banner is not optional.
 *
 * Some things are never kept: the vault (decrypted secrets have no business in a
 * browser cache), the live stream, and screens that mean nothing stale —
 * who is online, the voice agent's state, browsing manga sources.
 *
 * ### Writing
 *
 * A change made offline is queued in an outbox and replayed in order when the
 * server answers again, carrying the time it really happened (`x-happened-at`),
 * so a habit ticked last night still counts for last night.
 *
 * **Only changes with a local effect are queued.** Each registers how it changes
 * the saved reads — ticking a habit bumps its count in the saved habit list — so
 * what you do shows at once rather than vanishing until the next sync. A change
 * with no effect registered is refused with "needs the PC" instead of being
 * queued invisibly: an action that appears to do nothing is worse than one that
 * says it cannot.
 *
 * Things created offline get a temporary id (`offline-…`). When the create is
 * replayed, the real id comes back and every later queued change — and every
 * later request, from a screen still holding the temporary one — is rewritten
 * to it. So you can add a task on the train and tick it off before you are home.
 *
 * Imports nothing from `api.ts`, which imports this; the token and the
 * "back online" follow-ups are handed in.
 */
import { useEffect, useState } from 'react';

const DATA = 'everything-data-v1';
const OUTBOX_KEY = 'everything.outbox';
const IDS_KEY = 'everything.offline-ids';
const SAVED_AT = 'x-saved-at';
export const HAPPENED_AT = 'x-happened-at';

/* ------------------------------------------------------------------ */
/* What is kept                                                        */
/* ------------------------------------------------------------------ */

const NEVER_KEPT = [
  /^\/api\/vault\b/, // decrypted secrets are never written to a browser cache
  /^\/api\/events\b/,
  /^\/api\/integrations\b/, // who is online, stale, is a lie with a coloured dot
  /^\/api\/voice\b/,
  /^\/api\/manga\/(browse|search|thumb|extensions|source|ui-session)\b/,
  /^\/api\/manga\/[^/]+\/chapters\/[^/]+\/pages\b/, // a chapter is "saved" by the manga package, or not at all
  /^\/api\/manga\/[^/]+\/source\b/,
];

export function keepable(path: string): boolean {
  return path.startsWith('/api/') && !NEVER_KEPT.some((rule) => rule.test(path));
}

const supported = typeof caches !== 'undefined';

export async function remember(path: string, data: unknown): Promise<void> {
  if (!supported || !keepable(path)) return;
  try {
    await (await caches.open(DATA)).put(
      path,
      new Response(JSON.stringify(data ?? null), {
        headers: { 'content-type': 'application/json', [SAVED_AT]: String(Date.now()) },
      })
    );
  } catch {
    // Full or refused. The screen works online either way.
  }
}

export async function recall(path: string): Promise<{ data: unknown; savedAt: number } | null> {
  if (!supported || !keepable(path)) return null;
  try {
    const hit = await (await caches.open(DATA)).match(path);
    if (!hit) return null;
    return { data: await hit.json(), savedAt: Number(hit.headers.get(SAVED_AT)) || 0 };
  } catch {
    return null;
  }
}

/**
 * Change every saved read whose path passes `match`. What `update` returns
 * replaces it; `undefined` removes it. Used by the local effects below.
 */
export async function patchSaved(
  match: (path: string) => boolean,
  update: (data: any, path: string) => unknown
): Promise<void> {
  if (!supported) return;
  const cache = await caches.open(DATA);
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    if (!match(path)) continue;
    const hit = await cache.match(request);
    if (!hit) continue;
    const next = update(await hit.json(), path);
    if (next === undefined) await cache.delete(request);
    else
      await cache.put(
        request,
        new Response(JSON.stringify(next), {
          headers: { 'content-type': 'application/json', [SAVED_AT]: hit.headers.get(SAVED_AT) ?? '0' },
        })
      );
  }
}

/** Put a read in place directly — a note created offline has a detail page too. */
export async function putSaved(path: string, data: unknown): Promise<void> {
  await remember(path, data);
}

/**
 * Pictures and files under `/api/` — habit pictures, note attachments, covers —
 * fetched with the token and kept like the reads, so the Dashboard's gauges
 * still have their pictures on the train.
 */
export async function keptBlob(path: string, token: string): Promise<Blob> {
  try {
    const response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`${response.status}`);
    const blob = await response.blob();
    markOnline();
    if (supported) {
      void caches
        .open(DATA)
        .then((c) => c.put(path, new Response(blob, { headers: { 'content-type': blob.type, [SAVED_AT]: String(Date.now()) } })))
        .catch(() => undefined);
    }
    return blob;
  } catch (error) {
    if (supported) {
      const hit = await (await caches.open(DATA)).match(path).catch(() => undefined);
      if (hit) return hit.blob();
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Online, offline, and what the banner says                           */
/* ------------------------------------------------------------------ */

export type Connectivity = {
  offline: boolean;
  /** The oldest saved read shown since going offline — "as of" on the banner. */
  shownFrom: number | null;
  pending: number;
  syncing: boolean;
  /** Changes the server refused on replay, in its words. */
  problems: string[];
};

let state: Connectivity = { offline: false, shownFrom: null, pending: loadOutbox().length, syncing: false, problems: [] };
const listeners = new Set<() => void>();

function set(next: Partial<Connectivity>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function connectivity(): Connectivity {
  return state;
}

export function useConnectivity(): Connectivity {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}

export function markOffline(): void {
  if (!state.offline) set({ offline: true });
  scheduleProbe();
}

export function noteShown(savedAt: number): void {
  if (state.shownFrom === null || savedAt < state.shownFrom) set({ shownFrom: savedAt });
}

const onlineListeners = new Set<() => void>();

/** Called when the server answers again — the manga package flushes its own queue here. */
export function onBackOnline(listener: () => void): () => void {
  onlineListeners.add(listener);
  return () => {
    onlineListeners.delete(listener);
  };
}

export function markOnline(): void {
  const wasOffline = state.offline;
  if (wasOffline) set({ offline: false, shownFrom: null });
  if (wasOffline || loadOutbox().length > 0) {
    void flushOutbox();
    onlineListeners.forEach((l) => l());
  }
}

export function dismissProblems(): void {
  set({ problems: [] });
}

/**
 * While offline, one quiet check every so often for the server's return — only
 * while the app is on screen, and stopped the moment it answers. The live stream
 * reconnecting finds it too; this is for a screen with nothing else asking.
 */
let probeTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleProbe(): void {
  if (probeTimer) return;
  probeTimer = setTimeout(async () => {
    probeTimer = null;
    if (!state.offline) return;
    if (document.visibilityState === 'visible') {
      try {
        const response = await fetch('/health', { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
        if (response.ok) {
          markOnline();
          return;
        }
      } catch {
        // Still away.
      }
    }
    scheduleProbe();
  }, 20_000);
}

/* ------------------------------------------------------------------ */
/* The outbox                                                          */
/* ------------------------------------------------------------------ */

type Change = {
  method: string;
  path: string;
  body: string | undefined;
  at: number;
  /** The temporary id this change created, to be swapped for the real one. */
  tempId: string | null;
  label: string;
};

function loadOutbox(): Change[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as Change[]) : [];
  } catch {
    return [];
  }
}

function saveOutbox(items: Change[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(OUTBOX_KEY);
    else localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  } catch {
    // Storage refused; the change shows here and will not reach the PC.
  }
  set({ pending: items.length });
}

function loadIds(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(IDS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Temporary ids swapped for real ones — in a path, or anywhere in a body. */
export function resolveIds(text: string): string;
export function resolveIds(text: string | undefined): string | undefined;
export function resolveIds(text: string | undefined): string | undefined {
  if (!text || !text.includes('offline-')) return text;
  const ids = loadIds();
  return text.replace(/offline-[0-9a-f-]{8,}/g, (temp) => ids[temp] ?? temp);
}

export function hasPending(): boolean {
  return loadOutbox().length > 0;
}

/* ---- local effects ---- */

export type EffectContext = {
  /** The path's capture groups, from the effect's pattern. */
  match: RegExpMatchArray;
  body: any;
  /** When it happened. */
  at: number;
  /** A fresh temporary id, for effects that create something. */
  tempId: string;
};

type Effect = {
  method: string;
  pattern: RegExp;
  label: string;
  creates: boolean;
  apply: (context: EffectContext) => Promise<unknown>;
};

const effects: Effect[] = [];

/**
 * Teach the outbox a change it may queue, and what it does to the saved reads.
 *
 * `apply` changes those reads and returns what the server would have answered,
 * so the caller carries on exactly as if it had. `creates` marks a change whose
 * response carries the new thing's `id`, which replaces the temporary one.
 */
export function registerOfflineEffect(effect: Effect): void {
  effects.push(effect);
}

function effectFor(method: string, path: string): { effect: Effect; match: RegExpMatchArray } | null {
  const bare = path.split('?')[0]!;
  for (const effect of effects) {
    if (effect.method !== method) continue;
    const match = bare.match(effect.pattern);
    if (match) return { effect, match };
  }
  return null;
}

export function queueable(method: string, path: string): boolean {
  return effectFor(method, path) !== null;
}

function newTempId(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return `offline-${uuid}`;
}

/** Queue a change, apply it here, and answer as the server would have. */
export async function queueChange(method: string, path: string, body: string | undefined): Promise<unknown> {
  const found = effectFor(method, path);
  if (!found) throw new Error('not queueable');
  const at = Date.now();
  const tempId = newTempId();
  let parsed: unknown = undefined;
  try {
    parsed = body ? JSON.parse(body) : undefined;
  } catch {
    parsed = undefined;
  }
  const answer = await found.effect.apply({ match: found.match, body: parsed ?? {}, at, tempId });
  const items = loadOutbox();
  const last = items[items.length - 1];
  /*
   * Consecutive edits to the same thing become one. A note typed offline saves
   * every second or so, and replaying forty saves of one paragraph would be
   * forty requests to arrive at the last of them. Only a PATCH or PUT to the
   * very same path straight after another, so nothing is reordered.
   */
  if (last && last.path === path && last.method === method && (method === 'PATCH' || method === 'PUT')) {
    let merged = body;
    try {
      merged = JSON.stringify({ ...JSON.parse(last.body ?? '{}'), ...JSON.parse(body ?? '{}') });
    } catch {
      // Not JSON; the newer one stands.
    }
    items[items.length - 1] = { ...last, body: merged, at };
    saveOutbox(items);
  } else {
    saveOutbox([...items, { method, path, body, at, tempId: found.effect.creates ? tempId : null, label: found.effect.label }]);
  }
  return answer;
}

/* ---- sending it ---- */

let token: () => string = () => '';
const afterSync = new Set<() => void>();

/** `api.ts` hands in the token getter. */
export function configureOffline(options: { token: () => string }): void {
  token = options.token;
}

/** Called once replayed changes have landed — the live stream refetches everything here. */
export function onSynced(listener: () => void): () => void {
  afterSync.add(listener);
  return () => {
    afterSync.delete(listener);
  };
}

let flushing: Promise<void> | null = null;

/**
 * Replay the outbox, oldest first.
 *
 * Stops at a network failure or a server error — still away, or not ready —
 * and tries again later. A change the server *refuses* (a task since deleted on
 * the PC) is dropped with its reason kept for the banner: sending it again would
 * be refused again forever, and silently dropping it would hide that it never
 * happened.
 */
export function flushOutbox(): Promise<void> {
  if (flushing) return flushing;
  const run = async () => {
    let items = loadOutbox();
    if (items.length === 0) return;
    set({ syncing: true });
    let landed = 0;
    const problems: string[] = [];
    try {
      while (items.length > 0) {
        const change = items[0]!;
        const path = resolveIds(change.path);
        const body = resolveIds(change.body);
        if (/offline-[0-9a-f-]{8,}/.test(path)) {
          problems.push(`${change.label}: what it changes was never created on the PC`);
        } else {
          let response: Response;
          try {
            response = await fetch(path, {
              method: change.method,
              body: body ?? (change.method === 'GET' ? undefined : '{}'),
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token()}`,
                [HAPPENED_AT]: String(change.at),
              },
            });
          } catch {
            break;
          }
          if (response.status >= 500) break;
          if (response.ok) {
            landed += 1;
            if (change.tempId) {
              try {
                const created = (await response.json()) as { id?: string };
                if (created?.id) {
                  const ids = loadIds();
                  ids[change.tempId] = created.id;
                  localStorage.setItem(IDS_KEY, JSON.stringify(ids));
                }
              } catch {
                // No id in the answer; later changes to it will say so.
              }
            }
          } else {
            let reason = `${response.status}`;
            try {
              reason = ((await response.json()) as { error?: string }).error ?? reason;
            } catch {
              // Not JSON.
            }
            problems.push(`${change.label}: ${reason}`);
          }
        }
        items = loadOutbox().slice(1);
        saveOutbox(items);
      }
    } finally {
      set({ syncing: false, ...(problems.length > 0 ? { problems: [...state.problems, ...problems] } : {}) });
      if (landed > 0 || problems.length > 0) afterSync.forEach((f) => f());
    }
  };
  flushing = run().finally(() => {
    flushing = null;
  });
  return flushing;
}
