/**
 * The icon in the notification area, and the menu behind it.
 *
 * ### Why this exists, given the agent's header says "no tray"
 *
 * It said no tray because a tray had only ever been costed as Electron, which
 * wanted 150-250MB to draw one. That is the thing that was rejected, not the
 * icon. `Shell_NotifyIconW` is four calls and a 32-byte struct; measured on this
 * machine it moves the agent's resident set by well under a megabyte, which is
 * inside the noise of a single attention poll. The same reasoning that let
 * `overlay.ts` draw a window without Electron applies here with more force,
 * because this draws nothing at all — Windows owns the pixels.
 *
 * What it buys is the thing the app was actually missing: somewhere to *find*
 * it. Two hidden `node.exe` processes with `-WindowStyle Hidden` are invisible
 * to anyone who does not already know they are there, and the only way to stop
 * or restart them was a `.cmd` file in a folder you had to remember the path to.
 *
 * ### It stops and restarts the whole app, not just the agent
 *
 * Both menu items shell out to `scripts\stop.ps1` and `scripts\restart.ps1`,
 * which are the same scripts the desktop shortcuts use. That matters twice
 * over: there is one definition of how this app starts and stops, and this file
 * does not have to know how to launch a server — it does not import one, and
 * the server stays a thing that could move to a VPS tomorrow.
 *
 * **The child must outlive its parent.** `stop.ps1` kills every `node.exe`
 * whose command line names this project, and that includes the process reading
 * this comment. So the script is spawned detached, as `powershell.exe`, which
 * the filter does not match — it carries on and finishes the job after the
 * agent it was launched from is gone. A `child_process` left attached would be
 * killed halfway through and leave the server running with nothing to stop it.
 *
 * ### The message pump
 *
 * Same polled `PeekMessageW` as `overlay.ts`, and for the same reason: Windows
 * wants a thread parked in `GetMessage` and Node already owns this one.
 *
 * The two pumps are safe together, and it is worth knowing why rather than
 * finding out. `PeekMessageW(msg, null, …)` drains the whole *thread* queue, so
 * whichever of them runs first will pick up the other's messages —
 * `DispatchMessageW` then routes each one to the window it belongs to, calling
 * the right window procedure synchronously on this thread. Nothing is lost and
 * nothing is invoked from a thread V8 has not heard of. This one polls slowly
 * (250ms) because a tray click can afford a quarter of a second, and because
 * paying 16ms forever for a menu nobody has opened would be the sort of
 * background cost this project measures before adding.
 */
import koffi from 'koffi';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const user32 = koffi.load('user32.dll');
const shell32 = koffi.load('shell32.dll');
const kernel32 = koffi.load('kernel32.dll');

/* ------------------------------------------------------------------ */
/* Structs                                                             */
/* ------------------------------------------------------------------ */

/* Prefixed, because koffi's type registry is process-wide: `win32.ts` owns the
 * bare names and `overlay.ts` owns the `Overlay*` ones. A collision throws at
 * import time and takes the agent down before it has started. */
const POINT = koffi.struct('TrayPOINT', { x: 'int32_t', y: 'int32_t' });

const MSG = koffi.struct('TrayMSG', {
  hwnd: 'void *',
  message: 'uint32_t',
  wParam: 'uintptr_t',
  lParam: 'intptr_t',
  time: 'uint32_t',
  pt: POINT,
});

