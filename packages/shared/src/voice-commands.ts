/**
 * Voice commands: what a phrase can do, and matching what was said against
 * the stored phrases, one command or several in a row.
 */
import { z } from 'zod';
import { ALWAYS_IN_VOCABULARY, stem, voiceTokens } from './voice.js';

/* ------------------------------------------------------------------ */
/* Voice commands — more than habits                                   */
/* ------------------------------------------------------------------ */

/**
 * What a spoken phrase can do.
 *
 * `habit` was the whole vocabulary once. The rest exist because a wake word you
 * already talk to may as well open a site or silence itself, and because a
 * "stop listening" phrase is the only way to switch an always-on microphone off
 * without walking to the keyboard — which is the one moment you most want it.
 *
 * `cancel` and `pause` are easy to confuse and are not the same thing. `cancel`
 * abandons the sentence in progress — you woke it by accident, or changed your
 * mind — and the wake word works again immediately. `pause` shuts the
 * microphone for minutes or until switched back on. "Never mind" should not
 * cost you the next five minutes of voice.
 */
export const voiceCommandKinds = ['habit', 'note', 'url', 'hotkey', 'media', 'launch', 'pause', 'cancel', 'music'] as const;

/**
 * What a `music` command does: Connections → Music's Shuffle card, by voice.
 * Unlike `media` it does not press keys on this PC; the server starts Spotify
 * itself, on whatever device has it open, so it works from anywhere.
 */
export const musicVoiceActions = ['shuffle', 'random', 'queue', 'stop'] as const;
export const voiceCommandKindSchema = z.enum(voiceCommandKinds);
export type VoiceCommandKind = z.infer<typeof voiceCommandKindSchema>;

/**
 * What a `media` command can do.
 *
 * These go out as the system media keys, so they reach whatever owns playback
 * — Spotify, a browser tab, a game — without needing that window focused, which
 * a `hotkey` command would.
 */
export const mediaActions = [
  'playpause',
  'next',
  'previous',
  'stop',
  'volumeup',
  'volumedown',
  'mute',
] as const;
export const mediaActionSchema = z.enum(mediaActions);
export type MediaAction = z.infer<typeof mediaActionSchema>;

export const MEDIA_LABEL: Record<MediaAction, string> = {
  playpause: 'Play / pause',
  next: 'Skip forward',
  previous: 'Skip back',
  stop: 'Stop',
  volumeup: 'Volume up',
  volumedown: 'Volume down',
  mute: 'Mute / unmute',
};

/** Modifiers a hotkey may carry, spelled the way people write them. */
export const HOTKEY_MODIFIERS = ['ctrl', 'control', 'alt', 'shift', 'win', 'super', 'meta'] as const;

/**
 * Keys a hotkey may end on.
 *
 * A deliberate allow-list, not "any string". This ends up as synthetic key
 * presses into whatever window is focused, so the set of things a mis-heard
 * phrase can do should be small and inspectable.
 */
export const HOTKEY_KEYS = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'space', 'enter', 'tab', 'escape', 'backspace', 'delete', 'insert', 'home', 'end',
  'pageup', 'pagedown', 'up', 'down', 'left', 'right',
  'minus', 'plus', 'comma', 'period',
  /*
   * The number pad, which is the natural home for a global hotkey: the keys are
   * far from anything a game binds and most keyboards have them spare.
   *
   * Spelled `numpad*` rather than reusing the digit names because they are
   * genuinely different keys — `5` and `numpad5` are separate virtual-key codes,
   * and registering one does nothing for the other.
   *
   * **Numpad Enter is deliberately absent.** Windows gives it the same
   * virtual-key code as the main Enter and tells them apart only by an extended
   * flag that `RegisterHotKey` cannot see — so offering it would be offering a
   * key that silently binds a different one.
   *
   * **They follow Num Lock.** With it off the keyboard sends the navigation
   * codes instead, so a `numpad5` hotkey answers only while Num Lock is on. The
   * screen says so rather than leaving it to be discovered.
   */
  'numpad0', 'numpad1', 'numpad2', 'numpad3', 'numpad4',
  'numpad5', 'numpad6', 'numpad7', 'numpad8', 'numpad9',
  'numpadplus', 'numpadminus', 'numpadmultiply', 'numpaddivide', 'numpaddecimal',
] as const;

