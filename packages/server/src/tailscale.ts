/**
 * Asking this PC's Tailscale things: its name, and what `tailscale serve` is
 * publishing.
 *
 * Moved out of `routes/connect.ts` when guest copies needed it too: each copy
 * gets its own `https://<machine>.ts.net:<port>` through `serve`, because a
 * phone needs `https` and only the host's port had it.
 *
 * Windows-specific in where it looks, as the table at the top of CLAUDE.md
 * says: in Docker this becomes a Tailscale sidecar, not a CLI on the PATH.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The Windows installer does not put `tailscale.exe` on PATH, so asking by
 * name alone reports "not installed" on a machine where it is running fine.
 */
const TAILSCALE_PATHS = [
  'tailscale',
  `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`,
  `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Tailscale\\tailscale.exe`,
];

/** Its output, or null when it is not installed, not signed in, or refused. */
export async function tailscale(args: string[], timeout = 2500): Promise<string | null> {
  for (const exe of TAILSCALE_PATHS) {
    try {
      const { stdout } = await run(exe, args, { timeout, windowsHide: true });
      return stdout;
    } catch {
      // Try the next location; not installed there, or not logged in.
    }
  }
  return null;
}

/** This machine's tailnet name, `desktop-x.tailnet.ts.net`, while Tailscale is up. */
export async function tailnetName(): Promise<string | null> {
  const statusJson = await tailscale(['status', '--json']);
  if (!statusJson) return null;
  try {
    const status = JSON.parse(statusJson) as { Self?: { DNSName?: string }; BackendState?: string };
    if (status.BackendState !== 'Running') return null;
    return status.Self?.DNSName?.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/** What `tailscale serve status` lists, as text. Empty when nothing answers. */
export async function serveStatus(): Promise<string> {
  return (await tailscale(['serve', 'status'])) ?? '';
}

/**
 * Publish `http://127.0.0.1:<port>` at `https://<machine>.ts.net:<port>`,
 * inside the tailnet only (`serve`, never `funnel`). `--bg` keeps it across
 * restarts of the PC, so this is asked once per copy, not per start.
 */
export async function serveOnPort(port: number): Promise<boolean> {
  return (await tailscale(['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`], 10_000)) !== null;
}

/** Stop publishing one port. Leaves every other port, and the host's, alone. */
export async function stopServingPort(port: number): Promise<boolean> {
  return (await tailscale(['serve', `--https=${port}`, 'off'], 10_000)) !== null;
}
