/**
 * Feedback: a bug, a feature request, or anything else, sent by the person
 * themselves as a GitHub issue or an email (2026-11-18).
 *
 * The app sends nothing. Each copy is somebody's own server, so there is no
 * shared place for a report to land, and a form that posted somewhere would
 * need a key in every release. Instead the report is built here and handed to
 * GitHub's new-issue page or the mail app, filled in, where the person reads it
 * and presses send. The text and the links are `feedback-text.ts`.
 *
 * **Diagnostics are shown before they go.** A bug report includes, ticked by
 * default, the version, what kind of device, the screen it was opened from and
 * the last errors this device saw (`recent-errors.ts`), already scrubbed of
 * addresses, ids and names. Never a server log: the log is a record of
 * everything read, and too large for a link besides. "See exactly what's
 * included" shows the very text.
 */
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { Session } from '../api';
import { isAndroid, isInstalled, isIOS } from '../device';
import {
  BUG_OUTLINE,
  emailText,
  FEEDBACK_EMAIL,
  fitted,
  KINDS,
  scrub,
  type FeedbackKind,
  type Report,
} from '../feedback-text';
import { useConnectivity } from '../offline-sync';
import { clearErrors, lastScreen, recentErrors } from '../recent-errors';

const DRAFT_KEY = 'everything.feedback-draft';

interface Draft {
  kind: FeedbackKind;
  title: string;
  description: string;
  /** Null until changed: then it follows the kind (on for a bug). */
  include: boolean | null;
}

const EMPTY: Draft = { kind: 'bug', title: '', description: BUG_OUTLINE, include: null };

/** Kept per device, so going to the mail app and back loses nothing. */
function loadDraft(): Draft {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Partial<Draft> | null;
    if (!parsed || !KINDS.some((k) => k.id === parsed.kind)) return EMPTY;
    return {
      kind: parsed.kind as FeedbackKind,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      include: typeof parsed.include === 'boolean' ? parsed.include : null,
    };
  } catch {
    return EMPTY;
  }
}

function saveDraft(draft: Draft | null): void {
  try {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Refused: the draft lasts as long as the screen.
  }
}

function deviceLine(): string {
  const kind = isIOS() ? (/iPad/.test(navigator.userAgent) || !/iPhone/.test(navigator.userAgent) ? 'iPad' : 'iPhone') : isAndroid() ? 'Android' : 'computer';
  const how = isInstalled() ? 'installed app' : 'browser';
  return `${kind}, ${how}`;
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function diagnosticsText(session: Session, offline: boolean): string {
  const lines = [
    `Version: ${session.version ?? 'unknown (an older server)'}`,
    `Server: ${session.copy ? "a friend's copy" : 'their own'}${session.local ? ', on this computer' : ''}`,
    `Device: ${deviceLine()}`,
    `Screen: ${window.innerWidth}×${window.innerHeight} at ${Math.round(window.devicePixelRatio * 10) / 10}×`,
    `Browser: ${scrub(navigator.userAgent)}`,
    `Was on: ${lastScreen() || 'unknown'}`,
    `Connection: ${offline ? 'offline' : 'online'}`,
    `Packages on: ${(session.features ?? []).join(', ') || 'none listed'}`,
  ];
  const errors = recentErrors();
  lines.push('', errors.length ? `Recent errors on this device (newest first):` : 'Recent errors on this device: none in the last three days');
  for (const error of errors) lines.push(`  ${when(error.at)}  ${error.text}`);
  return lines.join('\n');
}

/**
 * Copy, with the old way for where the clipboard API is refused (an http
 * address that is not this PC is not a secure context).
 */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    box.remove();
    return ok;
  }
}

