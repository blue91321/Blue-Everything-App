/**
 * A small window that appears over everything, for talking back.
 *
 * ### It is core, not part of voice
 *
 * It was built for voice and lived inside that feature, which made it deletable
 * along with the microphone — and meant nudges could not use the one surface in
 * this app that reliably appears **above an exclusive-fullscreen game**. That is
 * exactly backwards for an app whose entire premise is interrupting well: a
 * Windows toast raised the moment a match ends is a toast you may never see.
 *
 * So it moved up here. Voice imports it like anything else in core; deleting
 * `features/voice/` now takes the microphone and leaves the popup, which is the
 * right way round. `popup.ts` owns the single instance and the show/hide
 * timing, so callers never touch this directly.
 *
 * ### Why this is hand-rolled Win32 and not a UI framework
 *
 * The project rejected Electron at 150-250MB to draw a tray icon; it is not
 * going to accept it now to draw four lines of text. A borderless browser
 * window was the other candidate and fails the case that matters most — it
 * takes most of a second to appear and will not float above an exclusive
 * fullscreen game, which is exactly when you are talking rather than typing.
 *
 * So: `CreateWindowExW` and GDI through koffi, the same trick `audio.ts` uses
 * for WASAPI and `mic.ts` for waveIn. It costs a few MB, appears in about a
 * millisecond, and sits above everything. The price is that the UI is drawn by
 * hand, so it stays deliberately plain — a title, a couple of lines, and
 * buttons when there is a choice to make.
 *
 * ### The message pump
 *
 * Windows expects a thread that loops on `GetMessage`. Node already owns this
 * thread and its own loop, so instead the queue is *polled* with `PeekMessageW`
 * on a timer — 16ms while the window is up, 200ms while it is hidden simply to
 * drain strays. `DispatchMessageW` calls the window procedure synchronously on
 * this same thread, which is what makes a koffi callback safe here: nothing is
 * ever invoked from a thread V8 has not heard of.
 */
import koffi from 'koffi';
import { OVERLAY_GRID, placementCell } from '@everything/shared';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

/**
 * GDI+, purely to decode an image file.
 *
 * `LoadImageW` only understands BMP, and you will pick a PNG or a JPG. The
 * alternative was decoding PNG in JavaScript — feasible, since node:zlib has
 * the inflate half, but it would be a hundred lines that only ever handle one
 * format. Eight GDI+ calls handle every format Windows knows.
 */
const gdiplus = koffi.load('gdiplus.dll');

/* ------------------------------------------------------------------ */
/* Structs                                                             */
/* ------------------------------------------------------------------ */

/* Names are prefixed because koffi's type registry is process-wide and
 * `win32.ts` already owns the unprefixed ones. A collision throws at import,
 * which takes the whole agent down before it starts. */
