/**
 * How much each extension is actually used, for Manage extensions, and the
 * extensions flagged to install later.
 *
 * An extension provides sources (MangaFire's provides MangaFire (EN), (ES) and
 * the rest), and the library knows sources by name: a series is linked to one,
 * and each finished chapter records the one it was read on. So the counts are
 * per source name, summed per extension.
 *
 * **Chapters are what you read there**, distinct by series and number: the read
 * log can hold a chapter twice (a re-read), and a re-read is not two chapters'
 * worth of use. A chapter read before the log recorded sources has no source,
 * and counts nowhere rather than being guessed at.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '@everything/server/module-api';

type Named = { source: { sourceName: string } | null; readLog?: Array<{ chapter: number; source: string | null }> };
type ExtensionSource = { id: string; name: string; lang: string; pkg: string };

export type ExtensionUsage = {
  /** Series you follow that read from it. */
  series: number;
  /** Chapters you have finished on it. */
  chapters: number;
  sources: Array<{ id: string; name: string; lang: string }>;
};

export function extensionUsage(
  followed: readonly Named[],
  glimpses: readonly Named[],
  sources: readonly ExtensionSource[]
): Record<string, ExtensionUsage> {
  const pkgOf = new Map(sources.map((s) => [s.name, s.pkg]));
  const out: Record<string, ExtensionUsage> = {};
  const entry = (pkg: string) => (out[pkg] ??= { series: 0, chapters: 0, sources: [] });
  for (const s of sources) entry(s.pkg).sources.push({ id: s.id, name: s.name, lang: s.lang });

  for (const [i, s] of [...followed, ...glimpses].entries()) {
    const linked = s.source ? pkgOf.get(s.source.sourceName) : undefined;
    if (linked && i < followed.length) entry(linked).series += 1;
    const seen = new Set<string>();
    for (const r of s.readLog ?? []) {
      const pkg = r.source ? pkgOf.get(r.source) : undefined;
      if (!pkg || seen.has(`${pkg}:${r.chapter}`)) continue;
      seen.add(`${pkg}:${r.chapter}`);
      entry(pkg).chapters += 1;
    }
  }
  return out;
}

/* ---- flagged to install later ---- */

/**
 * Extensions somebody wants installed, flagged where installing is not
 * allowed: a phone. Installing runs code on the PC, so it stays the PC's to
 * do; flagging is a note, which the phone may write and the PC shows at the
 * top of the list. A package cannot add a table, hence the file.
 */
const FLAGS = join(dataDir, 'manga-extension-flags.json');

export function readFlags(): string[] {
  try {
    const v = JSON.parse(readFileSync(FLAGS, 'utf8').replace(/^﻿/, '')) as { pkgs?: unknown };
    return Array.isArray(v.pkgs) ? v.pkgs.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function setFlag(pkg: string, flagged: boolean): string[] {
  const now = readFlags().filter((p) => p !== pkg);
  if (flagged) now.push(pkg);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${FLAGS}.tmp`, JSON.stringify({ pkgs: now }));
  renameSync(`${FLAGS}.tmp`, FLAGS);
  return now;
}
