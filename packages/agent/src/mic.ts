/**
 * Microphone capture, without a native module.
 *
 * This is the `waveIn` API out of winmm.dll — the oldest and simplest audio
 * input on Windows, and the only one reachable from plain FFI without a COM
 * apartment. `audio.ts` already reads the *output* meter through WASAPI vtables
 * by hand; this is the same trick applied to input, and for the same reason:
 * adding a native build step to a Node service that has none is a far bigger
 * cost than a page of struct offsets.
 *
 * The one design decision worth knowing about: **no callback**. waveIn will
 * call you back on a driver thread, and a driver thread reaching into V8 is a
 * crash waiting to happen — koffi would have to marshal into the Node event
 * loop from a thread Node knows nothing about. Instead the buffers are polled:
 * hand the driver a ring of them, then check `dwFlags` for `WHDR_DONE` on a
 * timer. Costs one struct decode per buffer per poll, needs no threading, and
 * is trivially debuggable.
 */
import koffi from 'koffi';

const winmm = koffi.load('winmm.dll');

/* ------------------------------------------------------------------ */
/* Structs                                                             */
/* ------------------------------------------------------------------ */

const WAVEFORMATEX = koffi.struct('WAVEFORMATEX', {
  wFormatTag: 'uint16_t',
  nChannels: 'uint16_t',
  nSamplesPerSec: 'uint32_t',
  nAvgBytesPerSec: 'uint32_t',
  nBlockAlign: 'uint16_t',
  wBitsPerSample: 'uint16_t',
  cbSize: 'uint16_t',
});

const WAVEHDR = koffi.struct('WAVEHDR', {
  lpData: 'void *',
  dwBufferLength: 'uint32_t',
  dwBytesRecorded: 'uint32_t',
  dwUser: 'uintptr_t',
  dwFlags: 'uint32_t',
  dwLoops: 'uint32_t',
  lpNext: 'void *',
  reserved: 'uintptr_t',
});

const WAVEINCAPSW = koffi.struct('WAVEINCAPSW', {
  wMid: 'uint16_t',
  wPid: 'uint16_t',
  vDriverVersion: 'uint32_t',
  szPname: koffi.array('uint16_t', 32),
  dwFormats: 'uint32_t',
  wChannels: 'uint16_t',
  wReserved1: 'uint16_t',
});

/* ------------------------------------------------------------------ */
/* Functions                                                           */
/* ------------------------------------------------------------------ */

const waveInGetNumDevs = winmm.func('uint32_t __stdcall waveInGetNumDevs()');
const waveInGetDevCapsW = winmm.func(
  'uint32_t __stdcall waveInGetDevCapsW(uintptr_t deviceId, _Out_ void *caps, uint32_t size)'
);
const waveInOpen = winmm.func(
  'uint32_t __stdcall waveInOpen(_Out_ void **handle, uint32_t deviceId, const void *format, uintptr_t callback, uintptr_t instance, uint32_t flags)'
);
const waveInPrepareHeader = winmm.func(
  'uint32_t __stdcall waveInPrepareHeader(void *handle, void *header, uint32_t size)'
);
const waveInUnprepareHeader = winmm.func(
  'uint32_t __stdcall waveInUnprepareHeader(void *handle, void *header, uint32_t size)'
);
const waveInAddBuffer = winmm.func('uint32_t __stdcall waveInAddBuffer(void *handle, void *header, uint32_t size)');
const waveInStart = winmm.func('uint32_t __stdcall waveInStart(void *handle)');
const waveInStop = winmm.func('uint32_t __stdcall waveInStop(void *handle)');
const waveInReset = winmm.func('uint32_t __stdcall waveInReset(void *handle)');
const waveInClose = winmm.func('uint32_t __stdcall waveInClose(void *handle)');

const WAVE_FORMAT_PCM = 1;
const WAVE_MAPPER = 0xffffffff;
const CALLBACK_NULL = 0;
const WHDR_DONE = 0x1;
const WHDR_PREPARED = 0x2;
const MMSYSERR_NOERROR = 0;