const POINT = koffi.struct('OverlayPOINT', { x: 'int32_t', y: 'int32_t' });
const RECT = koffi.struct('OverlayRECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });

const MSG = koffi.struct('OverlayMSG', {
  hwnd: 'void *',
  message: 'uint32_t',
  wParam: 'uintptr_t',
  lParam: 'intptr_t',
  time: 'uint32_t',
  pt: POINT,
});

const WNDCLASSEXW = koffi.struct('OverlayWNDCLASSEXW', {
  cbSize: 'uint32_t',
  style: 'uint32_t',
  lpfnWndProc: 'void *',
  cbClsExtra: 'int32_t',
  cbWndExtra: 'int32_t',
  hInstance: 'void *',
  hIcon: 'void *',
  hCursor: 'void *',
  hbrBackground: 'void *',
  lpszMenuName: 'void *',
  lpszClassName: 'const char16_t *',
  hIconSm: 'void *',
});

const PAINTSTRUCT = koffi.struct('OverlayPAINTSTRUCT', {
  hdc: 'void *',
  fErase: 'int32_t',
  rcPaint: RECT,
  fRestore: 'int32_t',
  fIncUpdate: 'int32_t',
  rgbReserved: koffi.array('uint8_t', 32),
});

const MONITORINFO = koffi.struct('OverlayMONITORINFO', {
  cbSize: 'uint32_t',
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: 'uint32_t',
});

/**
 * The EX form, which carries `szDevice` — the `\.\DISPLAY1` name.
 *
 * A chosen screen is stored by that name rather than by index, for the same
 * reason a microphone is: unplugging one renumbers the rest, and an index saved
 * today quietly means a different monitor tomorrow.
 */
const MONITORINFOEXW = koffi.struct('OverlayMONITORINFOEXW', {
  cbSize: 'uint32_t',
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: 'uint32_t',
  szDevice: koffi.array('uint16_t', 32),
});

const MonitorEnumProto = koffi.proto(
  'int __stdcall MonitorEnumProc(void *monitor, void *hdc, void *rect, intptr_t data)'
);

/* ------------------------------------------------------------------ */
/* Functions                                                           */
/* ------------------------------------------------------------------ */

const WndProcProto = koffi.proto(
  'intptr_t __stdcall WndProc(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)'
);

const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *name)');
const RegisterClassExW = user32.func('uint16_t __stdcall RegisterClassExW(const void *wc)');
const CreateWindowExW = user32.func(
  'void * __stdcall CreateWindowExW(uint32_t exStyle, const char16_t *className, const char16_t *windowName, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)'
);
const DestroyWindow = user32.func('int __stdcall DestroyWindow(void *hwnd)');
const DefWindowProcW = user32.func(
  'intptr_t __stdcall DefWindowProcW(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)'
);
const ShowWindow = user32.func('int __stdcall ShowWindow(void *hwnd, int cmd)');
const SetWindowPos = user32.func(
  'int __stdcall SetWindowPos(void *hwnd, intptr_t after, int x, int y, int w, int h, uint32_t flags)'
);
const InvalidateRect = user32.func('int __stdcall InvalidateRect(void *hwnd, const void *rect, int erase)');
const PeekMessageW = user32.func(
  'int __stdcall PeekMessageW(_Out_ void *msg, void *hwnd, uint32_t min, uint32_t max, uint32_t remove)'
);
const TranslateMessage = user32.func('int __stdcall TranslateMessage(const void *msg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const void *msg)');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ void *point)');
const GetClientRect = user32.func('int __stdcall GetClientRect(void *hwnd, _Out_ void *rect)');
const BeginPaint = user32.func('void * __stdcall BeginPaint(void *hwnd, _Out_ void *ps)');
const EndPaint = user32.func('int __stdcall EndPaint(void *hwnd, const void *ps)');
const FillRect = user32.func('int __stdcall FillRect(void *hdc, const void *rect, void *brush)');
const MonitorFromPoint = user32.func('void * __stdcall MonitorFromPoint(int64_t pt, uint32_t flags)');
const GetMonitorInfoW = user32.func('int __stdcall GetMonitorInfoW(void *monitor, _Out_ void *info)');
const EnumDisplayMonitors = user32.func(
  'int __stdcall EnumDisplayMonitors(void *hdc, const void *clip, void *callback, intptr_t data)'
);
const MonitorFromWindow = user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32_t flags)');

// DrawText lives in user32, not gdi32 — it is a layout helper built on top of
// GDI rather than a GDI primitive, and looking for it in the obvious library
// fails at load time with "cannot find function".
const DrawTextW = user32.func(
  'int __stdcall DrawTextW(void *hdc, const char16_t *text, int count, void *rect, uint32_t format)'
);

const CreateSolidBrush = gdi32.func('void * __stdcall CreateSolidBrush(uint32_t color)');
const DeleteObject = gdi32.func('int __stdcall DeleteObject(void *object)');
const SelectObject = gdi32.func('void * __stdcall SelectObject(void *hdc, void *object)');
const SetTextColor = gdi32.func('uint32_t __stdcall SetTextColor(void *hdc, uint32_t color)');
const SetBkMode = gdi32.func('int __stdcall SetBkMode(void *hdc, int mode)');
const CreateCompatibleDC = gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)');
const DeleteDC = gdi32.func('int __stdcall DeleteDC(void *hdc)');
const SetStretchBltMode = gdi32.func('int __stdcall SetStretchBltMode(void *hdc, int mode)');
const StretchBlt = gdi32.func(
  'int __stdcall StretchBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, int sw, int sh, uint32_t rop)'
);

