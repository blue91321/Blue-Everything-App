/**
 * Test A and Test B: two made-up series on two made-up sources, for trying the
 * manga screens on this PC without depending on a real site (2026-11-17, asked
 * for as a test platform "only visible or usable by me or Claude on my
 * machine").
 *
 * They are answered here, inside the source adapter (`SuwayomiAdapter` asks
 * these functions first) and the page fetcher (`sharedPage`), so every screen
 * and feature meets them as it would a real source: Browse, search, Other
 * sources, "read this chapter from another source", Switch sources, the
 * release sweep, keeping a series, the reader. Suwayomi is never asked about
 * them and need not be running.
 *
 * - **Test A** works: 12 chapters of 8 drawn pages, each saying which series,
 *   chapter and page it is.
 * - **Test B** is the same series under another name, and fails in the way
 *   chosen on More (`bMode`): its pages will not load (`pages`), its source does
 *   not answer (`down`), or the source has taken it down (`gone`). Each is one of
 *   the troubles the app has a way round, which is the point.
 *
 * Each lists the other's name as one of its own (`altTitles`), which is how a
 * real series with an English and a romanised title is matched across sources.
 *
 * **Off unless switched on**, from Manga → More on this PC, and never on a
 * friend's copy (`isGuest`). Switching off takes both out of the library.
 * Requests from other devices do not see them in the library or Browse
 * (`hiddenFromHere`).
 */
import { deflateSync, crc32 } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, isGuest, writeFileAtomic } from '@everything/server/module-api';
import { SourceError, type SourceChapter, type SourceMatch } from './sources.js';
import { PageFetchError } from './page-fetch.js';

export type TestBMode = 'pages' | 'down' | 'gone';

export interface TestSeries {
  key: 'a' | 'b';
  sourceId: string;
  sourceName: string;
  mangaId: string;
  title: string;
  other: string;
}

/** Ids no real source hands out: Suwayomi numbers its series from 1 and its sources are 64-bit hashes. */
export const TEST_A: TestSeries = { key: 'a', sourceId: '9100000000000000001', sourceName: 'Test A source', mangaId: '990000001', title: 'Test A', other: 'Test B' };
export const TEST_B: TestSeries = { key: 'b', sourceId: '9100000000000000002', sourceName: 'Test B source', mangaId: '990000002', title: 'Test B', other: 'Test A' };
const ALL = [TEST_A, TEST_B];

export const TEST_CHAPTERS = 12;
export const TEST_PAGES = 8;

const FILE = join(dataDir, 'manga-test-source.json');

interface TestState {
  on: boolean;
  bMode: TestBMode;
}

let state: TestState = load();

function load(): TestState {
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<TestState>;
      return { on: raw.on === true, bMode: raw.bMode === 'down' || raw.bMode === 'gone' ? raw.bMode : 'pages' };
    }
  } catch {
    // Unreadable: off.
  }
  return { on: false, bMode: 'pages' };
}

/** Whether the test source answers at all: switched on, on the host. */
export function testOn(): boolean {
  return !isGuest && state.on;
}

export function testState(): TestState {
  return { ...state };
}

export function setTestState(patch: Partial<TestState>): TestState {
  state = {
    on: typeof patch.on === 'boolean' ? patch.on : state.on,
    bMode: patch.bMode === 'pages' || patch.bMode === 'down' || patch.bMode === 'gone' ? patch.bMode : state.bMode,
  };
  writeFileAtomic(FILE, JSON.stringify(state, null, 2));
  return testState();
}

/** The test series a Suwayomi manga id or source id names, or null (always null while off). */
export function testByManga(mangaId: string | null | undefined): TestSeries | null {
  if (!testOn() || !mangaId) return null;
  return ALL.find((t) => t.mangaId === String(mangaId)) ?? null;
}
export function testBySource(sourceId: string | null | undefined): TestSeries | null {
  if (!testOn() || !sourceId) return null;
  return ALL.find((t) => t.sourceId === String(sourceId)) ?? null;
}
/** Whether a source id is one of these, on or off: what other devices are kept from seeing. */
export const isTestSourceId = (sourceId: string | null | undefined): boolean => ALL.some((t) => t.sourceId === String(sourceId));
export const isTestMangaId = (mangaId: string | null | undefined): boolean => ALL.some((t) => t.mangaId === String(mangaId));
/** A test series' name: never looked up on MangaDex (`namesFor`), which has nothing to say about it. */
export const isTestTitle = (title: string): boolean => ALL.some((t) => t.title === title);

/* ---- What a source answers ---- */

export function testSources(): Array<{ id: string; name: string; lang: string; supportsLatest: boolean }> {
  return testOn() ? ALL.map((t) => ({ id: t.sourceId, name: t.sourceName, lang: 'en', supportsLatest: true })) : [];
}

export function testMatch(t: TestSeries): SourceMatch {
  return { id: t.mangaId, title: t.title, sourceId: t.sourceId, sourceName: t.sourceName, lang: 'en', url: null, thumbnailUrl: null };
}

/** A source's popular or latest list, or a search on it: its one series, if the search fits. */
export function testListing(t: TestSeries, query?: string): { matches: SourceMatch[]; hasNextPage: boolean } {
  return { matches: !query || fits(t, query) ? [testMatch(t)] : [], hasNextPage: false };
}

/** Searching every source: each test series whose name fits. */
export function testSearch(query: string): SourceMatch[] {
  return testOn() ? ALL.filter((t) => fits(t, query)).map(testMatch) : [];
}

const fits = (t: TestSeries, query: string) => {
  const q = query.toLowerCase().trim();
  return !!q && [t.title, t.other].some((name) => name.toLowerCase().includes(q) || q.includes(name.toLowerCase()));
};

