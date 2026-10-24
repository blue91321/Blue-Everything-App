<#
.SYNOPSIS
  One taskbar button for the shortcut and the window it opens.

.DESCRIPTION
  Dot-sourced by start.ps1 and create-shortcut.ps1.

  Windows groups taskbar buttons by AppUserModelID. The shortcut runs
  powershell.exe and the window it opens is Brave's (or Edge's), so they had
  two IDs and two buttons: a pinned one that opened the app, and the app
  beside it. Giving both the same ID makes them one.

  - The shortcuts (Desktop, Start Menu, and a copy pinned to the taskbar) get
    the ID as a property of the .lnk (Set-ShortcutAppId).
  - The app window gets it as a property of the window, set from outside once
    it has opened (Set-AppWindowId). Chromium sets its own when it makes the
    window, so this runs after, and the taskbar moves the window onto the
    pinned button when it changes.

  The window is found by its title: an --app window's title is the page's,
  "Blue Everything", with no " - Brave" after it the way an ordinary window's
  has, so a tab of the app open in a normal window is not taken for it. And
  only a window that was not there before the launch, because the full app
  and the desktop client (desktop.ps1) both open windows with that title and
  each has its own ID: one taskbar button each, not one for both.
#>

# The full app's. desktop.ps1 sets its own, 'BlueEverything.Desktop', after dot-sourcing this.
$script:BlueAppId = 'BlueEverything.App'