const GdiplusStartupInput = koffi.struct('OverlayGdiplusStartupInput', {
  GdiplusVersion: 'uint32_t',
  DebugEventCallback: 'void *',
  SuppressBackgroundThread: 'int32_t',
  SuppressExternalCodecs: 'int32_t',
});

const GdiplusStartup = gdiplus.func(
  'int __stdcall GdiplusStartup(_Out_ uintptr_t *token, const void *input, void *output)'
);
const GdipCreateBitmapFromFile = gdiplus.func(
  'int __stdcall GdipCreateBitmapFromFile(const char16_t *file, _Out_ void **bitmap)'
);
const GdipCreateHBITMAPFromBitmap = gdiplus.func(
  'int __stdcall GdipCreateHBITMAPFromBitmap(void *bitmap, _Out_ void **hbitmap, uint32_t background)'
);
const GdipGetImageWidth = gdiplus.func('int __stdcall GdipGetImageWidth(void *image, _Out_ uint32_t *width)');
const GdipGetImageHeight = gdiplus.func('int __stdcall GdipGetImageHeight(void *image, _Out_ uint32_t *height)');
const GdipDisposeImage = gdiplus.func('int __stdcall GdipDisposeImage(void *image)');

const CreateFontW = gdi32.func(
  'void * __stdcall CreateFontW(int h, int w, int esc, int orient, int weight, uint32_t italic, uint32_t underline, uint32_t strikeout, uint32_t charset, uint32_t outPrec, uint32_t clipPrec, uint32_t quality, uint32_t pitch, const char16_t *face)'
);

/* Constants, named rather than inlined so the calls below read as Win32. */
const WS_POPUP = 0x80000000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TOOLWINDOW = 0x00000080;
/** Keeps focus where it is — the overlay must never steal it from a game. */
const WS_EX_NOACTIVATE = 0x08000000;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;
const HWND_TOPMOST = -1;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const WM_PAINT = 0x000f;
const WM_LBUTTONDOWN = 0x0201;
const WM_KEYDOWN = 0x0100;
const WM_DESTROY = 0x0002;
const PM_REMOVE = 0x0001;
const TRANSPARENT = 1;
const DT_LEFT = 0x0000;
const DT_WORDBREAK = 0x0010;
const DT_END_ELLIPSIS = 0x8000;
const DT_SINGLELINE = 0x0020;
const DT_VCENTER = 0x0004;
const DT_CENTER = 0x0001;
const MONITOR_DEFAULTTONEAREST = 0x00000002;
const HALFTONE = 4;
const SRCCOPY = 0x00cc0020;
const VK_ESCAPE = 0x1b;

/** GDI wants 0x00BBGGRR, which is the reverse of how anyone writes a colour. */
const rgb = (r: number, g: number, b: number): number => r | (g << 8) | (b << 16);

/** Matches the PWA's dark theme, so the two don't look like different apps. */
const COLOR = {
  background: rgb(0x1c, 0x1f, 0x27),
  border: rgb(0x2b, 0x30, 0x3c),
  text: rgb(0xe8, 0xe9, 0xed),
  muted: rgb(0x8b, 0x90, 0xa0),
  accent: rgb(0xff, 0xb4, 0x54),
  good: rgb(0x5f, 0xd1, 0x8c),
  bad: rgb(0xff, 0x6b, 0x6b),
  button: rgb(0x23, 0x27, 0x34),
};

const WIDTH = 380;
const PADDING = 14;
const LINE_HEIGHT = 22;
const BUTTON_HEIGHT = 30;

const wide = (value: string): string => value;