export function testDetails(t: TestSeries) {
  return {
    id: t.mangaId,
    title: t.title,
    author: 'Blue Everything',
    artist: null,
    description: `A test series, made up on this PC. ${t.key === 'a' ? 'It always works.' : 'It fails the way Manga → More → Test series says.'} Also known as ${t.other}.`,
    genres: ['Action', 'Fantasy', 'Test'],
    status: 'ongoing' as const,
    thumbnailUrl: null,
    url: null,
    sourceId: t.sourceId,
    sourceName: t.sourceName,
    lang: 'en',
    stale: false,
  };
}

const chapterId = (t: TestSeries, n: number) => `${t.mangaId}${String(n).padStart(3, '0')}`;

export function testChapters(t: TestSeries): SourceChapter[] {
  if (t.key === 'b' && state.bMode === 'down') throw new SourceError('Test B source did not answer (set on Manga → More → Test series)');
  if (t.key === 'b' && state.bMode === 'gone') throw new SourceError('No chapters found (Test B is set to be gone, on Manga → More → Test series)');
  const week = 7 * 86_400_000;
  // A week apart, the newest yesterday, so "last updated" reads as an ongoing series.
  const newest = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
  // Newest first, as most sources list them.
  return Array.from({ length: TEST_CHAPTERS }, (_, i) => TEST_CHAPTERS - i).map((n) => ({
    id: chapterId(t, n),
    number: n,
    name: `Chapter ${n}`,
    uploadedAt: newest - (TEST_CHAPTERS - n) * week,
    scanlator: t.sourceName,
  }));
}

/** A test chapter, by its id: which series and which number. */
export function testChapter(id: string): { t: TestSeries; n: number } | null {
  if (!testOn()) return null;
  for (const t of ALL) {
    if (id.startsWith(t.mangaId) && id.length === t.mangaId.length + 3) {
      const n = Number(id.slice(t.mangaId.length));
      if (n >= 1 && n <= TEST_CHAPTERS) return { t, n };
    }
  }
  return null;
}

export function testPages(id: string): string[] | null {
  const c = testChapter(id);
  if (!c) return null;
  return Array.from({ length: TEST_PAGES }, (_, i) => `/api/v1/manga/${c.t.mangaId}/chapter/${id}/page/${i}`);
}

/* ---- The pictures ---- */

const PAGE_PATH = /^\/api\/v1\/manga\/(\d+)\/chapter\/(\d+)\/page\/(\d+)$/;
const made = new Map<string, { body: Buffer; type: string }>();

/**
 * A page's picture, for a test page path, or null for any other. Test B's
 * refuse after a moment, as a site blocking the request does (`PageFetchError`,
 * a 502), so the reader's second go, its "try again" and "read this chapter
 * from another source" all come into play.
 */
export function testPageFor(path: string): Promise<{ body: Buffer; type: string }> | null {
  const m = PAGE_PATH.exec(path);
  if (!m) return null;
  const t = testByManga(m[1]);
  const c = t ? testChapter(m[2]!) : null;
  if (!t || !c) return null;
  if (t.key === 'b') {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new PageFetchError('Test B source refused the page (set on Manga → More → Test series)', 502)), 600)
    );
  }
  const page = Number(m[3]);
  const key = `${t.key}:${c.n}:${page}`;
  const cached = made.get(key);
  if (cached) return Promise.resolve(cached);
  return drawPage(t, c.n, page).then((picture) => {
    made.set(key, picture);
    if (made.size > 200) made.delete(made.keys().next().value!);
    return picture;
  });
}

const HUES = [210, 28, 140, 280, 350, 180, 50, 100, 250, 320, 10, 160];

/** A page, drawn: the series, chapter and page in large type over a colour per chapter, as a PNG. */
async function drawPage(t: TestSeries, chapter: number, page: number): Promise<{ body: Buffer; type: string }> {
  const W = 800;
  const H = 1150;
  const hue = HUES[(chapter - 1) % HUES.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="hsl(${hue},45%,92%)"/>
  <rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="hsl(${hue},45%,35%)" stroke-width="6"/>
  <text x="50%" y="300" font-family="Segoe UI, Arial, sans-serif" font-size="90" font-weight="700" text-anchor="middle" fill="hsl(${hue},45%,25%)">${t.title}</text>
  <text x="50%" y="470" font-family="Segoe UI, Arial, sans-serif" font-size="70" text-anchor="middle" fill="hsl(${hue},45%,30%)">Chapter ${chapter}</text>
  <text x="50%" y="700" font-family="Segoe UI, Arial, sans-serif" font-size="220" font-weight="700" text-anchor="middle" fill="hsl(${hue},45%,35%)">${page + 1}</text>
  <text x="50%" y="800" font-family="Segoe UI, Arial, sans-serif" font-size="48" text-anchor="middle" fill="hsl(${hue},45%,35%)">page ${page + 1} of ${TEST_PAGES}</text>
  <text x="50%" y="${H - 90}" font-family="Segoe UI, Arial, sans-serif" font-size="32" text-anchor="middle" fill="hsl(${hue},30%,45%)">a test page, made on this PC</text>
</svg>`;
  try {
    const mod = await import('sharp');
    const sharp = (mod.default ?? mod) as unknown as (input: Buffer) => { png: () => { toBuffer: () => Promise<Buffer> } };
    return { body: await sharp(Buffer.from(svg)).png().toBuffer(), type: 'image/png' };
  } catch {
    // No sharp: a plain page in the chapter's colour, with no words.
    return { body: plainPng(W, H, hue), type: 'image/png' };
  }
}

/** A one-colour PNG, written by hand, for when sharp will not load. */
function plainPng(w: number, h: number, hue: number): Buffer {
  const [r, g, b] = hslToRgb(hue / 360, 0.45, 0.85);
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}
