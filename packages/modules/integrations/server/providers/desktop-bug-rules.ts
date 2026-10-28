/**
 * The rules for watching Spotify's desktop-app bug — see `spotify-desktop-bug.ts`.
 *
 * No imports, like `shuffle-rules.ts`, so `integrations-check` asserts them
 * directly: what on the forum thread counts as news, and which device is the
 * Web Player.
 */

/** A reply on the thread, as the forum's API gives it, cut down to what is read. */
export interface ForumReply {
  id: number;
  at: string;
  by: string;
  /** The forum's badge on the account: Spotify's staff and its volunteer "Stars" carry one; everybody else, none. */
  label: string;
  /** The reply as HTML. */
  body: string;
  url: string;
}

/** The thread itself: whether an answer was accepted, and whether it was closed. */
export interface ForumThread {
  accepted: boolean;
  closed: boolean;
}

export interface ForumNews {
  at: string;
  by: string;
  why: 'staff' | 'fixed' | 'accepted' | 'closed';
  /** What to show: the sentence that sounded like a fix, or the start of the reply. */
  excerpt: string;
  url: string;
}

/** HTML to plain text, enough for a sentence on screen. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const FIX = /\b(fixed|fixes|working again|works again|works now|working now|resolved|patched|solved)\b/i;
/*
 * A sentence with "fixed" in it is far more often a wish than a report on this
 * thread: "hopefully this gets fixed soon", "is it fixed yet", "still not
 * fixed", and the workaround post's own "the workaround that fixed this for
 * me". So a sentence that also hopes, asks, negates or talks about a way round
 * it does not count. A report missed this way is only a day late: a real fix
 * gets said more than once, and the test button finds it regardless.
 */
const NOT_A_REPORT =
  /\b(hope|hopefully|please|plz|pls|when|until|till|not|no|never|isn'?t|wasn'?t|hasn'?t|haven'?t|doesn'?t|didn'?t|won'?t|still|if|soon|yet|anyone|any|workaround|work around|older|old version|downgrad\w*|web ?player|album|context|wish|need|should)\b/i;

/*
 * Who speaks for Spotify. Measured on the developers' board (100 replies,
 * October 2026): 65 with no badge, 34 "★ Star ★", 1 "🎵 Staff.". Staff are
 * Spotify; Stars are volunteers, a third of all replies, mostly with general
 * advice, so a Star's reply counts only when it says the bug is known, passed
 * on, or fixed.
 */
export function isStaff(label: string): boolean {
  return /\b(staff|moderator|spotify team|employee)\b/i.test(label);
}
const SAYS_PASSED_ON = /\b(aware|investigat\w*|known issue|passed (it|this) on|reported (it|this)|logged|escalat\w*|the team)\b/i;

/** The sentence that reports a fix, or null. */
export function soundsFixed(text: string): string | null {
  for (const raw of text.match(/[^.!?\n]+[.!?]*/g) ?? []) {
    const sentence = raw.trim();
    if (!sentence || sentence.includes('?')) continue;
    if (FIX.test(sentence) && !NOT_A_REPORT.test(sentence)) return sentence;
  }
  return null;
}

function excerpt(text: string, max = 180): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/**
 * What is new since the last look, worth telling somebody about: a reply from
 * a badged account, a reply that sounds like a fix, an answer accepted, or the
 * thread closed. `before` is the thread as last seen, null on the first look —
 * which reports nothing about the thread's state, since there is nothing to
 * compare with. `replies` are the ones not seen before.
 */
export function newsIn(thread: ForumThread, before: ForumThread | null, replies: readonly ForumReply[], threadUrl: string): ForumNews[] {
  const news: ForumNews[] = [];
  const now = new Date().toISOString();
  if (before && thread.accepted && !before.accepted) {
    news.push({ at: now, by: 'the forum', why: 'accepted', excerpt: 'An answer on the thread was marked as accepted.', url: threadUrl });
  }
  if (before && thread.closed && !before.closed) {
    news.push({ at: now, by: 'the forum', why: 'closed', excerpt: 'The thread was closed.', url: threadUrl });
  }
  for (const r of [...replies].sort((a, b) => a.id - b.id)) {
    const text = plainText(r.body);
    const fixed = soundsFixed(text);
    const badge = r.label.replace(/[^\p{L}\p{N} ]/gu, '').trim();
    if (isStaff(r.label) || (badge && (fixed || SAYS_PASSED_ON.test(text)))) {
      news.push({ at: r.at, by: `${r.by} (${badge})`, why: 'staff', excerpt: excerpt(fixed ?? text), url: r.url });
    } else if (fixed) {
      news.push({ at: r.at, by: r.by, why: 'fixed', excerpt: excerpt(fixed), url: r.url });
    }
  }
  return news;
}

/** Spotify's Web Player: a browser tab, which the desktop app's bug does not reach. */
export function isWebPlayer(device: { name?: string | null }): boolean {
  return /^web player\b/i.test((device.name ?? '').trim());
}
