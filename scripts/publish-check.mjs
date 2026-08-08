/**
 * Is this repository safe to make public?
 *
 *   npm run publish-check
 *
 * Three questions, in the order they can bite:
 *
 *   1. Are the sensitive paths *actually* ignored? Asked of git itself, not by
 *      re-reading .gitignore — the failure that prompted this script was a rule
 *      that lived in a global config and therefore did not survive a clone.
 *   2. Is anything sensitive already tracked? .gitignore does nothing for a file
 *      git is already following.
 *   3. Does any tracked file *contain* a secret or a personal identifier?
 *
 * Exit code 1 means do not push. Warnings do not fail — they are things you
 * should decide about rather than things that are wrong.
 *
 * Node only, no dependencies, so it runs on a fresh clone before `npm install`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

const problems = [];
const warnings = [];

/* ------------------------------------------------------------------ */
/* 1. The paths that must never be committed                           */
/* ------------------------------------------------------------------ */

/**
 * Representative paths rather than glob patterns: `check-ignore` answers for a
 * path, which is the question that actually matters. They need not exist.
 */
const MUST_BE_IGNORED = [
  'packages/server/data/everything.db',
  'packages/server/data/everything.db-wal',
  'packages/server/data/everything.db.bak-1115',
  'packages/server/data/avatar.png',
  'packages/server/data/logo.png',
  'packages/agent/agent.config.json',
  'packages/server/.env',
  '.claude/settings.local.json',
  'features.json',
  'logs/agent.log',
  'packages/agent/src/features/voice/models/libvosk.dll',
  'packages/agent/src/features/voice/models/vosk-model-small-en-us-0.15/README',
  'secrets/anything',
  'private.pem',
];

for (const path of MUST_BE_IGNORED) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: repo });
  } catch {
    problems.push(`not ignored: ${path}`);
  }
}

/* ------------------------------------------------------------------ */
/* 2. Nothing sensitive already tracked                                */
/* ------------------------------------------------------------------ */

const tracked = git(['ls-files']).split('\n').filter(Boolean);