export function Feedback({ session }: { session: Session }) {
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [note, setNote] = useState('');
  const { offline } = useConnectivity();

  useEffect(() => saveDraft(draft), [draft]);

  const include = draft.include ?? draft.kind === 'bug';
  const diagnostics = useMemo(() => diagnosticsText(session, offline), [session, offline]);
  const report: Report = { kind: draft.kind, title: draft.title, description: draft.description, diagnostics: include ? diagnostics : '' };

  // Only the outline, or nothing: there is nothing yet to send.
  const written = draft.description.replace(BUG_OUTLINE, '').trim() !== '' && draft.description.trim() !== BUG_OUTLINE.trim();
  const github = fitted(report, 'github');
  const email = fitted(report, 'email');

  const pick = (kind: FeedbackKind) => {
    setNote('');
    setDraft((d) => {
      // The bug outline comes and goes with the kind while nothing has been typed into it.
      const untouched = d.description.trim() === '' || d.description === BUG_OUTLINE;
      return { ...d, kind, description: untouched ? (kind === 'bug' ? BUG_OUTLINE : '') : d.description };
    });
  };

  /*
   * The links are real anchors, so the browser treats the press as a person
   * opening something (a scripted open is blocked on some phones). What did
   * not fit goes on the clipboard in the same press, which the clipboard needs.
   */
  const opening = (where: 'GitHub' | 'your email app', paste: string | null) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!written) {
      event.preventDefault();
      return;
    }
    if (!paste) {
      setNote(`Opened ${where}. Nothing is sent until you send it there.`);
      return;
    }
    void copy(paste).then((ok) =>
      setNote(
        ok
          ? `Opened ${where}. The report was too long for a link, so ${paste === report.diagnostics ? 'the diagnostics are' : 'it is'} on your clipboard: paste it in.`
          : `Opened ${where}, but the rest could not be copied. Use Copy message below and paste it in.`
      )
    );
  };

  return (
    <div className="feedback">
      <section>
        <div className="card">
          <div className="title">What is it?</div>
          <div className="tabs" role="radiogroup" aria-label="Kind of feedback" style={{ marginTop: 8 }}>
            {KINDS.map((kind) => (
              <button
                key={kind.id}
                role="radio"
                aria-checked={draft.kind === kind.id}
                className={`tab${draft.kind === kind.id ? ' on' : ''}`}
                title={kind.hint}
                onClick={() => pick(kind.id)}
              >
                {kind.label}
              </button>
            ))}
          </div>
          <label className="meta" htmlFor="feedback-title" style={{ display: 'block', marginTop: 12 }}>
            Summary (optional)
          </label>
          <input
            id="feedback-title"
            maxLength={120}
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            placeholder={draft.kind === 'bug' ? 'Chapter list is empty after switching source' : 'A few words'}
          />
          <label className="meta" htmlFor="feedback-description" style={{ display: 'block', marginTop: 12 }}>
            {draft.kind === 'bug' ? 'What went wrong' : draft.kind === 'feature' ? 'What would you like it to do, and why' : 'Your feedback'}
          </label>
          <textarea
            id="feedback-description"
            rows={9}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
          <label className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
            <input type="checkbox" checked={include} onChange={(e) => setDraft((d) => ({ ...d, include: e.target.checked }))} />
            <span>Include diagnostic info</span>
          </label>
          <details className="feedback-diagnostics">
            <summary className="meta">See exactly what's included</summary>
            <p className="meta">
              Addresses, ids, names and what you were reading are taken out. No server logs are included.
            </p>
            <pre>{diagnostics}</pre>
            <button className="btn" onClick={() => { clearErrors(); setNote('Recent errors cleared.'); }}>
              Clear recent errors
            </button>
          </details>
        </div>
      </section>

      <section className="feedback-send">
        <div className="card">
          <div className="title">GitHub issue</div>
          <div className="meta">
            Opens GitHub with this filled in, to read over and submit. Needs a GitHub account. <strong>Issues are public</strong>: anyone can read them.
          </div>
          <a
            className={`btn primary${written ? '' : ' disabled'}`}
            aria-disabled={!written}
            href={written ? github.url : undefined}
            target="_blank"
            rel="noopener noreferrer"
            onClick={opening('GitHub', github.paste)}
          >
            Open a GitHub issue
          </a>
        </div>
        <div className="card">
          <div className="title">Email</div>
          <div className="meta">
            Goes only to the developer, at <strong>{FEEDBACK_EMAIL}</strong>.
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <a
              className={`btn primary${written ? '' : ' disabled'}`}
              aria-disabled={!written}
              href={written ? email.url : undefined}
              onClick={opening('your email app', email.paste)}
            >
              Open in email app
            </a>
            <button
              className="btn"
              disabled={!written}
              onClick={() => void copy(emailText(report)).then((ok) => setNote(ok ? 'Copied: the address, subject and message. Paste it into any email.' : 'Could not copy here.'))}
            >
              Copy message
            </button>
            <button className="btn" onClick={() => void copy(FEEDBACK_EMAIL).then((ok) => setNote(ok ? 'Address copied.' : 'Could not copy here.'))}>
              Copy address
            </button>
          </div>
        </div>
      </section>

      {!written && <p className="meta">Write something first, and these will open with it filled in.</p>}
      {note && <p className="meta" role="status">{note}</p>}

      <p className="meta">
        <button
          className="btn subtle"
          onClick={() => {
            setDraft(EMPTY);
            saveDraft(null);
            setNote('');
          }}
        >
          Start again
        </button>{' '}
        once it's sent. What you write is kept on this device until then.
      </p>
    </div>
  );
}