export interface Hotkey {
  modifiers: string[];
  key: string;
}

/**
 * A combination fit to register *system-wide*, which is stricter than one fit
 * to be sent.
 *
 * `parseHotkey` refuses a bare letter, because sending one into whatever window
 * has focus is far too easy to do by accident. Registering has a wider problem:
 * a bare `f5` or `numpad5` would take that key away from **every** program on
 * the machine, so a modifier is required outright rather than only for
 * single-character keys.
 */
export function isGlobalHotkey(value: string): boolean {
  const parsed = parseHotkey(value);
  return parsed !== null && parsed.modifiers.length > 0;
}

/** `"ctrl+shift+m"` to its parts, or null if it isn't one. */
export function parseHotkey(value: string): Hotkey | null {
  const parts = value.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  if (!(HOTKEY_KEYS as readonly string[]).includes(key)) return null;
  if (modifiers.some((m) => !(HOTKEY_MODIFIERS as readonly string[]).includes(m))) return null;
  if (new Set(modifiers).size !== modifiers.length) return null;

  // A bare letter would fire on any focused window the moment a phrase matched,
  // which is far too easy to do by accident.
  if (modifiers.length === 0 && key.length === 1) return null;

  return { modifiers, key };
}

/**
 * Only http(s), and only a parseable URL.
 *
 * Without this a mis-typed target could hand `file:` or a custom protocol
 * handler to the shell, which is a much larger thing than "open a website".
 */
export function isOpenableUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A `launch` target names a row on the games list. It is never a path.
 *
 * **That is the whole safety property of this kind**, and it is the same rule
 * `POST /api/games/:exe/launch` follows: the path is read from a row the agent
 * filled in by watching that executable actually run here, so what a voice
 * command can start is bounded by what this machine has already started by
 * itself. A target that could hold a path would be a spoken "run anything",
 * which is a categorically larger thing than "open the game I named".
 *
 * So a separator is refused rather than normalised — accepting
 * `C:\\Windows\\System32\\cmd.exe` and then failing to find a row for it
 * would work by accident rather than by rule, and the rule is what has to hold
 * when somebody edits this next.
 */
export function isLaunchTarget(value: string): boolean {
  const name = value.trim().toLowerCase();
  if (!name || name.length > 260) return false;
  if (name.includes('/') || name.includes(String.fromCharCode(92)) || name.includes(':')) return false;
  return name.endsWith('.exe');
}

export const createVoiceCommandSchema = z
  .object({
    kind: voiceCommandKindSchema,
    phrases: z.array(z.string().min(1).max(120)).min(1).max(20),
    /** Habit id, URL, or key combo, depending on `kind`. */
    target: z.string().max(2000).nullish(),
    /** For `pause`: how long. Null means until switched back on by hand. */
    pauseMinutes: z.number().int().min(1).max(24 * 60).nullish(),
    /** What to call it on screen. Falls back to something derived from target. */
    label: z.string().max(120).nullish(),
    /**
     * Whether the microphone stays open after this one fires.
     *
     * Chaining suits some commands and not others: two habits in a row is
     * natural, while opening a site or pressing a hotkey means you have already
     * turned your attention elsewhere and a live microphone is just exposure.
     */
    allowFollowUp: z.boolean().default(true),
    enabled: z.boolean().default(true),
    sortOrder: z.number().int().optional(),
  })
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['target'] });

    if (value.kind === 'habit' && !value.target) fail('pick which habit this ticks off');
    if (value.kind === 'url' && !isOpenableUrl(value.target ?? '')) fail('needs a full http:// or https:// address');
    if (value.kind === 'hotkey' && !parseHotkey(value.target ?? '')) {
      fail('needs a key combination with at least one modifier, like ctrl+shift+m');
    }
    if (value.kind === 'media' && !(mediaActions as readonly string[]).includes(value.target ?? '')) {
      fail('pick which media control this is');
    }
    if (value.kind === 'launch' && !isLaunchTarget(value.target ?? '')) {
      fail('pick something from the games list — a name like cs2.exe, never a path');
    }
    if (value.kind === 'music' && !(musicVoiceActions as readonly string[]).includes(value.target ?? '')) {
      fail('pick what it should do with the music');
    }
  });