# Compiled once per PowerShell. If it cannot be (a locked-down machine), the
# app still opens; it just has two taskbar buttons, as it did before.
if (-not ('BlueAppId' -as [type])) {
  try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class BlueAppId {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PropertyKey { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit, Size = 24)]
  // 24 bytes on x64, not 16: the union holds a BLOB, a size and a pointer. At 16 every read came back empty.
  struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr value; }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink { }

  [DllImport("shell32.dll")]
  static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);

  // PKEY_AppUserModel_ID
  static PropertyKey AppIdKey = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
  static Guid PropertyStoreId = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");

  static void Set(IPropertyStore store, string id) {
    var value = new PropVariant { vt = 31 /* VT_LPWSTR */, value = Marshal.StringToCoTaskMemUni(id) };
    try {
      store.SetValue(ref AppIdKey, ref value);
      store.Commit();
    } finally {
      Marshal.FreeCoTaskMem(value.value);
    }
  }

  /** Every visible Chromium window titled exactly one of `titles` that has not got `id` yet, given it. How many. */
  /** The windows the last StampWindows gave the ID: the app's own, for logs\app-windows.txt. */
  public static IntPtr[] LastStamped = new IntPtr[0];

  /** Every Chromium window there is now, shown or not: what a launch is compared against. */
  public static IntPtr[] ChromiumWindows() {
    var all = new List<IntPtr>();
    EnumWindows((hwnd, _) => {
      var cls = new StringBuilder(64);
      GetClassName(hwnd, cls, cls.Capacity);
      if (cls.ToString() == "Chrome_WidgetWin_1") all.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return all.ToArray();
  }

  public static int StampWindows(string[] titles, string id) {
    return StampWindows(titles, id, new IntPtr[0]);
  }

  /** As below, leaving out the windows in `except`: those already open before a launch. */
  public static int StampWindows(string[] titles, string id, IntPtr[] except) {
    var wanted = new HashSet<string>(titles);
    var skip = new HashSet<IntPtr>(except);
    var found = new List<IntPtr>();
    EnumWindows((hwnd, _) => {
      if (!IsWindowVisible(hwnd) || skip.Contains(hwnd)) return true;
      var cls = new StringBuilder(64);
      GetClassName(hwnd, cls, cls.Capacity);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      var text = new StringBuilder(256);
      GetWindowText(hwnd, text, text.Capacity);
      if (wanted.Contains(text.ToString())) found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    var stamped = new List<IntPtr>();
    foreach (var hwnd in found) if (StampWindow(hwnd, id)) stamped.Add(hwnd);
    LastStamped = stamped.ToArray();
    return stamped.Count;
  }

  /** One window given `id`, unless it has it already. True if it was given it now. */
  public static bool StampWindow(IntPtr hwnd, string id) {
    IPropertyStore store;
    if (SHGetPropertyStoreForWindow(hwnd, ref PropertyStoreId, out store) != 0) return false;
    try {
      PropVariant now;
      store.GetValue(ref AppIdKey, out now);
      if (now.vt == 31 && Marshal.PtrToStringUni(now.value) == id) return false;
      Set(store, id);
      return true;
    } finally { Marshal.ReleaseComObject(store); }
  }

  /** A .lnk given `id`, saved in place. */
  public static void StampShortcut(string path, string id) {
    var link = new ShellLink();
    try {
      var file = (IPersistFile)link;
      file.Load(path, 2 /* STGM_READWRITE */);
      Set((IPropertyStore)link, id);
      file.Save(path, true);
    } finally {
      Marshal.ReleaseComObject(link);
    }
  }
}
'@
  } catch { }
}

<#
  The windows this launcher opened, by handle, one a line in logs\app-windows.txt,
  the last twenty: how the agent knows the app's window has been closed, for
  "when you close the app" (closing.ts on the server). A window opened any other
  way is a browser's to close.
#>
function Save-AppWindows([IntPtr[]]$handles) {
  try {
    $file = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs\app-windows.txt'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
    $had = @(if (Test-Path $file) { Get-Content $file })
    $all = @($had + ($handles | ForEach-Object { $_.ToInt64() })) | Select-Object -Last 20
    Set-Content -Path $file -Value $all -Encoding ascii
  } catch { }
}

<#
  Give the app's window the shared ID, waiting for it to open: for a window
  that has not got it, so an app window already open and already given it does
  not end the wait before the new one appears. Quietly gives up
  after -Seconds: a window that never came is start.ps1's problem to report,
  not this one's.
#>
function Set-AppWindowId {
  param([int]$Seconds = 15, [IntPtr[]]$Except = @())
  # The wordmark's easter egg renames the page now and then; both are the app.
  $titles = @('Blue Everything', 'Blue Dabadee')
  if (-not ('BlueAppId' -as [type])) { return $false }
  $until = (Get-Date).AddSeconds($Seconds)
  do {
    try {
      if ([BlueAppId]::StampWindows($titles, $script:BlueAppId, $Except) -gt 0) {
        Save-AppWindows ([BlueAppId]::LastStamped)
        return $true
      }
    } catch { return $false }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $until)
  return $false
}

function Set-ShortcutAppId {
  param([Parameter(Mandatory)][string]$Path)
  if ('BlueAppId' -as [type]) { [BlueAppId]::StampShortcut($Path, $script:BlueAppId) }
}

<#
  Open the app in its own window: Chromium's --app mode, with no tabs and no
  address bar, given the shared ID so it is one taskbar button with the
  shortcut. The first Chromium-based browser found; a plain tab if there is
  none. Used by start.ps1 and by the desktop client, whose app is elsewhere.
#>
function Open-AppWindowAt {
  param([Parameter(Mandatory)][string]$Url)
  $candidates = @(
    "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
    "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )
  $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

  if ($browser) {
    # The windows already open, so only the one this opens is given the ID.
    $before = @()
    try { if ('BlueAppId' -as [type]) { $before = [BlueAppId]::ChromiumWindows() } } catch { }
    # Chromium remembers this window's size and position per --app URL after
    # the first launch, so the initial size is only ever used once.
    Start-Process $browser -ArgumentList "--app=$Url", '--window-size=1150,860'
    # Never a reason for the start to fail.
    try { [void](Set-AppWindowId -Except $before) } catch { }
  } else {
    # No Chromium-based browser found: a normal tab beats nothing.
    Start-Process $Url
  }
}
