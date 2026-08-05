/**
 * Thin FFI layer over the Win32 APIs the attention sensor needs.
 *
 * Everything here is read-only introspection: what window is in front, is it
 * covering the whole monitor, how long since the user touched a key, and does
 * Windows itself think this is a bad moment to pop a toast.
 */
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const shell32 = koffi.load('shell32.dll');

// Win32 BOOL is a 4-byte int, not C's _Bool — declaring it as `int` avoids
// reading a garbage high byte as the result.
const GetForegroundWindow = user32.func('void* GetForegroundWindow()');
const GetWindowTextW = user32.func('int GetWindowTextW(void* hWnd, _Out_ uint16_t* lpString, int nMaxCount)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)');

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const MONITORINFO = koffi.struct('MONITORINFO', {
  cbSize: 'uint32',
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: 'uint32',
});
const GetWindowRect = user32.func('int GetWindowRect(void* hWnd, _Out_ RECT* lpRect)');
const MonitorFromWindow = user32.func('void* MonitorFromWindow(void* hwnd, uint32 dwFlags)');
const GetMonitorInfoW = user32.func('int GetMonitorInfoW(void* hMonitor, _Inout_ MONITORINFO* lpmi)');

const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' });
const GetLastInputInfo = user32.func('int GetLastInputInfo(_Inout_ LASTINPUTINFO* plii)');
const GetTickCount = kernel32.func('uint32 GetTickCount()');

const OpenProcess = kernel32.func('void* OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)');
const CloseHandle = kernel32.func('int CloseHandle(void* hObject)');
const QueryFullProcessImageNameW = kernel32.func(
  'int QueryFullProcessImageNameW(void* hProcess, uint32 dwFlags, _Out_ uint16_t* lpExeName, _Inout_ uint32* lpdwSize)'
);

/** Windows' own answer to "is now a good time to interrupt?" */
const SHQueryUserNotificationState = shell32.func('int SHQueryUserNotificationState(_Out_ int* pquns)');

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MONITOR_DEFAULTTONEAREST = 0x2;

/** Values of QUERY_USER_NOTIFICATION_STATE. */
export const NotificationState = {
  NOT_PRESENT: 1,
  BUSY: 2,
  RUNNING_D3D_FULL_SCREEN: 3,
  PRESENTATION_MODE: 4,
  ACCEPTS_NOTIFICATIONS: 5,
  QUIET_TIME: 6,
  APP_FULL_SCREEN: 7,
} as const;

export type NotificationStateValue = (typeof NotificationState)[keyof typeof NotificationState];

export const notificationStateName = (v: number): string =>
  Object.entries(NotificationState).find(([, n]) => n === v)?.[0] ?? `UNKNOWN(${v})`;

function decodeWide(buf: Uint16Array, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    const c = buf[i];
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

export interface ForegroundWindowInfo {
  pid: number;
  title: string;
  /** Full path to the owning executable, e.g. C:\Riot Games\...\League of Legends.exe */
  exePath: string;
  /** Just the filename, lowercased: `league of legends.exe` */
  exe: string;
  /** True when the window covers its entire monitor (borderless or exclusive fullscreen). */
  isFullScreen: boolean;
}

/** Resolve a PID to its executable path. Returns '' if the process is gone or protected. */
export function exePathForPid(pid: number): string {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return '';
  try {
    const buf = new Uint16Array(1024);
    const size = [buf.length];
    if (!QueryFullProcessImageNameW(handle, 0, buf, size)) return '';
    return decodeWide(buf, size[0]);
  } finally {
    CloseHandle(handle);
  }
}

export function getForegroundWindow(): ForegroundWindowInfo | null {
  const hwnd = GetForegroundWindow();
  if (!hwnd) return null;

  const titleBuf = new Uint16Array(512);
  const titleLen = GetWindowTextW(hwnd, titleBuf, titleBuf.length);
  const title = decodeWide(titleBuf, titleLen);

  const pidOut = [0];
  GetWindowThreadProcessId(hwnd, pidOut);
  const pid = pidOut[0];

  const exePath = exePathForPid(pid);
  const exe = exePath.split('\\').pop()?.toLowerCase() ?? '';

  return { pid, title, exePath, exe, isFullScreen: isWindowFullScreen(hwnd) };
}

function isWindowFullScreen(hwnd: unknown): boolean {
  const rect = {} as { left: number; top: number; right: number; bottom: number };
  if (!GetWindowRect(hwnd, rect)) return false;

  const monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!monitor) return false;

  const mi = {
    cbSize: 40,
    rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
    rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
    dwFlags: 0,
  };
  if (!GetMonitorInfoW(monitor, mi)) return false;

  const m = mi.rcMonitor;
  return rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom;
}