export interface Screen {
  /** `\\.\DISPLAY1`. Stable across restarts in a way an index is not. */
  id: string;
  /** What to call it on screen — "Screen 1 (2560×1440, primary)". */
  label: string;
  primary: boolean;
  work: { left: number; top: number; right: number; bottom: number };
}

/** Anchors, plus `cursor` for the original behaviour. */
/**
 * `cursor`, one of the nine original anchor names, or a `grid-RC` cell.
 *
 * A plain string rather than a union, because `placementCell` in `shared` is
 * the one thing that decides what a placement means — re-declaring the values
 * here would be a second list to keep in step, and the failure mode is a
 * position the settings screen offers and the agent silently ignores.
 */
export type Placement = string;

const MONITOR_PRIMARY = 0x1;

/**
 * Every screen Windows currently has, with its work area.
 *
 * The work area rather than the full bounds, so an anchored overlay sits above
 * the taskbar instead of under it.
 */
export function listScreens(): Screen[] {
  const screens: Screen[] = [];

  const onMonitor = (monitor: unknown): number => {
    const info = koffi.alloc(MONITORINFOEXW, 1);
    koffi.encode(info, MONITORINFOEXW, {
      cbSize: koffi.sizeof(MONITORINFOEXW),
      rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
      rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
      dwFlags: 0,
      szDevice: new Array(32).fill(0),
    });

    if (GetMonitorInfoW(monitor, info)) {
      const decoded = koffi.decode(info, MONITORINFOEXW) as {
        rcWork: Screen['work'];
        rcMonitor: Screen['work'];
        dwFlags: number;
        szDevice: number[];
      };
      const end = decoded.szDevice.indexOf(0);
      const id = String.fromCharCode(...decoded.szDevice.slice(0, end === -1 ? 32 : end));
      const width = decoded.rcMonitor.right - decoded.rcMonitor.left;
      const height = decoded.rcMonitor.bottom - decoded.rcMonitor.top;
      const primary = (decoded.dwFlags & MONITOR_PRIMARY) !== 0;

      screens.push({
        id,
        label: `Screen ${screens.length + 1} (${width}×${height}${primary ? ', primary' : ''})`,
        primary,
        work: decoded.rcWork,
      });
    }
    return 1; // keep enumerating
  };

  // Registered and released per call: this runs when the settings screen asks,
  // not on any hot path, and a permanently registered callback is one more
  // thing to keep alive for no gain.
  const callback = koffi.register(onMonitor, koffi.pointer(MonitorEnumProto));
  try {
    EnumDisplayMonitors(null, null, callback, 0);
  } finally {
    koffi.unregister(callback);
  }

  return screens;
}

export type Tone = 'normal' | 'muted' | 'good' | 'bad' | 'accent';

export interface OverlayLine {
  text: string;
  tone?: Tone;
}

export interface OverlayChoice {
  id: string;
  label: string;
}

export interface OverlayContent {
  title: string;
  lines?: OverlayLine[];
  choices?: OverlayChoice[];
}

/**
 * The face on the left of the popup.
 *
 * Either a short run of text — an emoji, which Windows draws in colour from
 * Segoe UI Emoji and which needs no file at all — or an image on disk. Built-in
 * options are emoji for exactly that reason: no binaries in the repo, matching
 * how the app icons are generated rather than checked in.
 */
export interface Avatar {
  kind: 'none' | 'emoji' | 'image';
  /** The emoji itself, or an absolute path to the image. */
  value: string;
}

const AVATAR_SIZE = 44;

/** Loaded once per path and kept; decoding a PNG per popup would be silly. */
let gdiplusToken: unknown = null;
const imageCache = new Map<string, { bitmap: unknown; width: number; height: number } | null>();

