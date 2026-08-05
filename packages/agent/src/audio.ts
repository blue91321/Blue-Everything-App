/**
 * Is this PC playing sound right now?
 *
 * The point of this file: keyboard idle time cannot tell "away from the desk"
 * apart from "watching a video", and those need opposite behaviour. Audio
 * output is the signal that separates them — a video, a stream, or a call all
 * render audio; an empty chair does not.
 *
 * This talks to WASAPI through COM, which means reading vtables by hand. There
 * is no friendlier route: `powercfg /requests` needs admin, and the audio
 * interfaces are not automation-friendly, so nothing simpler exists.
 */
import koffi from 'koffi';

const ole32 = koffi.load('ole32.dll');

const CoInitializeEx = ole32.func('int __stdcall CoInitializeEx(void *reserved, uint32_t coInit)');
const CoCreateInstance = ole32.func(
  'int __stdcall CoCreateInstance(const uint8_t *rclsid, void *pUnkOuter, uint32_t dwClsContext, const uint8_t *riid, _Out_ void **ppv)'
);

const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_ALL = 0x17;

/** `{BCDE0395-...}` text form to the little-endian byte layout COM expects. */
function guid(text: string): Uint8Array {
  const hex = text.replace(/[{}-]/g, '');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

  // First three fields are little-endian; the last eight bytes are not.
  const swap = (i: number, j: number) => {
    const t = b[i];
    b[i] = b[j];
    b[j] = t;
  };
  swap(0, 3);
  swap(1, 2);
  swap(4, 5);
  swap(6, 7);
  return b;
}

const CLSID_MMDeviceEnumerator = guid('BCDE0395-E52F-467C-8E3D-C4579291692E');
const IID_IMMDeviceEnumerator = guid('A95664D2-9614-4F35-A746-DE8DB63617E6');
const IID_IAudioMeterInformation = guid('C02216F6-8C67-4B5B-9D00-D008E73E0064');

const eRender = 0;
const eMultimedia = 1;

/* Vtable slots. 0-2 are always IUnknown's QueryInterface/AddRef/Release. */
const GetDefaultAudioEndpointProto = koffi.proto(
  'int __stdcall GetDefaultAudioEndpoint(void *self, int dataFlow, int role, _Out_ void **device)'
);
const ActivateProto = koffi.proto(
  'int __stdcall Activate(void *self, const uint8_t *iid, uint32_t clsCtx, void *params, _Out_ void **out)'
);
const GetPeakValueProto = koffi.proto('int __stdcall GetPeakValue(void *self, _Out_ float *peak)');
const ReleaseProto = koffi.proto('uint32_t __stdcall Release(void *self)');

const POINTER_SIZE = koffi.sizeof('void *');

/**
 * Read slot `index` out of a COM object's vtable.
 *
 * A COM interface pointer points at a pointer to its vtable, so this is two
 * dereferences: object -> vtable -> the function pointer in that slot. The
 * result is called with `koffi.call`, which invokes a raw address against a
 * prototype.
 */
function vtableSlot(instance: unknown, index: number): unknown {
  const table = koffi.decode(instance, 'void *');
  return koffi.decode(table, index * POINTER_SIZE, 'void *');
}

type PeakReader = { getPeak(): number; dispose(): void };

let cached: PeakReader | null = null;
let failed = false;

/**
 * Hold the meter open across polls. Re-acquiring the endpoint every few seconds
 * would be far more expensive than reading the level from one already open.
 */
function meter(): PeakReader | null {
  if (cached) return cached;
  if (failed) return null;

  try {
    // S_OK or S_FALSE (already initialised) are both fine; RPC_E_CHANGED_MODE
    // would mean someone else picked a different apartment, which is not fatal
    // for this use.
    CoInitializeEx(null, COINIT_APARTMENTTHREADED);

    const enumeratorOut: unknown[] = [null];
    if (CoCreateInstance(CLSID_MMDeviceEnumerator, null, CLSCTX_ALL, IID_IMMDeviceEnumerator, enumeratorOut) !== 0) {
      throw new Error('could not create the device enumerator');
    }
    const enumerator = enumeratorOut[0];

    const deviceOut: unknown[] = [null];
    const hrDevice = koffi.call(
      vtableSlot(enumerator, 4),
      GetDefaultAudioEndpointProto,
      enumerator,
      eRender,
      eMultimedia,
      deviceOut
    );
    if (hrDevice !== 0) throw new Error(`no default playback device (0x${(hrDevice >>> 0).toString(16)})`);
    const device = deviceOut[0];

    const meterOut: unknown[] = [null];
    const hrMeter = koffi.call(
      vtableSlot(device, 3),
      ActivateProto,
      device,
      IID_IAudioMeterInformation,
      CLSCTX_ALL,
      null,
      meterOut
    );
    if (hrMeter !== 0) throw new Error(`could not open the peak meter (0x${(hrMeter >>> 0).toString(16)})`);
    const audioMeter = meterOut[0];

    const getPeakSlot = vtableSlot(audioMeter, 3);

    cached = {
      getPeak() {
        const out = [0];
        return koffi.call(getPeakSlot, GetPeakValueProto, audioMeter, out) === 0 ? out[0] : 0;
      },
      dispose() {
        koffi.call(vtableSlot(audioMeter, 2), ReleaseProto, audioMeter);
        koffi.call(vtableSlot(device, 2), ReleaseProto, device);
        koffi.call(vtableSlot(enumerator, 2), ReleaseProto, enumerator);
        cached = null;
      },
    };
    return cached;
  } catch (error) {
    // A machine with no sound card, or a locked-down COM policy. Recorded once
    // and then never retried, so a broken setup costs nothing per poll.
    failed = true;
    console.error(`audio detection unavailable: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Above pure digital silence. Media output sits far above this even during a
 * quiet passage, while a silent desktop reads exactly 0.
 */
export const SILENCE_THRESHOLD = 0.0001;

export interface AudioReading {
  /** Peak output level, 0 to 1. */
  peak: number;
  playing: boolean;
  /** False when the meter could not be opened at all — treat as "don't know". */
  available: boolean;
}

export function readAudio(): AudioReading {
  const reader = meter();
  if (!reader) return { peak: 0, playing: false, available: false };

  const peak = reader.getPeak();
  return { peak, playing: peak > SILENCE_THRESHOLD, available: true };
}

/**
 * How long after the last sound the PC still counts as "something is playing".
 *
 * A single reading is not enough on its own: speech dips to near silence
 * between words, so one sample can land in a gap and report a playing video as
 * a quiet room. Remembering the last time sound was heard costs nothing and
 * bridges those gaps, unlike sampling in a tight loop which would burn CPU on
 * every poll forever.
 */
export const AUDIO_MEMORY_MS = 2 * 60_000;

let lastHeardAt = 0;

/** Has anything played recently? Call once per poll. */
export function audioRecentlyPlaying(now = Date.now()): { playing: boolean; peak: number; available: boolean } {
  const reading = readAudio();
  if (!reading.available) return { playing: false, peak: 0, available: false };
  if (reading.playing) lastHeardAt = now;

  return { playing: now - lastHeardAt < AUDIO_MEMORY_MS, peak: reading.peak, available: true };
}

export function disposeAudio(): void {
  cached?.dispose();
}
