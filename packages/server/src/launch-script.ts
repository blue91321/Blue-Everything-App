/**
 * Run one of this checkout's PowerShell scripts so that it outlives the server
 * (2026-11-18). Restart, Update, the switch between Everything and Just Manga,
 * and Start the agent all do this; they were four copies of the recipe.
 *
 * **Why `cmd /c start /b`**: see `routes/restart.ts`. `spawn('powershell.exe')`
 * dies with its parent, and `detached: true` leaves PowerShell with no console
 * so it exits without running a line. Only this form both runs and outlives us.
 *
 * **Nothing from a path is in the command text.** The script, its parameters
 * and the log go to PowerShell as environment variables, and the command is
 * the same fixed string every time. Before, each path was spliced into the
 * command with its quotes doubled, which PowerShell reads correctly but cmd.exe
 * reads first: it expands `%name%` even inside quotes, so a checkout in a
 * folder with `%` in its name could have run part of the path. GitHub's code
 * scanning flagged the splice; this removes it rather than escaping it.
 * Verified with a script in a folder named `launch test %x%` with an
 * apostrophe in the file name.
 *
 * Parameters are named (`{ Configuration: 'just-manga' }`, `{ AgentOnly: true }`)
 * and splatted as a hashtable: an array splat passes `-Configuration` as a
 * plain string rather than binding it, which was measured too.
 *
 * Output goes to `logs/<log>` through PowerShell's own `*>>`; see the tray's
 * notes in CLAUDE.md for why not a redirect on the cmd line.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './paths.js';

const COMMAND =
  '$p = @{}; (ConvertFrom-Json $env:EVERYTHING_LAUNCH_PARAMS).psobject.Properties | ForEach-Object { $p[$_.Name] = $_.Value }; ' +
  '& $env:EVERYTHING_LAUNCH_SCRIPT @p *>> $env:EVERYTHING_LAUNCH_LOG';

export function launchScript(
  script: string,
  params: Record<string, string | boolean>,
  log: string,
  onError: (error: Error) => void
): void {
  mkdirSync(resolve(repoRoot, 'logs'), { recursive: true });
  const child = spawn(
    'cmd.exe',
    ['/c', 'start', '/b', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', COMMAND],
    {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        EVERYTHING_LAUNCH_SCRIPT: script,
        EVERYTHING_LAUNCH_PARAMS: JSON.stringify(params),
        EVERYTHING_LAUNCH_LOG: resolve(repoRoot, 'logs', log),
      },
    }
  );
  child.on('error', onError);
  child.unref();
}
