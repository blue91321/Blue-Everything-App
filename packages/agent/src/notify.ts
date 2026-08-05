/**
 * Windows toasts, without a UI framework.
 *
 * Electron would give a one-line `new Notification()` and cost 150-250MB of
 * resident Chromium for the privilege. Spawning PowerShell costs ~0MB at rest
 * and a few hundred ms at fire time — and nudges are rare by design, so that
 * cost is paid a handful of times a day rather than continuously.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/toast.ps1');

export interface ToastOptions {
  title: string;
  body?: string;
  /** Lets a later toast replace this one instead of stacking. */
  tag?: string;
}

export function showToast({ title, body = '', tag }: ToastOptions): Promise<boolean> {
  return new Promise((resolveToast) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Title',
      title,
      '-Body',
      body,
    ];
    if (tag) args.push('-Tag', tag);

    // shell:false, so arguments are passed as an array and never parsed as a
    // command line.
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', () => resolveToast(false));
    child.on('close', (code) => {
      if (code !== 0 && stderr) console.error(`toast failed: ${stderr.trim().split('\n')[0]}`);
      resolveToast(code === 0);
    });
  });
}
