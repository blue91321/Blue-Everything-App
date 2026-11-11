/**
 * Waits that land on the millisecond, for a macro's Wait box.
 *
 * Windows wakes a program's timers every 15.6 ms unless it asks for finer, so
 * "wait 20 ms" took 30.8 and "wait 5 ms" took 15.4 (measured on this PC). A
 * process can ask with `timeBeginPeriod(1)`, and since Windows 10 that is its
 * own business rather than the whole machine's; the agent asks while it presses
 * keys. Here it is asked only while a short wait is under way and given back
 * after, counted, so a dozen runs waiting at once ask once.
 *
 * **It is the one Windows call in this package's server half, and it is fenced.**
 * The server is meant to run anywhere, Docker included: off Windows nothing is
 * loaded (timers there are on time already), and if koffi cannot be loaded the
 * wait falls back to sleeping to just short of the time and checking closely
 * for the last 17 ms. That fallback is on time too but costs the processor:
 * measured, over half a core during a loop of 20 ms waits, against none for
 * the finer timer.
 */

interface Period {
  begin(): void;
  end(): void;
}

let period: Period | null = null;
let tried = false;

async function load(): Promise<void> {
  if (tried) return;
  tried = true;
  if (process.platform !== 'win32') return;
  try {
    const koffi = (await import('koffi')).default;
    const winmm = koffi.load('winmm.dll');
    const begin = winmm.func('uint32_t __stdcall timeBeginPeriod(uint32_t ms)');
    const end = winmm.func('uint32_t __stdcall timeEndPeriod(uint32_t ms)');
    period = { begin: () => void begin(1), end: () => void end(1) };
  } catch {
    period = null;
  }
}

/** Started when the package loads, so the first wait does not pay for it. */
export const fineTimerReady = load();

/** Waits at least this long gain nothing worth a finer timer: 15 ms in a second is one and a half percent. */
const SHORT_MS = 2000;
let holders = 0;

/**
 * For the length of one wait: the finer timer if this is Windows and it could
 * be had, and how much of the end to check closely instead (17 ms where it
 * could not, 0 otherwise). Call `release` when the wait ends, however it ends.
 */
export function forWait(ms: number): { closeMs: number; release: () => void } {
  if (process.platform !== 'win32' || ms >= SHORT_MS) return { closeMs: 0, release: () => undefined };
  if (!period) return { closeMs: 17, release: () => undefined };
  if (holders++ === 0) period.begin();
  let released = false;
  return {
    closeMs: 0,
    release: () => {
      if (released) return;
      released = true;
      if (--holders === 0) period?.end();
    },
  };
}