const WNDCLASSEXW = koffi.struct('TrayWNDCLASSEXW', {
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

/**
 * `NOTIFYICONDATAW`, at the size Windows 2000 and later expect.
 *
 * The struct has grown three times, and `cbSize` is how the shell decides which
 * version it was handed. Declaring the modern layout and setting `cbSize` to
 * `sizeof` it is the only combination that is self-consistent — a mismatch is
 * not a crash but a silent `FALSE` from `Shell_NotifyIconW`, which presents as
 * the icon simply never appearing.
 *
 * `szTip` is 128 wide characters here (the post-2000 size). The balloon fields
 * are declared even though nothing sets them, because they sit *before*
 * `guidItem` and leaving them out would misplace everything after them.
 */
const NOTIFYICONDATAW = koffi.struct('TrayNOTIFYICONDATAW', {
  cbSize: 'uint32_t',
  hWnd: 'void *',
  uID: 'uint32_t',
  uFlags: 'uint32_t',
  uCallbackMessage: 'uint32_t',
  hIcon: 'void *',
  szTip: koffi.array('uint16_t', 128),
  dwState: 'uint32_t',
  dwStateMask: 'uint32_t',
  szInfo: koffi.array('uint16_t', 256),
  uVersion: 'uint32_t',
  szInfoTitle: koffi.array('uint16_t', 64),
  dwInfoFlags: 'uint32_t',
  guidItem: koffi.array('uint8_t', 16),
  hBalloonIcon: 'void *',
});

/* ------------------------------------------------------------------ */
/* Functions                                                           */
/* ------------------------------------------------------------------ */

const WndProcProto = koffi.proto(
  'intptr_t __stdcall TrayWndProc(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)'
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
const PeekMessageW = user32.func(
  'int __stdcall PeekMessageW(_Out_ void *msg, void *hwnd, uint32_t min, uint32_t max, uint32_t remove)'
);
const TranslateMessage = user32.func('int __stdcall TranslateMessage(const void *msg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const void *msg)');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ void *point)');

const LoadImageW = user32.func(
  'void * __stdcall LoadImageW(void *instance, const char16_t *name, uint32_t type, int cx, int cy, uint32_t load)'
);
const LoadIconW = user32.func('void * __stdcall LoadIconW(void *instance, uintptr_t name)');
const DestroyIcon = user32.func('int __stdcall DestroyIcon(void *icon)');

const CreatePopupMenu = user32.func('void * __stdcall CreatePopupMenu()');
const DestroyMenu = user32.func('int __stdcall DestroyMenu(void *menu)');
const AppendMenuW = user32.func(
  'int __stdcall AppendMenuW(void *menu, uint32_t flags, uintptr_t item, const char16_t *text)'
);
const TrackPopupMenu = user32.func(
  'int __stdcall TrackPopupMenu(void *menu, uint32_t flags, int x, int y, int reserved, void *hwnd, const void *rect)'
);
const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(void *hwnd)');
const PostMessageW = user32.func(
  'int __stdcall PostMessageW(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)'
);
const RegisterWindowMessageW = user32.func('uint32_t __stdcall RegisterWindowMessageW(const char16_t *name)');

const Shell_NotifyIconW = shell32.func('int __stdcall Shell_NotifyIconW(uint32_t message, void *data)');

/* Constants, named so the calls below read as Win32. */
const NIM_ADD = 0x00000000;
const NIM_MODIFY = 0x00000001;
const NIM_DELETE = 0x00000002;
const NIF_MESSAGE = 0x00000001;
const NIF_ICON = 0x00000002;
const NIF_TIP = 0x00000004;

/**
 * The callback message, in the WM_APP range.
 *
 * Below WM_APP is reserved by Windows and WM_USER is reserved by the window
 * class; a tray callback belongs in neither. Anything in this range is ours to
 * define because we also wrote the window procedure that receives it.
 */
const WM_TRAY = 0x0400 + 0x0400; // WM_APP + 1024

const WM_DESTROY = 0x0002;
const WM_COMMAND = 0x0111;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONUP = 0x0205;
const WM_CONTEXTMENU = 0x007b;
const WM_NULL = 0x0000;
const PM_REMOVE = 0x0001;

const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x00000010;
const LR_DEFAULTSIZE = 0x00000040;
/** `IDI_APPLICATION`, as a resource ordinal rather than a string. */
const IDI_APPLICATION = 32512;

const MF_STRING = 0x00000000;
const MF_SEPARATOR = 0x00000800;
const TPM_RIGHTBUTTON = 0x0002;
/** Return the chosen id rather than posting WM_COMMAND — see `showMenu`. */
const TPM_RETURNCMD = 0x0100;
const TPM_NONOTIFY = 0x0080;

/** Menu ids. Only meaningful inside this file. */
const MENU_OPEN = 1;
const MENU_RESTART = 2;
const MENU_STOP = 3;

/** How often the queue is drained. A tray click can afford a quarter second. */
const PUMP_MS = 250;

/** koffi takes a JS string for `const char16_t *`; this names the intent. */
const wide = (value: string): string => value;

/** A fixed-length UTF-16 field, zero-padded and always terminated. */
function utf16Field(value: string, length: number): number[] {
  const codes = [...value].map((c) => c.codePointAt(0) ?? 0).slice(0, length - 1);
  return [...codes, ...new Array(length - codes.length).fill(0)];
}

export class TrayUnavailable extends Error {}

export interface Tray {
  destroy(): void;
}

/** `packages/agent/src` -> the repo root. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Run one of the app's own PowerShell scripts and let go of it completely.
 *
 * ### Why this goes through `cmd /c start` rather than spawning PowerShell
 *
 * Two requirements that pull in opposite directions, and only this satisfies
 * both. Measured, after the obvious version silently did nothing at all:
 *
 * | launched as | runs? | survives the parent being killed? |
 * | --- | --- | --- |
 * | `spawn('powershell.exe', …)` | yes | **no** |
 * | …plus `detached: true` | **no** | — |
 * | `cmd /c start /b "" powershell.exe …` | yes | yes |
 *
 * The child *has* to outlive its parent: `stop.ps1` kills every `node.exe`
 * whose command line names this project, which includes the agent whose menu
 * was just clicked. But `detached: true` on Windows means `DETACHED_PROCESS` —
 * no console at all — and `powershell.exe` needs a console host, so it exits
 * immediately without running a line of the script.
 *
 * `start` asks the command processor to create the process; cmd then exits, so
 * what ends up running belongs to no one in this tree and gets a console of its
 * own. `/b` keeps it from flashing a window. It is the oldest trick on Windows
 * and it is the one that works.
 *
 * ### And it must be possible to see it fail
 *
 * The first version used `stdio: 'ignore'` and no logging, which is how the
 * whole thing shipped broken: PowerShell was exiting instantly without running
 * a line, and a menu item that does nothing looks exactly like a menu item that
 * was never clicked. Nothing anywhere said otherwise.
 *
 * So output goes to `logs\tray.log`. The redirection is **PowerShell's own**
 * (`*>>` via `-Command`), not a `>>` on the cmd line: `start /b` hands the new
 * process cmd's handles, and cmd's were `ignore`, so a shell redirect there
 * creates the file and captures nothing — which is a worse kind of empty than
 * no file at all. The log comes out UTF-16, because that is what PowerShell
 * writes; it reads fine and is not worth another layer to change.
 *
 * `-ExecutionPolicy Bypass` because the scripts are unsigned and sitting in a
 * cloned folder; the default policy would refuse them.
 */
function runScript(name: string, args: string[] = []): ChildProcess {
  const script = resolve(repoRoot, 'scripts', name);
  const log = resolve(repoRoot, 'logs', 'tray.log');
  // `start.ps1` makes this, but the tray can run before it ever has — and a
  // redirect into a folder that isn't there fails the whole command.
  mkdirSync(dirname(log), { recursive: true });

  // Single-quoted for PowerShell, which does no expansion inside them, with
  // embedded quotes doubled. These paths contain spaces and, on this machine,
  // a OneDrive folder — neither is hypothetical.
  const quoted = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const command = `& ${quoted(script)} ${args.join(' ')} *>> ${quoted(log)}`;

  const child = spawn(
    'cmd.exe',
    [
      '/c',
      'start',
      '/b',
      // `start` reads a lone quoted argument as the window title. The empty one
      // is what stops it taking the program name for a title instead.
      '""',
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );

  child.unref();
  return child;
}

/**
 * Put an icon in the notification area.
 *
 * Throws `TrayUnavailable` rather than returning null, so the caller decides
 * whether a missing tray is worth caring about. It isn't — see `index.ts`.
 */
export function createTray(options: { tooltip: string; onOpen: () => void }): Tray {
  const instance = GetModuleHandleW(null);
  const className = 'EverythingAgentTray';

  let destroyed = false;

  /**
   * Explorer restarting takes every tray icon with it, and it is the shell's
   * job to tell us so. Without handling this, an Explorer crash — or a Windows
   * update that restarts it — leaves the agent running with no way to reach it
   * until the next reboot, which looks exactly like the tray having broken.
   */
  const WM_TASKBARCREATED = RegisterWindowMessageW(wide('TaskbarCreated'));

  const onMessage = (hwnd: unknown, msg: number, wparam: number, lparam: number): number => {
    if (msg === WM_TRAY) {
      // The low word of lParam is the mouse message. A tray icon reports both
      // buttons through one callback, so this is where they part company.
      const event = lparam & 0xffff;
      if (event === WM_LBUTTONUP) {
        options.onOpen();
        return 0;
      }
      if (event === WM_RBUTTONUP || event === WM_CONTEXTMENU) {
        showMenu(hwnd);
        return 0;
      }
      return 0;
    }

    if (msg === WM_TASKBARCREATED) {
      // Add, not modify: as far as the new shell is concerned this icon has
      // never existed, and NIM_MODIFY on an icon it does not know about fails.
      add(NIM_ADD);
      return 0;
    }

    if (msg === WM_DESTROY) return 0;
    if (msg === WM_COMMAND) return 0;

    return Number(DefWindowProcW(hwnd, msg, wparam, lparam));
  };

  // Held in a variable so it cannot be collected while Windows still holds the
  // pointer. A callback outliving its JS reference is a hard crash.
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
  RegisterClassExW(wc);

  /**
   * A window with no size, never shown.
   *
   * It exists only to have a window procedure for the shell to call back into —
   * a tray icon has no window of its own and must borrow one. Deliberately not
   * `HWND_MESSAGE`: a message-only window cannot receive broadcast messages, and
   * `TaskbarCreated` is broadcast, so the Explorer-restart recovery above would
   * silently never fire.
   */
  const hwnd = CreateWindowExW(0, wide(className), wide('Blue Everything'), 0, 0, 0, 0, 0, null, null, instance, null);

  if (!hwnd) {
    koffi.unregister(wndProc);
    throw new TrayUnavailable('could not create the tray window');
  }

  /**
   * The app's own mark, or the stock application icon.
   *
   * `assets\everything.ico` is generated by `npm run icons -w @everything/web`
   * and is not in git, so it can genuinely be absent — on a fresh clone that has
   * not built yet, for instance. Falling back is much better than no tray:
   * being able to *find* the app is the point, and it having the wrong picture
   * is a detail.
   */
  const iconPath = resolve(repoRoot, 'assets', 'everything.ico');
  let icon: unknown = null;
  let ownsIcon = false;

  if (existsSync(iconPath)) {
    icon = LoadImageW(null, wide(iconPath), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
    ownsIcon = Boolean(icon);
  }
  // A shared system icon, which must not be destroyed — hence `ownsIcon`.
  if (!icon) icon = LoadIconW(null, IDI_APPLICATION);

  function add(message: number): boolean {
    const data = koffi.alloc(NOTIFYICONDATAW, 1);
    koffi.encode(data, NOTIFYICONDATAW, {
      cbSize: koffi.sizeof(NOTIFYICONDATAW),
      hWnd: hwnd,
      uID: 1,
      uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
      uCallbackMessage: WM_TRAY,
      hIcon: icon,
      szTip: utf16Field(options.tooltip, 128),
      dwState: 0,
      dwStateMask: 0,
      szInfo: utf16Field('', 256),
      uVersion: 0,
      szInfoTitle: utf16Field('', 64),
      dwInfoFlags: 0,
      guidItem: new Array(16).fill(0),
      hBalloonIcon: null,
    });
    return Boolean(Shell_NotifyIconW(message, data));
  }

  if (!add(NIM_ADD)) {
    DestroyWindow(hwnd);
    if (ownsIcon) DestroyIcon(icon);
    koffi.unregister(wndProc);
    throw new TrayUnavailable('the shell refused the tray icon');
  }

  function remove(): void {
    const data = koffi.alloc(NOTIFYICONDATAW, 1);
    koffi.encode(data, NOTIFYICONDATAW, {
      cbSize: koffi.sizeof(NOTIFYICONDATAW),
      hWnd: hwnd,
      uID: 1,
      uFlags: 0,
      uCallbackMessage: 0,
      hIcon: null,
      szTip: utf16Field('', 128),
      dwState: 0,
      dwStateMask: 0,
      szInfo: utf16Field('', 256),
      uVersion: 0,
      szInfoTitle: utf16Field('', 64),
      dwInfoFlags: 0,
      guidItem: new Array(16).fill(0),
      hBalloonIcon: null,
    });
    Shell_NotifyIconW(NIM_DELETE, data);
  }

  const point = koffi.alloc(POINT, 1);

  function showMenu(target: unknown): void {
    const menu = CreatePopupMenu();
    if (!menu) return;

    AppendMenuW(menu, MF_STRING, MENU_OPEN, wide('Open Blue Everything'));
    AppendMenuW(menu, MF_SEPARATOR, 0, null as unknown as string);
    AppendMenuW(menu, MF_STRING, MENU_RESTART, wide('Restart'));
    AppendMenuW(menu, MF_STRING, MENU_STOP, wide('Stop'));

    GetCursorPos(point);
    const cursor = koffi.decode(point, POINT) as { x: number; y: number };

    /*
     * The two calls around the menu are not ceremony — they are the documented
     * fix for a tray menu that will not go away.
     *
     * `SetForegroundWindow` first, or clicking elsewhere never dismisses the
     * menu, because the owning window was never active and so never loses
     * activation. The `WM_NULL` afterwards is the other half of the same defect:
     * without a message arriving after the menu closes, the shell can leave the
     * menu painted on screen over everything else.
     */
    SetForegroundWindow(target);

    // TPM_RETURNCMD hands the choice back here instead of posting WM_COMMAND,
    // which keeps the whole interaction in one place — and matters more than
    // usual given the pump only runs four times a second.
    const choice = Number(
      TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY, cursor.x, cursor.y, 0, target, null)
    );

    PostMessageW(target, WM_NULL, 0, 0);
    DestroyMenu(menu);

    if (choice === MENU_OPEN) options.onOpen();
    if (choice === MENU_RESTART) leave('restart.ps1');
    if (choice === MENU_STOP) leave('stop.ps1');
  }

  /**
   * Run something that ends with this process gone.
   *
   * The icon comes down first, because the shell does not notice an owner dying
   * until something hovers the icon — so leaving it would strand a dead one on
   * the taskbar, which is precisely what "Restart made the icon disappear
   * forever" looked like.
   *
   * But it is put *back* if the launch fails. That was the other half of the
   * same bug: the icon was removed on the strength of a script that never ran,
   * leaving an app with no way to reach it and no clue why. An icon that stays
   * put is a much better failure than one that vanishes.
   */
  function leave(script: string): void {
    remove();
    const child = runScript(script);

    child.on('error', (error) => {
      console.error(`[tray] could not run ${script}: ${error.message}`);
      add(NIM_ADD);
    });

    // `cmd` exits the moment `start` has handed the process off, so a non-zero
    // code here means the launch itself failed rather than the script.
    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[tray] ${script} could not be launched (cmd exited ${code})`);
        add(NIM_ADD);
      }
    });
  }

  const msg = koffi.alloc(MSG, 1);

  function pump(): void {
    if (destroyed) return;
    // Bounded, so a flood can never starve the event loop this shares.
    for (let i = 0; i < 32; i++) {
      if (!PeekMessageW(msg, null, 0, 0, PM_REMOVE)) break;
      TranslateMessage(msg);
      DispatchMessageW(msg);
    }
  }

  const timer = setInterval(pump, PUMP_MS);
  timer.unref();

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      remove();
      DestroyWindow(hwnd);
      // Only the one we loaded. `IDI_APPLICATION` is shared and destroying it
      // is undefined behaviour rather than a leak avoided.
      if (ownsIcon) DestroyIcon(icon);
      koffi.unregister(wndProc);
    },
  };
}

export { runScript as runAppScript };