/**
 * 16kHz mono 16-bit.
 *
 * Not a compromise — it is exactly what the speech models want. Vosk resamples
 * anything else internally, so capturing at 48kHz would mean moving three times
 * the bytes for the privilege of throwing two thirds of them away.
 */
export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

/** ~100ms of audio per buffer, and enough of them to ride out a stalled loop. */
const BUFFER_MS = 100;
const BUFFER_COUNT = 8;
const BUFFER_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * BUFFER_MS) / 1000;

export class MicrophoneError extends Error {}

export interface MicrophoneDevice {
  id: number;
  name: string;
  channels: number;
}

/** What Windows thinks is plugged in. Only used by the setup CLI. */
export function listMicrophones(): MicrophoneDevice[] {
  const count = waveInGetNumDevs();
  const size = koffi.sizeof(WAVEINCAPSW);
  const devices: MicrophoneDevice[] = [];

  for (let id = 0; id < count; id++) {
    const caps = koffi.alloc(WAVEINCAPSW, 1);
    if (waveInGetDevCapsW(id, caps, size) !== MMSYSERR_NOERROR) continue;

    const decoded = koffi.decode(caps, WAVEINCAPSW) as { szPname: number[]; wChannels: number };
    // szPname is a fixed 32-WCHAR field, NUL-padded rather than trimmed.
    const name = String.fromCharCode(...decoded.szPname.slice(0, decoded.szPname.indexOf(0) + 1 || 32)).replace(/\0/g, '');
    devices.push({ id, name: name.trim(), channels: decoded.wChannels });
  }

  return devices;
}

/**
 * Resolve a saved device *name* to the index waveIn wants.
 *
 * Settings store the name because Windows renumbers inputs whenever something
 * is plugged in or unplugged — a saved index would silently start meaning a
 * different microphone. Returns null when the named device is gone, which the
 * caller reports rather than quietly falling back, because "it stopped hearing
 * me" and "your headset is unplugged" want very different reactions.
 *
 * Matched on prefix: `waveInGetDevCapsW` truncates names to 31 characters, so
 * the stored "Headset Microphone (5- Arctis Pro Wireless)" and the reported
 * "Headset Microphone (5- Arctis P" are the same device.
 */
export function findMicrophone(name: string | null | undefined): number | null {
  if (!name) return WAVE_MAPPER;

  const devices = listMicrophones();
  const wanted = name.trim().toLowerCase();
  const match = devices.find((device) => {
    const found = device.name.trim().toLowerCase();
    return found === wanted || wanted.startsWith(found) || found.startsWith(wanted);
  });

  return match ? match.id : null;
}

export interface Microphone {
  /**
   * Every complete buffer since the last call, as one block of samples.
   * Empty when nothing has finished yet — call it on a timer.
   */
  read(): Int16Array;
  close(): void;
}

interface Slot {
  header: unknown;
  data: unknown;
  /** Live view over the native block. Valid until the buffer is re-queued. */
  view: Int16Array;
}

/**
 * Open the microphone and start recording into a ring of buffers.
 *
 * `deviceId` defaults to WAVE_MAPPER, which follows whatever Windows currently
 * treats as the default input — so changing the default microphone in Windows
 * takes effect on the next restart rather than needing config here.
 */