export interface VoiceCandidate {
  id: string;
  phrases: string[];
}

export interface VoiceMatch {
  id: string;
  /** The stored phrase that won, for showing back "ticked off: drink water". */
  phrase: string;
  /** 0-1. How much of the stored phrase the transcript actually covered. */
  score: number;
  /** True when the last word of the phrase was never heard — see below. */
  lenient?: boolean;
}

/**
 * Every content word of the phrase has to appear. Anything looser matches the
 * wrong habit, and a habit ticked off by mistake is worse than one missed —
 * it is wrong data that you have no reason to go looking for.
 */
export const VOICE_MATCH_FLOOR = 1;

/**
 * Which habit, if any, was that?
 *
 * Order-insensitive coverage of the stored phrase rather than string equality,
 * because speech recognition returns "i drank some water" for a phrase typed as
 * "drink water" and no amount of exact matching survives that. Ties go to the
 * most specific phrase, so "drink coffee" beats a bare "drink".
 */
export function matchVoiceCommand(text: string, candidates: VoiceCandidate[]): VoiceMatch | null {
  const spoken = new Set(voiceTokens(text));
  if (spoken.size === 0) return null;

  let best: VoiceMatch | null = null;

  for (const candidate of candidates) {
    for (const phrase of candidate.phrases) {
      const wanted = voiceTokens(phrase);
      if (wanted.length === 0) continue;

      /*
       * A phrase said as one word covers all of it.
       *
       * `vocabularyFor` puts the joined form in the grammar so the recogniser
       * can answer "nevermind" instead of being forced to split a sound it
       * heard as one word — but the stored phrase is still two tokens, so
       * without this the transcript it can now produce would match nothing at
       * all. The two changes are only useful together.
       */
      const hits = spoken.has(wanted.join(''))
        ? wanted.length
        : wanted.filter((token) => spoken.has(token)).length;
      const score = hits / wanted.length;
      if (score < VOICE_MATCH_FLOOR) continue;

      // Longer phrases win ties: they are the more specific claim about what
      // was said, and a two-word phrase matching is weaker evidence.
      if (!best || score > best.score || (score === best.score && wanted.length > voiceTokens(best.phrase).length)) {
        best = { id: candidate.id, phrase, score };
      }
    }
  }

  return best;
}

/**
 * What was said, minus the trigger and the wake word.
 *
 * "make a note buy milk" against the phrase "make a note" leaves "buy milk",
 * which is the note. Words are removed by stem, so it survives the same
 * mangling everything else here does, and only the *first* occurrence of each
 * trigger word goes — "note that the note is wrong" keeps its second "note".
 */
export function remainderAfterPhrase(text: string, phrase: string, wakeWord = ''): string {
  // Built from the phrase's *raw* words, not `voiceTokens`, which drops filler.
  // "make a note" has to strip its own "a" — matching on content words alone
  // left "Noted: a buy milk", with the article stranded at the front.
  const words = (value: string): string[] =>
    value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  // The joined form too, since the recogniser is now allowed to answer with it
  // — otherwise "makeanote buy milk" would file a note beginning "makeanote".
  const phraseWords = words(phrase);
  const strip = [...phraseWords, ...(phraseWords.length > 1 ? [phraseWords.join('')] : []), ...words(wakeWord)];
  const kept: string[] = [];

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const plain = word.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!plain) continue;

    // Exact first, then by stem, so a stored "drink" still removes a spoken
    // "drank" without "drinks" eating an unrelated word earlier in the list.
    let at = strip.indexOf(plain);
    if (at === -1) at = strip.findIndex((candidate) => stem(candidate) === stem(plain));

    if (at !== -1) {
      strip.splice(at, 1);
      continue;
    }
    kept.push(word);
  }

  return kept.join(' ').trim();
}

/**
 * One sentence into the several commands it might be.
 *
 * "I drank water and skip this track" is two instructions joined by a word that
 * carries no meaning of its own — which is exactly why `and` is already filler
 * to the matcher, and why splitting on it costs nothing when it turns out not
 * to be a joint.
 *
 * This only *proposes* a split. It cannot know whether "salt and pepper" is one
 * phrase or two, and nothing here tries to: the caller requires every segment
 * to match a stored command strictly, and abandons the whole idea if any does
 * not. That is what keeps a phrase containing `and` working — its halves match
 * nothing on their own, so the split is discarded and the sentence is resolved
 * whole, exactly as before.
 *
 * Empty segments are dropped, so a trailing "and" is harmless rather than
 * producing a segment that matches nothing and kills the chain.
 */
