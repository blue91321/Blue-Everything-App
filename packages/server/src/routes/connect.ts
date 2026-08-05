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
 * Ask the Tailscale CLI for this machine's tailnet name.
 *
 * Best effort with a short timeout — Tailscale may not be installed, may not be
 * logged in, or may not be on PATH, and none of those should slow down or fail
 * the page that's just trying to render pairing instructions.
 */
async function tailscaleDnsName(): Promise<string | null> {
  try {
    const { stdout } = await run('tailscale', ['status', '--json'], { timeout: 1500, windowsHide: true });
    const status = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    const name = status.Self?.DNSName?.replace(/\.$/, '');
    return name || null;
  } catch {
    return null;
  }
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
    const dnsName = await tailscaleDnsName();

    if (dnsName) {
      // What `tailscale serve` publishes: real certificate, no port needed.
      addresses.push({
        url: `https://${dnsName}`,
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
      tailscale: dnsName ? { dnsName, serving: true } : null,
      hostname: hostname(),
      port: config.PORT,
    };
  });
}
