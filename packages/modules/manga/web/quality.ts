/**
 * How big the pictures this device asks for are: for reading, and for saving
 * chapters onto it. The PC makes the smaller copies (`server/compress.ts`);
 * this decides which to ask for. No imports, so `manga-check` can drive it.
 *
 * Per device, like the reader's other settings: a phone on a weak connection
 * and a PC on a cable want different answers, and space is a fact about the
 * device in your hand.
 *
 * **Automatic** (reading only, and the default) watches how fast pages arrive
 * and asks for smaller ones while the connection is slow, and full ones again
 * once it is not. What it measures is the connection, not the PC: the server
 * says how long it spent on a page before sending it (`x-made-in`), fetching
 * from a slow site included, and that is taken off. Three pages are fetched at
 * once, so each one's speed is multiplied by how many were going together.
 * Pages under 60KB say more about the round trip than the speed and are left
 * out. Its last answer is kept for half an hour, so a reload on a weak
 * connection starts small rather than relearning it on a 4MB page.
 */

export type Quality = 'original' | 'smaller' | 'smallest';
export type ReadingQuality = Quality | 'auto';
export type QualityPrefs = { reading: ReadingQuality; downloads: Quality };

const KEY = 'manga.quality';
const LEARNED = 'manga.quality.learned';
const QUALITIES: readonly string[] = ['original', 'smaller', 'smallest'];

/** Bytes a millisecond (about KB a second): at or above, full pictures; above the second, smaller. */
export const FAST = 1500;
export const SLOW = 400;
const MIN_SAMPLE = 60 * 1024;
const KEEP_MS = 30 * 60 * 1000;

export function qualityPrefs(): QualityPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof QualityPrefs, unknown>>;
    return {
      reading: raw.reading === 'auto' || QUALITIES.includes(raw.reading as string) ? (raw.reading as ReadingQuality) : 'auto',
      downloads: QUALITIES.includes(raw.downloads as string) ? (raw.downloads as Quality) : 'original',
    };
  } catch {
    return { reading: 'auto', downloads: 'original' };
  }
}

export function setQualityPrefs(change: Partial<QualityPrefs>): QualityPrefs {
  const next = { ...qualityPrefs(), ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the choice lasts as long as this page.
  }
  return next;
}

/** A speed (bytes a millisecond) to the level Automatic asks for. */
export function levelForSpeed(speed: number): Quality {
  return speed >= FAST ? 'original' : speed >= SLOW ? 'smaller' : 'smallest';
}

/** The speed measured so far, smoothed: null until a page big enough has arrived. */
let speed: number | null = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(LEARNED) ?? 'null') as { speed?: unknown; at?: unknown } | null;
    return raw && typeof raw.speed === 'number' && typeof raw.at === 'number' && Date.now() - raw.at < KEEP_MS ? raw.speed : null;
  } catch {
    return null;
  }
})();
let inFlight = 0;

/**
 * One page's speed, as the connection carried it: its size over the time it
 * spent travelling (`elapsed` less what the server said it spent first), times
 * how many were travelling together. Exported to be asserted.
 */
export function sampleSpeed(bytes: number, elapsedMs: number, madeInMs: number, together: number): number | null {
  if (bytes < MIN_SAMPLE) return null;
  const travelling = Math.max(20, elapsedMs - Math.max(0, madeInMs));
  return (bytes / travelling) * Math.max(1, together);
}

/** Called as a page request starts; the function it returns is called with what arrived. */
export function beginTransfer(): (bytes: number, madeInMs: number) => void {
  const started = Date.now();
  const together = ++inFlight;
  let finished = false;
  return (bytes, madeInMs) => {
    if (finished) return;
    finished = true;
    inFlight = Math.max(0, inFlight - 1);
    const sample = sampleSpeed(bytes, Date.now() - started, madeInMs, together);
    if (sample === null) return;
    // Mostly the last few pages: a connection that has just got better or worse is the one that matters.
    speed = speed === null ? sample : speed * 0.6 + sample * 0.4;
    try {
      localStorage.setItem(LEARNED, JSON.stringify({ speed, at: Date.now() }));
    } catch {
      // Not kept; measured again next time.
    }
  };
}

/** What reading asks for now. */
export function readingLevel(): Quality {
  const { reading } = qualityPrefs();
  if (reading !== 'auto') return reading;
  return speed === null ? 'original' : levelForSpeed(speed);
}

/** What Automatic would pick now, and the speed it is going on, for the settings to show. */
export function automaticNow(): { level: Quality; speed: number | null } {
  return { level: speed === null ? 'original' : levelForSpeed(speed), speed };
}

/** A page's address asking for that level. */
export function withQuality(path: string, level: Quality): string {
  return level === 'original' ? path : `${path}${path.includes('?') ? '&' : '?'}q=${level}`;
}
