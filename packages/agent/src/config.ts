/**
 * Where the server is and how to prove we're allowed to talk to it.
 *
 * Env wins over the config file, so moving the server later — to a VPS, or to
 * another box on the tailnet — never requires editing a file that's easy to
 * forget about.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(packageRoot, 'agent.config.json');

interface FileConfig {
  serverUrl?: string;
  token?: string;
  /** Extra executables to treat as "do not interrupt", e.g. ["starfield.exe"]. */
  extraGames?: string[];
}

function readFileConfig(): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    // Genuinely absent is fine — env may supply everything.
    return {};
  }

  try {
    // Windows PowerShell's `Out-File -Encoding utf8` prepends a BOM, which
    // JSON.parse rejects. Anything that writes this file by hand on Windows is
    // likely to leave one, so strip it rather than blaming the user.
    return JSON.parse(raw.replace(/^﻿/, '')) as FileConfig;
  } catch (error) {
    // A malformed config is a different problem from a missing one, and
    // swallowing it here produces a "no token configured" message that sends
    // You looking in entirely the wrong place.
    console.error(`${configPath} exists but could not be parsed: ${(error as Error).message}`);
    process.exit(1);
  }
}

const fromFile = readFileConfig();

const envGames = (process.env.EVERYTHING_EXTRA_GAMES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const agentConfig = {
  serverUrl: (process.env.EVERYTHING_SERVER_URL ?? fromFile.serverUrl ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
  token: process.env.EVERYTHING_TOKEN ?? fromFile.token ?? '',
  extraGames: [...(fromFile.extraGames ?? []), ...envGames],
  configPath,
};

/** Loopback servers trust this machine without a token, so none is needed. */
export function serverIsLocal(url = agentConfig.serverUrl): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

export function assertConfigured(): void {
  if (agentConfig.token || serverIsLocal()) return;

  console.error(
    [
      `No token configured, and ${agentConfig.serverUrl} is not this machine.`,
      '',
      'Add this device from the app running on the server PC (Settings -> Add a device),',
      `then save the token to ${configPath}:`,
      '  { "serverUrl": "https://...", "token": "<token>" }',
      '',
      'or set EVERYTHING_SERVER_URL and EVERYTHING_TOKEN.',
    ].join('\n')
  );
  process.exit(1);
}