export function openMicrophone(deviceId: number = WAVE_MAPPER): Microphone {
  const format = koffi.alloc(WAVEFORMATEX, 1);
  koffi.encode(format, WAVEFORMATEX, {
    wFormatTag: WAVE_FORMAT_PCM,
    nChannels: 1,
    nSamplesPerSec: SAMPLE_RATE,
    nAvgBytesPerSec: SAMPLE_RATE * BYTES_PER_SAMPLE,
    nBlockAlign: BYTES_PER_SAMPLE,
    wBitsPerSample: 8 * BYTES_PER_SAMPLE,
    cbSize: 0,
  });

  const handleOut: unknown[] = [null];
  const opened = waveInOpen(handleOut, deviceId, format, 0, 0, CALLBACK_NULL);
  if (opened !== MMSYSERR_NOERROR) {
    throw new MicrophoneError(
      opened === 32 // MMSYSERR_ALLOCATED
        ? 'the microphone is in use by another application'
        : `could not open the microphone (waveInOpen returned ${opened})`
    );
  }
  const handle = handleOut[0];

  const headerSize = koffi.sizeof(WAVEHDR);
  const slots: Slot[] = [];

  for (let i = 0; i < BUFFER_COUNT; i++) {
    // koffi.alloc gives a stable address that outlives the call, which is the
    // whole requirement here: the driver writes into this memory later, from
    // another thread. A pooled Node Buffer would be the wrong tool.
    const data = koffi.alloc('uint8_t', BUFFER_BYTES);
    const header = koffi.alloc(WAVEHDR, 1);

    koffi.encode(header, WAVEHDR, {
      lpData: data,
      dwBufferLength: BUFFER_BYTES,
      dwBytesRecorded: 0,
      dwUser: 0,
      dwFlags: 0,
      dwLoops: 0,
      lpNext: null,
      reserved: 0,
    });

    if (waveInPrepareHeader(handle, header, headerSize) !== MMSYSERR_NOERROR) {
      throw new MicrophoneError('waveInPrepareHeader failed');
    }
    if (waveInAddBuffer(handle, header, headerSize) !== MMSYSERR_NOERROR) {
      throw new MicrophoneError('waveInAddBuffer failed');
    }

    slots.push({ header, data, view: new Int16Array(koffi.view(data, BUFFER_BYTES)) });
  }

  if (waveInStart(handle) !== MMSYSERR_NOERROR) throw new MicrophoneError('waveInStart failed');

  let closed = false;
  /** Buffers come back in the order they were queued, so this walks the ring. */
  let next = 0;

  return {
    read(): Int16Array {
      if (closed) return new Int16Array(0);

      const ready: Int16Array[] = [];
      let total = 0;

      // Stop at the first buffer that isn't finished. Taking them out of order
      // would silently reorder the audio, which sounds like nothing at all to
      // a speech model.
      for (let checked = 0; checked < BUFFER_COUNT; checked++) {
        const slot = slots[next];
        const state = koffi.decode(slot.header, WAVEHDR) as { dwFlags: number; dwBytesRecorded: number };
        if ((state.dwFlags & WHDR_DONE) === 0) break;

        const samples = state.dwBytesRecorded / BYTES_PER_SAMPLE;
        // Copy: the view aliases native memory that is about to be handed back
        // to the driver and overwritten.
        if (samples > 0) {
          ready.push(slot.view.slice(0, samples));
          total += samples;
        }

        // Re-queue. The header stays prepared; clearing the flags back to
        // PREPARED is what makes waveInAddBuffer accept it again.
        koffi.encode(slot.header, WAVEHDR, {
          lpData: slot.data,
          dwBufferLength: BUFFER_BYTES,
          dwBytesRecorded: 0,
          dwUser: 0,
          dwFlags: WHDR_PREPARED,
          dwLoops: 0,
          lpNext: null,
          reserved: 0,
        });
        waveInAddBuffer(handle, slot.header, headerSize);

        next = (next + 1) % BUFFER_COUNT;
      }

      if (ready.length === 0) return new Int16Array(0);
      if (ready.length === 1) return ready[0];

      const merged = new Int16Array(total);
      let offset = 0;
      for (const block of ready) {
        merged.set(block, offset);
        offset += block.length;
      }
      return merged;
    },

    close(): void {
      if (closed) return;
      closed = true;

      // Order matters: reset returns every queued buffer, and unpreparing one
      // that is still in the driver's queue fails and leaks it.
      waveInStop(handle);
      waveInReset(handle);
      for (const slot of slots) waveInUnprepareHeader(handle, slot.header, headerSize);
      waveInClose(handle);
    },
  };
}

/**
 * Root-mean-square level of a block, 0 to 1.
 *
 * The gate in front of the recogniser: a silent room should cost nothing, and
 * without this the speech model would run on every second of every day whether
 * or not there was anything to hear.
 */
export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}
