/**
 * What a feedback report says, and the two ways it leaves (2026-11-18).
 *
 * Nothing here sends anything. A report goes as a GitHub issue the person
 * reviews and submits on GitHub, or as an email in their own mail app, so the
 * app holds no address to post to and no key that could be misused. This file
 * builds the text and the two links; `views/Feedback.tsx` draws the screen.
 *
 * **No imports**, so `smoke` asserts `scrub` and the length limits directly,
 * the property `presence.ts` and `chapter-nav.ts` have for the same reason.
 */

export const ISSUES_URL = 'https://github.com/blue91321/Blue-Everything-App/issues/new';
/** A public address made for this, not a person's own: it ships in every release. */
export const FEEDBACK_EMAIL = 'blueeverythingapp@gmail.com';

export type FeedbackKind = 'bug' | 'feature' | 'feedback';

export const KINDS: { id: FeedbackKind; label: string; hint: string; tag: string; template: string }[] = [
  { id: 'bug', label: 'Bug', hint: 'Something is broken or wrong', tag: 'Bug', template: 'bug.md' },
  { id: 'feature', label: 'Feature request', hint: 'Something you would like it to do', tag: 'Feature', template: 'feature.md' },
  { id: 'feedback', label: 'Feedback', hint: 'Anything else', tag: 'Feedback', template: 'feedback.md' },
];

/** What a bug report's box starts with, so the two things worth knowing are asked for. */
export const BUG_OUTLINE = 'What happened:\n\n\nWhat you expected:\n\n\nSteps to make it happen again:\n';

/**
 * GitHub refuses an issue address past about 8KB (414), and some mail apps cut
 * a `mailto:` off near 2,000 characters (Outlook, and Windows' own handoff).
 * Under these the whole report goes in the link; over them, see `fitted`.
 */
export const GITHUB_URL_LIMIT = 7_500;
export const MAILTO_LIMIT = 1_900;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Take out of a line what would say who or where somebody is, or what they
 * read: addresses and their queries (a page's query names the chapter), ids,
 * IP and tailnet addresses, email addresses, user folders and tokens. What is
 * left says which part of the app failed and how, which is what a report needs.
 *
 * Applied when an error is recorded, not when it is sent, so nothing raw is
 * kept on the device either.
 */
export function scrub(text: string): string {
  return (
    text
      .replace(/\b(Bearer\s+)\S+/gi, '$1[hidden]')
      .replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (url) => {
        const path = url.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
        return `[address]${path}`;
      })
      .replace(/(\/[\w./%:-]*)\?[^\s"'<>)]*/g, '$1')
      .replace(UUID, ':id')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
      .replace(/\b[\w-]+(\.[\w-]+)*\.ts\.net\b/gi, '[host]')
      // Not after a slash or a word: Chrome/120.0.6099.230 is a version, not an address.
      .replace(/(?<![\w/.])\d{1,3}(\.\d{1,3}){3}\b/g, '[ip]')
      .replace(/\b[A-Za-z]:\\Users\\[^\\\s"']+/gi, (m) => m.replace(/Users\\.+$/i, 'Users\\[user]'))
      .replace(/\/(Users|home)\/[^/\s"']+/g, '/$1/[user]')
      // Long numbers are ids (a series at a source, a chapter's place); chapter numbers and counts are short.
      .replace(/\b\d{5,}\b/g, ':n')
  );
}

export interface Report {
  kind: FeedbackKind;
  title: string;
  description: string;
  /** Already scrubbed; empty when the person left it out. */
  diagnostics: string;
}

export function tagOf(kind: FeedbackKind): string {
  return KINDS.find((k) => k.id === kind)?.tag ?? 'Feedback';
}

/** The title, or the description's first line when none was typed. */
export function titleOf(report: Report): string {
  const typed = report.title.trim();
  if (typed) return typed.slice(0, 120);
  const first = report.description
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !/^(what happened|what you expected|steps to make it happen again):?$/i.test(line));
  return (first ?? tagOf(report.kind)).slice(0, 80);
}

const SEPARATOR = '\n\n---\nDiagnostics (filled in by the app):\n';

export function bodyOf(report: Report, withDiagnostics = true): string {
  const description = report.description.trim();
  return withDiagnostics && report.diagnostics ? `${description}${SEPARATOR}${report.diagnostics}` : description;
}

export function issueUrl(report: Report, body: string): string {
  const template = KINDS.find((k) => k.id === report.kind)?.template ?? 'feedback.md';
  const query = new URLSearchParams({ template, title: `[${tagOf(report.kind)}] ${titleOf(report)}`, body });
  return `${ISSUES_URL}?${query.toString()}`;
}

/** `mailto:` wants `%20`, not `+`, which most mail apps would show as a plus. */
export function mailtoUrl(report: Report, body: string): string {
  const subject = encodeURIComponent(`[Blue Everything ${tagOf(report.kind)}] ${titleOf(report)}`);
  return `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${encodeURIComponent(body)}`;
}

export interface Fitted {
  url: string;
  /** What did not fit in the link and goes on the clipboard to paste in instead, or null. */
  paste: string | null;
}

const PASTE_DIAGNOSTICS = '\n\n---\nDiagnostics: on your clipboard. Paste them here.';
const PASTE_ALL = '(The report was too long for a link. It is on your clipboard: paste it here.)';

/**
 * The link, as full as the limit allows: the whole report; else the
 * description, with the diagnostics on the clipboard; else a note, with the
 * whole report on the clipboard.
 */
export function fitted(report: Report, where: 'github' | 'email'): Fitted {
  const build = where === 'github' ? (body: string) => issueUrl(report, body) : (body: string) => mailtoUrl(report, body);
  const limit = where === 'github' ? GITHUB_URL_LIMIT : MAILTO_LIMIT;
  const whole = build(bodyOf(report));
  if (whole.length <= limit) return { url: whole, paste: null };
  if (report.diagnostics) {
    const without = build(bodyOf(report, false) + PASTE_DIAGNOSTICS);
    if (without.length <= limit) return { url: without, paste: report.diagnostics };
  }
  return { url: build(PASTE_ALL), paste: bodyOf(report) };
}

/** The email as one block of text, for "Copy message". */
export function emailText(report: Report): string {
  return `To: ${FEEDBACK_EMAIL}\nSubject: [Blue Everything ${tagOf(report.kind)}] ${titleOf(report)}\n\n${bodyOf(report)}`;
}