const TH32CS_SNAPPROCESS = 0x2;
const INVALID_HANDLE = -1;

const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('uint16_t', 260),
});
const CreateToolhelp32Snapshot = kernel32.func('void* CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)');
const Process32FirstW = kernel32.func('int Process32FirstW(void* hSnapshot, _Inout_ PROCESSENTRY32W* lppe)');
const Process32NextW = kernel32.func('int Process32NextW(void* hSnapshot, _Inout_ PROCESSENTRY32W* lppe)');

const PE32_SIZE = koffi.sizeof(PROCESSENTRY32W);

/**
 * Every running process, lowercased name to PID.
 *
 * Measured at ~5ms on a 143-process machine — 50x the cost of every other call
 * here combined, and the reason the monitor throttles how often it runs this
 * rather than doing it on every tick. Returns PIDs so that once a game is
 * found, `processIsAlive` can watch it for a fraction of the cost.
 *
 * Process *liveness* is the signal that matters: a League match is in progress
 * whenever `League of Legends.exe` exists, even if Blake alt-tabbed to Discord.
 */
export function listProcesses(): Map<string, number> {
  const found = new Map<string, number>();
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snap || koffi.address(snap) === INVALID_HANDLE) return found;

  try {
    const entry: Record<string, unknown> = { dwSize: PE32_SIZE, szExeFile: new Array(260).fill(0) };
    let ok = Process32FirstW(snap, entry);
    while (ok) {
      const name = decodeWide(Uint16Array.from(entry.szExeFile as number[]), 260);
      // First PID wins; for multi-process games any live instance answers the
      // only question being asked, which is "is this still running".
      if (name && !found.has(name.toLowerCase())) {
        found.set(name.toLowerCase(), entry.th32ProcessID as number);
      }
      entry.dwSize = PE32_SIZE;
      ok = Process32NextW(snap, entry);
    }
  } finally {
    CloseHandle(snap);
  }
  return found;
}

/** Convenience wrapper for callers that only care about which names exist. */
export const listProcessNames = (): Set<string> => new Set(listProcesses().keys());

/**
 * Is this PID still running?
 *
 * Two syscalls, versus a full toolhelp snapshot that walks every process on the
 * machine. Once a game's PID is known, this is how the agent notices the match
 * ending without paying for a rescan on every tick.
 */
export function processIsAlive(pid: number): boolean {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return false;
  CloseHandle(handle);
  return true;
}

/** Milliseconds since the last keyboard or mouse input, system-wide. */
export function getIdleMs(): number {
  const lii = { cbSize: 8, dwTime: 0 };
  if (!GetLastInputInfo(lii)) return 0;
  // GetTickCount wraps every ~49.7 days; mask keeps the delta sane across the wrap.
  return (GetTickCount() - lii.dwTime) >>> 0;
}

export function getNotificationState(): number {
  const out = [0];
  const hr = SHQueryUserNotificationState(out);
  if (hr !== 0) return NotificationState.ACCEPTS_NOTIFICATIONS;
  return out[0];
}