export interface UtteranceSegment {
  /** The words of this part, as they were said. */
  text: string;
  match: VoiceMatch;
}

/**
 * One sentence into the several commands it turns out to be.
 *
 * **Splitting on the word "and" does not work, and cannot be made to.** That was
 * the first attempt and it failed against the recogniser rather than against the
 * logic: `spokenVariants` puts `-ing` forms of every phrase word into the
 * grammar, so `watering` is a word the recogniser can emit — and "water and" is
 * acoustically identical to "watering". Asked to choose, it often chose the
 * single word, the joint disappeared, and the sentence quietly did only its
 * first half. Widening or narrowing the grammar just moves which pairs collide;
 * `tracking`, `backing` and `minding` are all sitting in there too.
 *
 * So this looks for the joint nowhere. It walks the words left to right and
 * closes a segment the moment what it has accumulated matches a stored command,
 * then starts a new one. "and" needs never be heard — it is filler to
 * `voiceTokens` and simply lands inside whichever segment it falls in. Neither
 * does it matter that "water and" came back as "watering", because that stems
 * straight back to `water` and the segment matches anyway.
 *
 * Returns null unless there are **at least two** segments and every meaningful
 * word was consumed by one of them. That trailing-words rule is what keeps this
 * conservative: "I drank water and went to the shops" closes one segment and
 * then never matches again, so the leftovers abandon the whole idea and the
 * caller resolves the sentence as a single command, exactly as before.
 *
 * Segments close at the *earliest* point they match. A phrase that is a strict
 * prefix of another would therefore close early — but such a pair is already
 * ambiguous in the single-command path, and the leftover rule turns a
 * mis-segmentation into a clean fallback rather than a wrong action.
 */