function startGdiplus(): boolean {
  if (gdiplusToken) return true;
  try {
    const input = koffi.alloc(GdiplusStartupInput, 1);
    koffi.encode(input, GdiplusStartupInput, {
      GdiplusVersion: 1,
      DebugEventCallback: null,
      SuppressBackgroundThread: 0,
      SuppressExternalCodecs: 0,
    });
    const token: unknown[] = [null];
    if (GdiplusStartup(token, input, null) !== 0) return false;
    gdiplusToken = token[0];
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode an image to an HBITMAP, or null if it cannot be read.
 *
 * A failure is cached too: a path that is gone should cost one failed decode,
 * not one per popup forever.
 */
function loadImage(path: string): { bitmap: unknown; width: number; height: number } | null {
  if (imageCache.has(path)) return imageCache.get(path) ?? null;

  let result: { bitmap: unknown; width: number; height: number } | null = null;

  if (startGdiplus()) {
    const out: unknown[] = [null];
    if (GdipCreateBitmapFromFile(path, out) === 0 && out[0]) {
      const image = out[0];
      const width: number[] = [0];
      const height: number[] = [0];
      GdipGetImageWidth(image, width);
      GdipGetImageHeight(image, height);

      const hbitmap: unknown[] = [null];
      // The background is what shows through transparency; matching the popup
      // means a PNG with an alpha channel does not come out on a white square.
      if (GdipCreateHBITMAPFromBitmap(image, hbitmap, 0xff1c1f27) === 0 && hbitmap[0]) {
        result = { bitmap: hbitmap[0], width: width[0], height: height[0] };
      }
      GdipDisposeImage(image);
    }
  }

  imageCache.set(path, result);
  return result;
}

/**
 * Could that picture be decoded, and at what size?
 *
 * Drawing failure is otherwise silent — `drawAvatar` just leaves the gutter
 * empty — so this is how the agent can report "that file could not be read"
 * rather than leaving you to wonder why your avatar never appears.
 */
export function probeAvatar(path: string): { width: number; height: number } | null {
  const image = loadImage(path);
  return image ? { width: image.width, height: image.height } : null;
}

/** Drop a cached image so a replaced file is picked up rather than remembered. */
export function forgetAvatar(path: string): void {
  const cached = imageCache.get(path);
  if (cached) DeleteObject(cached.bitmap);
  imageCache.delete(path);
}

export interface OverlayPlacement {
  mode: Placement;
  /** Device name of the screen to anchor to; null follows the mouse. */
  screen: string | null;
}

export interface Overlay {
  show(content: OverlayContent): void;
  hide(): void;
  /** Where to appear, and what face to wear. Applied on the next `show`. */
  configure(next: { placement?: OverlayPlacement; avatar?: Avatar }): void;
  readonly visible: boolean;
  destroy(): void;
}

export class OverlayUnavailable extends Error {}

/**
 * One window, created once and shown or hidden.
 *
 * Recreating it per utterance would be simpler to reason about but wastes the
 * registration and creation each time, and this is meant to appear the instant
 * the wake word lands.
 */
export function createOverlay(handlers: {
  onChoice: (id: string) => void;
  onDismiss: () => void;
}): Overlay {
  const instance = GetModuleHandleW(null);
  const className = 'EverythingOverlay';

  let content: OverlayContent = { title: '' };
  let placement: OverlayPlacement = { mode: 'cursor', screen: null };
  let avatar: Avatar = { kind: 'none', value: '' };
  let buttons: { id: string; top: number; bottom: number }[] = [];
  let shown = false;
  let destroyed = false;

  /* --- the window procedure ------------------------------------- */

  const onMessage = (hwnd: unknown, msg: number, wparam: number, lparam: number): number => {
    if (msg === WM_PAINT) {
      paint(hwnd);
      return 0;
    }

    if (msg === WM_LBUTTONDOWN) {
      // lParam packs the click as two signed 16-bit values.
      const y = (lparam >> 16) & 0xffff;
      const hit = buttons.find((button) => y >= button.top && y <= button.bottom);
      if (hit) handlers.onChoice(hit.id);
      else handlers.onDismiss();
      return 0;
    }

    if (msg === WM_KEYDOWN && wparam === VK_ESCAPE) {
      handlers.onDismiss();
      return 0;
    }

    if (msg === WM_DESTROY) return 0;

    return Number(DefWindowProcW(hwnd, msg, wparam, lparam));
  };

  // Held in a variable so it is never garbage collected while Windows holds
  // the pointer — the callback outliving its JS reference is a hard crash.
  const wndProc = koffi.register(onMessage, koffi.pointer(WndProcProto));

  const wc = koffi.alloc(WNDCLASSEXW, 1);
  koffi.encode(wc, WNDCLASSEXW, {
    cbSize: koffi.sizeof(WNDCLASSEXW),
    style: 0,
    lpfnWndProc: wndProc,
    cbClsExtra: 0,
    cbWndExtra: 0,
    hInstance: instance,
    hIcon: null,
    hCursor: null,
    hbrBackground: null,
    lpszMenuName: null,
    lpszClassName: wide(className),
    hIconSm: null,
  });

  // A non-zero atom, or ERROR_CLASS_ALREADY_EXISTS from a previous run in the
  // same process — both fine. Only a genuine failure to create the window is.
  RegisterClassExW(wc);

  const hwnd = CreateWindowExW(
    WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
    wide(className),
    wide('Blue Everything'),
    WS_POPUP,
    0,
    0,
    WIDTH,
    120,
    null,
    null,
    instance,
    null
  );

  if (!hwnd) {
    koffi.unregister(wndProc);
    throw new OverlayUnavailable('could not create the overlay window');
  }

  /* --- painting -------------------------------------------------- */

  const background = CreateSolidBrush(COLOR.background);
  const borderBrush = CreateSolidBrush(COLOR.border);
  const buttonBrush = CreateSolidBrush(COLOR.button);

  const font = (size: number, weight: number) =>
    CreateFontW(-size, 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 5 /* CLEARTYPE */, 0, wide('Segoe UI'));

  const titleFont = font(16, 600);
  const bodyFont = font(15, 400);
  // Segoe UI Emoji is what makes a built-in avatar a colour glyph rather than
  // an outline, and it costs nothing to ship.
  const avatarFont = CreateFontW(-32, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, wide('Segoe UI Emoji'));

  const rectAt = (left: number, top: number, right: number, bottom: number): unknown => {
    const r = koffi.alloc(RECT, 1);
    koffi.encode(r, RECT, { left, top, right, bottom });
    return r;
  };

  const colorFor = (tone: Tone | undefined): number => {
    switch (tone) {
      case 'muted':
        return COLOR.muted;
      case 'good':
        return COLOR.good;
      case 'bad':
        return COLOR.bad;
      case 'accent':
        return COLOR.accent;
      default:
        return COLOR.text;
    }
  };

  function paint(target: unknown): void {
    const ps = koffi.alloc(PAINTSTRUCT, 1);
    const hdc = BeginPaint(target, ps);

    const clientRect = koffi.alloc(RECT, 1);
    GetClientRect(target, clientRect);
    const client = koffi.decode(clientRect, RECT) as { right: number; bottom: number };

    // Border first, then the background inset by one pixel. Cheaper than
    // stroking a rectangle and it cannot be off by a pixel.
    FillRect(hdc, rectAt(0, 0, client.right, client.bottom), borderBrush);
    FillRect(hdc, rectAt(1, 1, client.right - 1, client.bottom - 1), background);

    SetBkMode(hdc, TRANSPARENT);

    // The avatar sits in the left gutter; everything else shifts right by its
    // width so the two never overlap on a long title.
    const gutter = avatar.kind === 'none' ? 0 : AVATAR_SIZE + 12;
    if (gutter > 0) drawAvatar(hdc, PADDING, PADDING);
    const textLeft = PADDING + gutter;

    let y = PADDING;

    SelectObject(hdc, titleFont);
    SetTextColor(hdc, COLOR.accent);
    DrawTextW(
      hdc,
      wide(content.title),
      -1,
      rectAt(textLeft, y, client.right - PADDING, y + LINE_HEIGHT),
      DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS
    );
    y += LINE_HEIGHT + 4;

    SelectObject(hdc, bodyFont);
    for (const line of content.lines ?? []) {
      SetTextColor(hdc, colorFor(line.tone));
      DrawTextW(
        hdc,
        wide(line.text),
        -1,
        rectAt(textLeft, y, client.right - PADDING, y + LINE_HEIGHT * 2),
        DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS
      );
      y += LINE_HEIGHT * (line.text.length > 44 ? 2 : 1);
    }

    for (const button of buttons) {
      FillRect(hdc, rectAt(PADDING, button.top, client.right - PADDING, button.bottom), buttonBrush);
      SetTextColor(hdc, COLOR.text);
      DrawTextW(
        hdc,
        wide(content.choices?.find((c) => c.id === button.id)?.label ?? ''),
        -1,
        rectAt(PADDING, button.top, client.right - PADDING, button.bottom),
        DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS
      );
    }

    EndPaint(target, ps);
  }

  /* --- layout and placement -------------------------------------- */

  function heightFor(next: OverlayContent): number {
    const lines = (next.lines ?? []).reduce((total, line) => total + (line.text.length > 44 ? 2 : 1), 0);
    const choices = (next.choices ?? []).length;
    const text = PADDING * 2 + LINE_HEIGHT + 4 + lines * LINE_HEIGHT + choices * (BUTTON_HEIGHT + 6);
    // A one-line result beside a 44px face would otherwise clip the face.
    return avatar.kind === 'none' ? text : Math.max(text, PADDING * 2 + AVATAR_SIZE);
  }

  /** Where the mouse is, and which work area it falls in. */
  function cursorScreen(): { cursor: { x: number; y: number }; work: Screen['work'] | null } {
    const point = koffi.alloc(POINT, 1);
    GetCursorPos(point);
    const cursor = koffi.decode(point, POINT) as { x: number; y: number };

    const packed = BigInt(cursor.x & 0xffffffff) | (BigInt(cursor.y & 0xffffffff) << 32n);
    const monitor = MonitorFromPoint(packed, MONITOR_DEFAULTTONEAREST);
    if (!monitor) return { cursor, work: null };

    const info = koffi.alloc(MONITORINFO, 1);
    koffi.encode(info, MONITORINFO, {
      cbSize: koffi.sizeof(MONITORINFO),
      rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
      rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
      dwFlags: 0,
    });
    if (!GetMonitorInfoW(monitor, info)) return { cursor, work: null };

    return { cursor, work: (koffi.decode(info, MONITORINFO) as { rcWork: Screen['work'] }).rcWork };
  }

  const MARGIN = 24;

  /**
   * Put the window where you asked for it.
   *
   * `cursor` keeps the original behaviour — beside the pointer, flipped back
   * on-screen rather than clipped at an edge. Everything else anchors to a work
   * area: either a named screen, or whichever one the mouse is on, which is the
   * useful default for more than one monitor because it follows attention
   * without following the pointer around.
   */
  function place(height: number): void {
    const { cursor, work: cursorWork } = cursorScreen();

    // A named screen that has been unplugged falls back to the mouse's, rather
    // than putting the window somewhere that no longer exists.
    const named = placement.screen ? listScreens().find((s) => s.id === placement.screen) : undefined;
    const work = named?.work ?? cursorWork;

    const cell = placementCell(placement.mode);

    let x: number;
    let y: number;

    if (!cell || !work) {
      x = cursor.x + 16;
      y = cursor.y + 18;
      if (work) {
        if (x + WIDTH > work.right) x = cursor.x - WIDTH - 16;
        if (y + height > work.bottom) y = cursor.y - height - 18;
      }
    } else {
      /*
       * Interpolate across the work area rather than branching on names.
       *
       * The anchors used to be nine cases of left/middle/right; as a grid they
       * are one fraction per axis, which is both shorter and the reason a finer
       * grid cost nothing to add — 5×5 and 3×3 are the same arithmetic with a
       * different divisor.
       */
      const fx = (cell.col - 1) / (OVERLAY_GRID - 1);
      const fy = (cell.row - 1) / (OVERLAY_GRID - 1);

      const left = work.left + MARGIN;
      const top = work.top + MARGIN;
      // The span the window's top-left corner can occupy without any of it
      // leaving the margin — zero on a screen too small to hold it, which the
      // clamp below then resolves.
      const spanX = Math.max(0, work.right - MARGIN - WIDTH - left);
      const spanY = Math.max(0, work.bottom - MARGIN - height - top);

      x = Math.round(left + fx * spanX);
      y = Math.round(top + fy * spanY);
    }

    if (work) {
      x = Math.min(Math.max(work.left, x), Math.max(work.left, work.right - WIDTH));
      y = Math.min(Math.max(work.top, y), Math.max(work.top, work.bottom - height));
    }

    SetWindowPos(hwnd, HWND_TOPMOST, x, y, WIDTH, height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }

  /* --- the pump -------------------------------------------------- */

  const msg = koffi.alloc(MSG, 1);

  function pump(): void {
    if (destroyed) return;
    // Bounded so a flood can never starve the event loop this shares.
    for (let i = 0; i < 32; i++) {
      if (!PeekMessageW(msg, null, 0, 0, PM_REMOVE)) break;
      TranslateMessage(msg);
      DispatchMessageW(msg);
    }
  }

  let timer: NodeJS.Timeout = setInterval(pump, 200);
  timer.unref();

  function setRate(ms: number): void {
    clearInterval(timer);
    timer = setInterval(pump, ms);
    timer.unref();
  }

  /** Emoji as text, or an image blitted into a square. */
  function drawAvatar(hdc: unknown, x: number, y: number): void {
    if (avatar.kind === 'emoji') {
      SelectObject(hdc, avatarFont);
      SetTextColor(hdc, COLOR.text);
      DrawTextW(hdc, wide(avatar.value), -1, rectAt(x, y, x + AVATAR_SIZE, y + AVATAR_SIZE), DT_CENTER | DT_SINGLELINE | DT_VCENTER);
      return;
    }

    if (avatar.kind !== 'image') return;
    const image = loadImage(avatar.value);
    if (!image) return;

    const memory = CreateCompatibleDC(hdc);
    const previous = SelectObject(memory, image.bitmap);
    // HALFTONE, so a large photo scaled into 44px does not come out jagged.
    SetStretchBltMode(hdc, HALFTONE);
    StretchBlt(hdc, x, y, AVATAR_SIZE, AVATAR_SIZE, memory, 0, 0, image.width, image.height, SRCCOPY);
    SelectObject(memory, previous);
    DeleteDC(memory);
  }

  return {
    get visible() {
      return shown;
    },

    configure(next): void {
      if (next.placement) placement = next.placement;
      if (next.avatar) avatar = next.avatar;
    },

    show(next: OverlayContent): void {
      if (destroyed) return;
      content = next;

      const height = heightFor(next);
      let top = PADDING + LINE_HEIGHT + 4 + (next.lines ?? []).reduce((t, l) => t + (l.text.length > 44 ? 2 : 1), 0) * LINE_HEIGHT;
      buttons = (next.choices ?? []).map((choice) => {
        const button = { id: choice.id, top, bottom: top + BUTTON_HEIGHT };
        top += BUTTON_HEIGHT + 6;
        return button;
      });

      place(height);
      if (!shown) {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        shown = true;
        setRate(16);
      }
      InvalidateRect(hwnd, null, 1);
      pump();
    },

    hide(): void {
      if (destroyed || !shown) return;
      ShowWindow(hwnd, SW_HIDE);
      shown = false;
      buttons = [];
      setRate(200);
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      DestroyWindow(hwnd);
      // Fonts and brushes are GDI handles, and leaking them across a long-lived
      // process is exactly the sort of thing that has no symptom until it does.
      for (const handle of [titleFont, bodyFont, avatarFont, background, borderBrush, buttonBrush]) DeleteObject(handle);
      for (const cached of imageCache.values()) if (cached) DeleteObject(cached.bitmap);
      imageCache.clear();
      koffi.unregister(wndProc);
    },
  };
}
