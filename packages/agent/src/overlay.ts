/**
 * A small window at the cursor, for talking back.
 *
 * ### Why this is hand-rolled Win32 and not a UI framework
 *
 * The project rejected Electron at 150-250MB to draw a tray icon; it is not
 * going to accept it now to draw four lines of text. A borderless browser
 * window was the other candidate and fails the case that matters most — it
 * takes most of a second to appear and will not float above an exclusive
 * fullscreen game, which is exactly when Blake is talking rather than typing.
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

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

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

export interface Overlay {
  show(content: OverlayContent): void;
  hide(): void;
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
  const className = 'EverythingVoiceOverlay';

  let content: OverlayContent = { title: '' };
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
    wide('Everything'),
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

    let y = PADDING;

    SelectObject(hdc, titleFont);
    SetTextColor(hdc, COLOR.accent);
    DrawTextW(
      hdc,
      wide(content.title),
      -1,
      rectAt(PADDING, y, client.right - PADDING, y + LINE_HEIGHT),
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
        rectAt(PADDING, y, client.right - PADDING, y + LINE_HEIGHT * 2),
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
    return PADDING * 2 + LINE_HEIGHT + 4 + lines * LINE_HEIGHT + choices * (BUTTON_HEIGHT + 6);
  }

  /** Beside the cursor, nudged back on screen if that would fall off an edge. */
  function place(height: number): void {
    const point = koffi.alloc(POINT, 1);
    GetCursorPos(point);
    const cursor = koffi.decode(point, POINT) as { x: number; y: number };

    let x = cursor.x + 16;
    let y = cursor.y + 18;

    const packed = BigInt(cursor.x & 0xffffffff) | (BigInt(cursor.y & 0xffffffff) << 32n);
    const monitor = MonitorFromPoint(packed, MONITOR_DEFAULTTONEAREST);
    if (monitor) {
      const info = koffi.alloc(MONITORINFO, 1);
      koffi.encode(info, MONITORINFO, {
        cbSize: koffi.sizeof(MONITORINFO),
        rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
        rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
        dwFlags: 0,
      });
      if (GetMonitorInfoW(monitor, info)) {
        const work = (koffi.decode(info, MONITORINFO) as { rcWork: { left: number; top: number; right: number; bottom: number } }).rcWork;
        if (x + WIDTH > work.right) x = cursor.x - WIDTH - 16;
        if (y + height > work.bottom) y = cursor.y - height - 18;
        x = Math.max(work.left, x);
        y = Math.max(work.top, y);
      }
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

  return {
    get visible() {
      return shown;
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
      for (const handle of [titleFont, bodyFont, background, borderBrush, buttonBrush]) DeleteObject(handle);
      koffi.unregister(wndProc);
    },
  };
}