const FORBIDDEN_TRACKED = [
  [/(^|\/)data\//, 'the personal database lives here'],
  [/\.(db|sqlite3?)($|[-.])/, 'a database file'],
  [/(^|\/)\.env($|\.)/, 'environment file', (p) => p.endsWith('.env.example')],
  [/agent\.config\.json$/, "holds this machine's bearer token"],
  [/^features\.json$/, 'a local deployment choice, not a project fact'],
  [/(^|\/)avatar\./, 'a photo of you'],
  [/(^|\/)data\/logo\./, 'an uploaded app icon'],
  [/\.(pem|key|p12|pfx)$/, 'key material'],
  [/(^|\/)logs?\//, 'runtime logs record every window title'],
  [/settings\.local\.json$/, 'local tool config with absolute paths'],
  [/(^|\/)models\//, '~150MB of third-party binaries'],
];

for (const path of tracked) {
  for (const [pattern, why, exempt] of FORBIDDEN_TRACKED) {
    if (pattern.test(path) && !exempt?.(path)) problems.push(`tracked but should not be: ${path} — ${why}`);
  }
}

/* ------------------------------------------------------------------ */
/* 3. Secrets and personal identifiers inside tracked files            */
/* ------------------------------------------------------------------ */

/**
 * Known-good matches, with the reason each is fine. An allowlist of specific
 * places beats loosening the pattern: loosening would silently stop catching
 * the real thing everywhere else.
 */
const ALLOWED = [
  ['packages/server/src/cli/smoke.ts', /100\.64\.0\.9/, 'a test fixture proving forwarded headers are refused'],
  ['packages/server/src/cli/smoke.ts', /desktop-abc\.tail1234\.ts\.net/, 'an obviously-invented hostname in a test'],
  ['packages/server/src/routes/connect.ts', /100\.64\.0\.0/, 'documentation of the CGNAT range'],
  ['packages/server/src/features/vault/crypto.ts', /[A-Z0-9]{32}/, 'the Crockford base32 alphabet'],
  ['packages/server/src/vault/crypto.ts', /[A-Z0-9]{32}/, 'the Crockford base32 alphabet'],
  ['packages/shared/src/index.ts', /[a-z0-9]{36}/, 'a character set for share encoding'],
  ['scripts/publish-check.mjs', /./, 'this file describes the patterns it looks for'],
];

const SECRET_PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'a JWT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bBQ[A-Za-z0-9_=-]{60,}/, 'a web-push subscription key'],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/, 'a signed token'],
  [/(token|secret|password|api[_-]?key|auth)\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]/i, 'a hard-coded credential'],
];

const PERSONAL_PATTERNS = [
  [/\b[a-z0-9-]+\.[a-z0-9-]*tail[a-z0-9]+\.ts\.net\b/i, 'a real tailnet hostname'],
  [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, 'a real Tailscale address'],
  [/C:\\Users\\(?!<)[A-Za-z0-9._-]+\\/, 'an absolute path naming a Windows user'],
  [
    // Documentation addresses and GitHub noreply addresses are exempt. A
    // noreply address is the *fix* for publishing a personal one, so flagging
    // it would train whoever runs this to ignore the one warning that matters.
    /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)(?!domain\.tld\b)(?!users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    'a real email address',
  ],
];

const SKIP_CONTENT = /(package-lock\.json|\.(png|ico|jpg|jpeg|gif|webp|woff2?|zip|db)$)/;

for (const path of tracked) {
  if (SKIP_CONTENT.test(path)) continue;

  let text;
  try {
    text = readFileSync(resolve(repo, path), 'utf8');
  } catch {
    continue; // deleted, or genuinely binary
  }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const allowedHere = ALLOWED.filter(([p]) => path.startsWith(p) || path === p);

    for (const [pattern, what] of [...SECRET_PATTERNS, ...PERSONAL_PATTERNS]) {
      const hit = line.match(pattern);
      if (!hit) continue;
      if (allowedHere.some(([, allow]) => allow.test(hit[0]))) continue;

      const where = `${path}:${i + 1}`;
      const secret = SECRET_PATTERNS.some(([p]) => p === pattern);
      // Secrets fail. Personal identifiers are a judgement call — a tailnet
      // name grants nothing on its own, but there is no reason to publish it.
      (secret ? problems : warnings).push(`${where} — ${what}: ${hit[0].slice(0, 60)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. Things git itself will publish                                   */
/* ------------------------------------------------------------------ */

/*
 * `--branches`, not `--all`.
 *
 * `--all` includes `refs/original/*`, the pre-rewrite backup git leaves behind
 * after a filter-branch. Those refs are never pushed — `git push` sends refs
 * You name, and even `--all` means `refs/heads/*` — so warning about an address
 * that only survives there reports a problem that has already been fixed.
 */
const authors = new Set(git(['log', '--branches', '--pretty=%an <%ae>']).split('\n').filter(Boolean));
for (const author of authors) {
  if (!/noreply|users\.noreply\.github\.com/.test(author)) {
    warnings.push(
      `every commit is authored by ${author} — that email becomes public. ` +
        `GitHub can supply a noreply address (Settings → Emails → Keep my email address private).`
    );
  }
}

/* ------------------------------------------------------------------ */

const label = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

if (warnings.length > 0) {
  console.log(`\n${label(warnings.length, 'warning')} — your call:\n`);
  for (const w of warnings) console.log(`  ? ${w}`);
}

if (problems.length > 0) {
  console.error(`\n${label(problems.length, 'problem')} — do not push:\n`);
  for (const p of problems) console.error(`  ! ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`\nSafe to publish. ${label(tracked.length, 'file')} tracked, no secrets found.\n`);