export function segmentUtterance(
  text: string,
  candidates: VoiceCandidate[],
  options: { wakeWord?: string } = {}
): UtteranceSegment[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const segments: UtteranceSegment[] = [];
  let current: string[] = [];

  for (const word of words) {
    current.push(word);
    const phrase = current.join(' ');
    const match = matchVoiceCommand(phrase, candidates);
    if (match) {
      segments.push({ text: phrase, match });
      current = [];
    }
  }

  if (segments.length === 0) return null;

  /*
   * Words a segment carried that its own phrase cannot account for.
   *
   * This is the repair for the failure that made chaining look broken: a
   * segment only has to *contain* its phrase's words, so when the first command
   * is half-heard it never closes, and its words get carried along until the
   * next one closes for both. "pause the [music] and I drank water" arrived as
   * tokens `[paus, drink, water]`, matched `drink water`, and the pause was
   * silently dropped — one command where two were asked for, which is worse
   * than failing outright because the half that worked hides the half that did
   * not.
   *
   * The leftover `paus` is exactly what `matchVoiceCommandLoosely` exists for:
   * a command whose tail got clipped. So it is offered there, and a single
   * confident answer becomes a step of its own.
   */
  const explained = new Set<string>([
    // The wake word rides on the front of the first segment and is not a
    // command — see the replay buffer in the agent's voice.ts.
    ...voiceTokens(options.wakeWord ?? ''),
    // "drank two waters" leaves a "two" behind that spokenCount will read.
    ...ALWAYS_IN_VOCABULARY.flatMap((word) => voiceTokens(word)),
  ]);

  /**
   * The one command those leftover words can only have been, or null.
   *
   * Two conditions, and the second is what stops this inventing commands.
   * A single loose candidate is not enough on its own: "went to the shops"
   * loosely matches "go for a walk", because "went" stems to "go" and the
   * lenient matcher is allowed to lose the phrase's last word. Nobody asked to
   * go for a walk.
   *
   * What separates that from a genuinely clipped "pause the…" is that a clipped
   * command contains **only words of the command it was**. "pause" is entirely
   * accounted for by "pause the music"; "shops" is accounted for by nothing in
   * "go for a walk", and its presence says these words are a sentence about
   * something else.
   */
  function onlyCommand(words: string[]): VoiceMatch | null {
    const loose = matchVoiceCommandLoosely(words.join(' '), candidates);
    if (loose.length !== 1) return null;

    const phrase = new Set(voiceTokens(loose[0].phrase));
    const strays = voiceTokens(words.join(' ')).filter((token) => !phrase.has(token));
    return strays.length === 0 ? loose[0] : null;
  }

  const expanded: UtteranceSegment[] = [];
  for (const segment of segments) {
    const phraseTokens = voiceTokens(segment.match.phrase);
    // The run-together form accounts for the phrase just as its parts do, or a
    // segment matched by one would report every word of it as unexplained.
    const accounted = new Set([...phraseTokens, phraseTokens.join('')]);
    /*
     * Collected as the words that were *said*, not as the tokens they reduce
     * to. Handing stems back to a matcher that stems again is a quiet
     * corruption — "pause" reduces to "paus", and a second pass strips the "s"
     * and leaves "pau", which matches nothing at all.
     */
    const residue = segment.text.split(/\s+/).filter((word) => {
      const [token] = voiceTokens(word);
      return token !== undefined && !accounted.has(token) && !explained.has(token);
    });

    if (residue.length > 0) {
      /*
       * A residue that names nothing is left alone rather than being fatal,
       * which keeps this purely additive: a stray word the recogniser invented
       * used to be ignored and still is, so every sentence that chained before
       * still chains. Only a residue that can only have been one clipped
       * command earns a step of its own.
       */
      const clipped = onlyCommand(residue);
      if (clipped) {
        // Before the segment, because the walk only moves forward: a command
        // that failed to close left its words at the front of the one that did.
        expanded.push({ text: residue.join(' '), match: clipped });
      }
    }

    expanded.push(segment);
  }

  /*
   * Words after the last match get the same treatment, because a clipped
   * command is just as likely to be the last thing said as the first — "I drank
   * water and pause the…" trails off exactly as often as it starts badly.
   *
   * The one asymmetry is what happens when they name nothing: trailing words
   * are explained by *no* matched command, so they mean part of the sentence
   * was not understood and the chain is abandoned. A residue inside a segment
   * sits alongside a command that did match, so ignoring it is safe.
   */
  const trailing = current.filter((word) => {
    const [token] = voiceTokens(word);
    return token !== undefined && !explained.has(token);
  });

  if (trailing.length > 0) {
    const clipped = onlyCommand(trailing);
    if (!clipped) return null;
    expanded.push({ text: trailing.join(' '), match: clipped });
  }

  if (expanded.length < 2) return null;

  return expanded;
}

/**
 * Every command whose phrase matches except for its **final** word.
 *
 * The tail of a sentence is what gets clipped: the voice drops, the recogniser
 * decides the utterance ended, and "drink water" arrives as "drink". Strict
 * matching then finds nothing at all, which is the complaint this answers.
 *
 * Deliberately narrow, because looseness here ticks off the wrong thing:
 *
 *  - only the *last* content word may be missing, never a middle one,
 *  - the phrase must have at least two content words, so a one-word phrase can
 *    never match on nothing at all, and
 *  - the caller only reaches this after a strict pass found nothing.
 *
 * Returns every candidate rather than a winner. Two commands can easily share
 * a first word — "drink water" and "drink coffee" — and guessing between them
 * is exactly the failure that must not happen silently, so the caller asks.
 */
export function matchVoiceCommandLoosely(text: string, candidates: VoiceCandidate[]): VoiceMatch[] {
  const spoken = new Set(voiceTokens(text));
  if (spoken.size === 0) return [];

  const found = new Map<string, VoiceMatch>();

  for (const candidate of candidates) {
    for (const phrase of candidate.phrases) {
      const wanted = voiceTokens(phrase);
      if (wanted.length < 2) continue;

      const required = wanted.slice(0, -1);
      if (!required.every((token) => spoken.has(token))) continue;

      const score = required.length / wanted.length;
      const previous = found.get(candidate.id);
      if (!previous || score > previous.score) {
        found.set(candidate.id, { id: candidate.id, phrase, score, lenient: true });
      }
    }
  }

  return [...found.values()];
}

/**
 * Cosine similarity between two speaker embeddings.
 *
 * The vectors are not unit length as they come out of the model, so this
 * normalises rather than taking a bare dot product.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
