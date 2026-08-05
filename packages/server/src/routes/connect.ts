import { execFile } from 'node:child_process';
import { networkInterfaces, hostname } from 'node:os';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

const run = promisify(execFile);

/** Tailscale hands out addresses from 100.64.0.0/10. */
function isTailscaleAddress(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export interface ConnectAddress {
  url: string;
  kind: 'tailscale-https' | 'tailscale' | 'lan' | 'local';
  label: string;
  /** Service workers and web push need a secure context; iOS enforces it. */
  secure: boolean;
}

/**
 * The Windows installer does not put tailscale.exe on PATH, so looking it up by
 * name alone silently reports "Tailscale not installed" on a machine where it
 * is running perfectly well.
 */
const TAILSCALE_PATHS = [
  'tailscale',
  `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Tailscale\\tailscale.exe`,
  `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Tailscale\\tailscale.exe`,
];

async function tailscale(args: string[]): Promise<string | null> {
  for (const exe of TAILSCALE_PATHS) {
    try {
      const { stdout } = await run(exe, args, { timeout: 2500, windowsHide: true });
      return stdout;
    } catch {
      // Try the next location; not installed there, or not logged in.
    }
  }
  return null;
}

/**
 * This machine's tailnet name, and whether it is actually serving the app over
 * HTTPS. Best effort — none of this should fail the page that is only trying to
 * render pairing instructions.
 */
async function tailscaleInfo(): Promise<{ dnsName: string; serving: boolean } | null> {
  const statusJson = await tailscale(['status', '--json']);
  if (!statusJson) return null;

  let dnsName: string | null = null;
  try {
    const status = JSON.parse(statusJson) as { Self?: { DNSName?: string }; BackendState?: string };
    if (status.BackendState !== 'Running') return null;
    dnsName = status.Self?.DNSName?.replace(/\.$/, '') ?? null;
  } catch {
    return null;
  }
  if (!dnsName) return null;

  // `serve status` lists the proxies. Without one, the https name resolves but
  // nothing answers on it, which would be a confusing thing to recommend.
  const serveStatus = (await tailscale(['serve', 'status'])) ?? '';
  const serving = serveStatus.includes(`https://${dnsName}`) && serveStatus.includes(String(config.PORT));

  return { dnsName, serving };
}

export async function connectRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everything the app needs to tell you how to connect another device:
   * which addresses this server is reachable on, and whether each one will
   * actually work for an installed phone app.
   */
  app.get('/api/connect-info', async (request) => {
    if (!request.isLocal) {
      return { addresses: [], tailscale: null, hostname: hostname(), port: config.PORT };
    }

    const addresses: ConnectAddress[] = [];
    const info = await tailscaleInfo();

    // Only offered once `tailscale serve` is actually proxying — the name
    // resolves either way, so recommending it early would send Blake to a
    // page that never loads.
    if (info?.serving) {
      addresses.push({
        url: `https://${info.dnsName}`,
        kind: 'tailscale-https',
        label: 'Tailscale (secure) — use this one on your phone',
        secure: true,
      });
    }

    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family !== 'IPv4' || net.internal) continue;
        const url = `http://${net.address}:${config.PORT}`;
        if (isTailscaleAddress(net.address)) {
          addresses.push({ url, kind: 'tailscale', label: 'Tailscale (plain) — will not install on iPhone', secure: false });
        } else {
          addresses.push({ url, kind: 'lan', label: 'Home network only', secure: false });
        }
      }
    }

    addresses.push({ url: `http://127.0.0.1:${config.PORT}`, kind: 'local', label: 'This PC', secure: true });

    return {
      addresses,
      tailscale: info,
      hostname: hostname(),
      port: config.PORT,
    };
  });
}
