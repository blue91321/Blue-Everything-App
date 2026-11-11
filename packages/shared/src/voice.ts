/**
 * Voice: the wake word, the vocabulary, and reading counts and amounts out of
 * what was said.
 */
import { z } from 'zod';
import { GAUGE_FULL, gaugeLevelAt } from './habits.js';

/* ------------------------------------------------------------------ */
/* Voice                                                               */
/* ------------------------------------------------------------------ */

/**
 * The wake word is a plain string, changeable at any moment from the settings
 * screen, because that was the requirement that shaped the whole design.
 *
 * The cheap wake-word engines (Porcupine, openWakeWord) are cheap precisely
 * because the keyword is baked into a trained model — changing it means
 * retraining. Keeping it editable means recognising it with a general speech
 * model constrained to a grammar, which costs more CPU and buys the property
 * that actually mattered here.
 *
 * Two words minimum: a single short word fires constantly on ordinary speech,
 * and the room is full of ordinary speech.
 */
/**
 * May a nudge break into a running game?
 *
 * Three states per game and one global default, resolved in one place so the
 * sweep, the API and the settings screen cannot disagree — the same job
 * `resolvePush` does for the phone and `quietReason` for going quiet.
 *
 * **The most restrictive running game wins.** With two games somehow live at
 * once, or one whose row says "never" beside one that follows the default, the
 * answer is no: being interrupted mid-match is the exact failure this whole app
 * exists to prevent, and the cost of being wrong is asymmetric. A nudge held
 * back arrives at the next stopping point a few minutes later; one let through
 * lands in the middle of a fight.
 */
export function gamesAllowInterruption(
  running: ReadonlyArray<{ allowInterruptions: number | null }>,
  interruptByDefault: boolean
): boolean {
  if (running.length === 0) return true;
  return running.every((game) =>
    game.allowInterruptions === null ? interruptByDefault : game.allowInterruptions === 1
  );
}

/** Turn `fortniteclient-win64-shipping.exe` into something readable. */
export function labelForExe(exe: string): string {
  const base = exe.replace(/\.exe$/i, '');
  const trimmed = base
    // Build-system noise every Unreal title carries, and nobody calls it that.
    /*
     * Build-system noise, separated by a dot as well as a dash or underscore —
     * `warframe.x64.exe` was the first real row this ever produced and came out
     * as "Warframe X64".
     */
    .replace(/[-_.](win64|win32|shipping|x64|x86|final|retail)(?=$|[-_. ])/gi, '')
    .replace(/[-_.]+/g, ' ')
    .trim();
  const words = (trimmed || base).split(/\s+/).filter(Boolean);
  /*
   * Short words are upper-cased because they are nearly always initialisms here
   * — cs2, gta5, rdr2 — but the handful that are ordinary English are not, or
   * "league of legends" comes out as "League OF Legends". Only ever the *first*
   * word escapes the exception, since a title starting with "of" is not a thing.
   */
  const LOWER = new Set(['of', 'the', 'and', 'a', 'an', 'to', 'in', 'at', 'on', 'for']);
  return words
    .map((word, i) => {
      if (LOWER.has(word)) return i === 0 ? word[0]!.toUpperCase() + word.slice(1) : word;
      if (word.length <= 3) return word.toUpperCase();
      return word[0]!.toUpperCase() + word.slice(1);
    })
    .join(' ');
}

export const wakeWordSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z]+(?: [a-z]+)*$/i, 'letters and single spaces only — it is matched against spoken words');

export const DEFAULT_WAKE_WORD = 'hey everything';

/**
 * Words that keep being heard *as* the wake word, and are not it.
 *
 * The same shape as a wake word — letters and single spaces — because they go
 * into the same grammar and the model can only be given words it can pronounce.
 * Comma-separated on the way in; a list on the way out.
 */
export const wakeDecoysSchema = z.string().max(400);

/** The most that may be added. Each one is another path the decoder considers. */
export const MAX_WAKE_DECOYS = 24;

/**
 * Split the stored string into usable entries.
 *
 * Anything that is not letters and spaces is dropped rather than refused: this
 * is a convenience list somebody types in a hurry, and rejecting the whole box
 * because of a stray comma would be the wrong trade. The wake word itself is
 * removed if it appears — putting it in the decoy list would be asking the
 * grammar to compete with itself.
 */
export function parseWakeDecoys(stored: string, wakeWord = ''): string[] {
  const wake = wakeWord.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of stored.split(',')) {
    const word = raw.trim().toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!word || word === wake || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_WAKE_DECOYS) break;
  }
  return out;
}

/**
 * Other ways the wake word comes out when you say it, which count as it: the
 * opposite of a decoy. "jervis" for "jarvis" is the reason. The spotter
 * listens for the wake word as the model expects it said, and a pronunciation a
 * vowel off did not wake it at all; listened for as well, it does.
 *
 * Stored and cleaned exactly as the decoys are. One that is also a decoy is
 * dropped from the decoys, not from here, since saying it counts is the newer
 * and more specific claim.
 */
export const wakeAlikesSchema = wakeDecoysSchema;

export function parseWakeAlikes(stored: string, wakeWord = ''): string[] {
  return parseWakeDecoys(stored, wakeWord);
}

/**
 * A word as it sounds, roughly: consonants by how they are said, vowels
 * dropped except a leading one. "jarvis", "jervis", "jervice" and "jurvis" are
 * all `jrfs`; "service" is `srfs` and "nervous" `nrfs`, so the first sound,
 * which carries most of a name, still tells them apart.
 *
 * For *offering* a sound-alike from what a test heard, and for reading a test's
 * transcript, never for deciding what wakes the PC: a key this coarse would be
 * far too generous as a rule. What wakes it is the spotter, told only the
 * spellings you accepted.
 */
export function soundKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w
    .replace(/^kn|^gn|^wr|^ps/, (m) => m[1]!)
    .replace(/ph/g, 'f')
    .replace(/ck|q/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/dg(?=[eiy])/g, 'j')
    .replace(/g(?=[eiy])/g, 'j')
    .replace(/[zv]/g, (m) => (m === 'z' ? 's' : 'f'))
    .replace(/(?<=.)[wh]/g, '');
  const first = w[0]!;
  const rest = w.slice(1).replace(/[aeiouy]/g, '');
  return (first + rest).replace(/(.)\1+/g, '$1');
}

/**
 * Whether what was heard sounds like the wake word, and if so the words that
 * were written for its name: "a jervice" heard for "hey jarvis" gives
 * `"jervice"`. Null when it does not sound like it, or when it is the wake word
 * spelled right, which needs no alike.
 */
export function soundsLikeWakeWord(heard: string, wakeWord: string): string | null {
  const required = wakeWordRequired(wakeWord);
  if (required.length === 0) return null;
  const words = heard.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const keys = required.map(soundKey);
  // A short name's key ("jo" is `j`) matches far too much to offer anything.
  if (keys.some((k) => k.length < 3)) return null;
  for (let i = 0; i + required.length <= words.length; i++) {
    const run = words.slice(i, i + required.length);
    if (run.every((w, n) => soundKey(w) === keys[n])) {
      const said = run.join(' ');
      return said === required.join(' ') ? null : said;
    }
  }
  // Said as one word: "jervisdrink" is not a thing, but "jar vis" for "jarvis" is.
  if (required.length === 1) {
    for (let i = 0; i + 1 < words.length; i++) {
      const joined = words[i]! + words[i + 1]!;
      if (soundKey(joined) === keys[0] && joined !== required[0]) return `${words[i]} ${words[i + 1]}`;
    }
  }
  return null;
}

/**
 * Words a speech recogniser drops constantly and that carry no identity.
 *
 * "hey" is short, unstressed and usually run into the next word, so a recogniser
 * hears "jarvis" far more often than it hears "hey jarvis". Requiring the whole
 * phrase meant the wake word failing on utterances where the distinctive part
 * was recognised perfectly.
 */
const WAKE_PREFIXES = new Set(['hey', 'ok', 'okay', 'hi', 'hello', 'yo', 'hay', 'a', 'uh', 'um']);

/**
 * The part of the wake word that actually has to be heard.
 *
 * Leading attention words are optional; whatever follows them is the name and
 * is required. The keyword spotter is given both — the wake word as typed and
 * this — so a half-heard "…jarvis" counts, which is the common case.
 */
export function wakeWordRequired(wakeWord: string): string[] {
  const words = wakeWord.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const required = words.filter((word, index) => !(index < words.length - 1 && WAKE_PREFIXES.has(word)));
  // Never strip everything: "hey ok" would otherwise require nothing at all.
  return required.length > 0 ? required : [words[words.length - 1]];
}

/** Did that utterance contain the wake word? */
export function matchesWakeWord(heard: string, wakeWord: string): boolean {
  const required = wakeWordRequired(wakeWord);
  if (required.length === 0) return false;

  // Consumes each match, so a wake word with a repeated word needs it that many
  // times. A plain set would let "jar" satisfy "jar jar".
  const pool = heard.toLowerCase().split(/\s+/).filter(Boolean);
  return required.every((word) => {
    const found = pool.indexOf(word);
    if (found === -1) return false;
    pool.splice(found, 1);
    return true;
  });
}

/**
 * Why this wake word might be a bad one — advice, never a refusal.
 *
 * A one-word wake word is genuinely worse: it fires on ordinary conversation,
 * and with an always-on microphone that means habits ticked off by accident.
 * But it is also the thing that survives being half-heard, so it is your
 * call to make, not the schema's.
 */
export function wakeWordAdvice(wakeWord: string): string | null {
  const words = wakeWord.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  if (words.length === 1) {
    const only = words[0];
    if (only.length <= 4) {
      return `"${only}" is short as well as single — it will fire on ordinary conversation. A distinctive name of three syllables or more is far more reliable.`;
    }
    return `One word will fire more often by accident, since there is nothing before it to rule out ordinary speech. Worth it if the longer version keeps getting half-heard — a distinctive name works best.`;
  }

  return null;
}

/** How long after the wake word the command must arrive before we give up. */
export const VOICE_COMMAND_TIMEOUT_MS = 6000;

/**
 * How long it waits after a *failed* attempt, as opposed to a successful one.
 *
 * A different question with a different answer. After it works, a follow-up is
 * a second thing you might say. After it fails, you are repeating yourself —
 * which takes longer, because you have to notice it failed first. So this
 * defaults higher and is its own slider rather than sharing one.
 *
 * Bounded to a single retry per wake, in `voice.ts`. Reopening on every failure
 * would let one misheard cough hold the microphone open indefinitely.
 */
export const DEFAULT_VOICE_RETRY_SECONDS = 8;

/**
 * Where the popup appears.
 *
 * `cursor` is the original behaviour — beside the pointer. The anchors put it
 * in a fixed spot instead, which is what you want on a multi-monitor desk where
 * the pointer is wherever you last clicked rather than where you are looking.
 */
/** How many cells the anchor grid has on each axis. */
export const OVERLAY_GRID = 5;

/**
 * The nine original anchors.
 *
 * Kept valid rather than migrated. They are what is already stored in
 * `settings.overlay_placement`, and a value the schema no longer accepts is a
 * settings row that fails to save on the next unrelated change — an expensive
 * way to tidy up a name. They map onto the corners, edges and middle of the
 * finer grid, which is exactly where they always were.
 */
const LEGACY_ANCHORS = {
  'top-left': { row: 1, col: 1 },
  top: { row: 1, col: 3 },
  'top-right': { row: 1, col: 5 },
  left: { row: 3, col: 1 },
  centre: { row: 3, col: 3 },
  right: { row: 3, col: 5 },
  'bottom-left': { row: 5, col: 1 },
  bottom: { row: 5, col: 3 },
  'bottom-right': { row: 5, col: 5 },
} as const satisfies Record<string, { row: number; col: number }>;

/**
 * `grid-<row><col>`, 1-indexed from the top left.
 *
 * Coordinates rather than names because there is no honest English for the cell
 * two-fifths across and one-fifth down, and inventing one ("upper-midleft")
 * would be worse than a number at saying where it is. The screen draws a grid;
 * the value says which square.
 */
export const overlayGridPlacements = Array.from({ length: OVERLAY_GRID * OVERLAY_GRID }, (_, i) => {
  const row = Math.floor(i / OVERLAY_GRID) + 1;
  const col = (i % OVERLAY_GRID) + 1;
  return `grid-${row}${col}` as const;
});

export const overlayPlacements = [
  'cursor',
  ...(Object.keys(LEGACY_ANCHORS) as (keyof typeof LEGACY_ANCHORS)[]),
  ...overlayGridPlacements,
] as const;

export const overlayPlacementSchema = z.enum(
  overlayPlacements as unknown as [string, ...string[]]
);
export type OverlayPlacement = (typeof overlayPlacements)[number];

/**
 * Which cell of the grid a placement means, or null for `cursor`.
 *
 * The one place the legacy names and the coordinates are reconciled, so the
 * agent, the settings screen and anything later cannot disagree about where
 * "bottom" is.
 */
export function placementCell(placement: string): { row: number; col: number } | null {
  const legacy = LEGACY_ANCHORS[placement as keyof typeof LEGACY_ANCHORS];
  if (legacy) return { row: legacy.row, col: legacy.col };

  const match = /^grid-([1-9])([1-9])$/.exec(placement);
  if (!match) return null;

  const row = Number(match[1]);
  const col = Number(match[2]);
  // A coordinate outside the grid is a value from a newer client, or a typo in
  // the database. Falling back to the cursor beats putting a window off-screen.
  if (row > OVERLAY_GRID || col > OVERLAY_GRID) return null;
  return { row, col };
}

export const MAX_VOICE_FOLLOW_UP_SECONDS = 30;

export const voiceCommandSchema = z.object({
  /** What was heard after the wake word. Never the raw audio — see voice.ts. */
  text: z.string().min(1).max(500),
  /** Cosine similarity against the enrolled voiceprint, if one exists. */
  speakerScore: z.number().min(-1).max(1).nullish(),
  at: z.number().int().optional(),
  /**
   * Started by the listen shortcut rather than the wake word. A key pressed on
   * this keyboard is its own proof, so the server neither holds it to a
   * voiceprint (there is no wake word to take one from) nor refuses it while
   * voice is off, when "use the shortcut while voice is off" is switched on.
   */
  manual: z.boolean().optional(),
});
export type VoiceCommand = z.infer<typeof voiceCommandSchema>;

/**
 * How long a listening test stays armed.
 *
 * Generous on purpose: the first time through you are reading the instructions,
 * finding the wake word, and clearing your throat. It used to be 30s *and* up
 * to a third of that was spent waiting for the agent to notice the test had
 * started, which is why it appeared to end early.
 */
export const VOICE_TEST_MS = 45_000;

/**
 * What the agent tells the server about itself.
 *
 * The Voice screen was write-only before this: it could turn the microphone on
 * but had no way to say whether anything was actually listening. A switch that
 * reads "on" while the agent is stopped, the models are missing, or the wrong
 * microphone is selected is worse than no switch, because it looks like it
 * worked.
 */
export const voiceAgentReportSchema = z.object({
  /** The microphone is open and the models are loaded right now. */
  listening: z.boolean(),
  /** Which device is actually in use — resolved, not requested. */
  device: z.string().max(200).nullish(),
  /** Everything Windows can see, so the settings screen can offer a choice. */
  devices: z.array(z.object({ id: z.number().int(), name: z.string().max(200) })).max(64).default([]),
  /** Monitors, likewise — the overlay has to be put somewhere real. */
  screens: z
    .array(z.object({ id: z.string().max(200), label: z.string().max(200), primary: z.boolean() }))
    .max(16)
    .default([]),
  /** Why it isn't listening, when it isn't. */
  error: z.string().max(300).nullish(),
  /**
   * The microphone is closed because nobody is at the desk.
   *
   * Reported rather than inferred, because "not listening" has several causes
   * with different fixes and a screen that cannot tell them apart is the
   * write-only screen this whole report exists to avoid. Without it, walking
   * away would make the Voice tab say "starting up…" indefinitely.
   */
  awayFromPc: z.boolean().default(false),
  /**
   * Listening for one command because the listen shortcut was pressed while
   * voice is off. Without it the screen said "Switched off" beside a
   * microphone that was open.
   */
  borrowed: z.boolean().default(false),
  /**
   * Fetching the speech models, in words — "Downloading the command
   * recogniser — 31MB of 101MB". Null otherwise. The first switch-on downloads
   * about 100MB, and a screen that said "starting up" for a minute and a half
   * would look stuck.
   */
  preparing: z.string().max(200).nullish(),
  /** Loudest RMS since the last report, 0-1. Drives the level meter. */
  peak: z.number().min(0).max(1).default(0),
  /**
   * Hold the response until something changes, up to this long. The agent has
   * no live connection to the server, so this is how it reacts to "Test it"
   * immediately without asking on a fast timer forever.
   */
  waitMs: z.number().int().min(0).max(25_000).optional(),
  /** Version the agent last saw; a mismatch answers straight away. */
  since: z.number().int().optional(),
  /**
   * Phrase words the recogniser will never write — today, a number in digits,
   * since speech is written down as words. A phrase containing one can never
   * match. Reported so the screen can say which, rather than leaving a command
   * that reads perfectly and never works. (Under Vosk this was words missing
   * from the model's dictionary.)
   */
  unknownWords: z.array(z.string().max(60)).max(50).default([]),
  /** How many usable enrolment samples are in hand, while enrolling. */
  enrolSamples: z.number().int().min(0).max(200).optional(),
  /** How well the last sample agreed with the ones before it, 0-1. */
  enrolAgreement: z.number().min(-1).max(1).nullish(),
  /*
   * Key combinations the agent could not register, nearly always because
   * another program already owns them. Optional so an older agent — which sends
   * no such field — is read as "none" rather than having its whole report
   * refused, the treatment every field added to this payload has had.
   */
  hotkeyProblems: z.array(z.string().max(200)).max(8).optional(),
});
export type VoiceAgentReport = z.infer<typeof voiceAgentReportSchema>;

/**
 * Something the agent heard during a listening test.
 *
 * Reported rather than acted on: the point of a test is to see what *would*
 * happen, and a test that ticked off real habits would be its own problem.
 */
export const voiceHeardSchema = z.object({
  /**
   * `speech` is words heard *without* the wake word. It exists because the
   * single most useful thing a test can tell you is which of two failures you
   * have: the microphone isn't picking you up at all, or it is picking you up
   * fine and the wake word simply isn't being recognised. A level meter alone
   * cannot separate those, and they have completely different fixes.
   */
  kind: z.enum(['level', 'speech', 'wake', 'command']),
  /**
   * Whether this transcript actually contains the wake word.
   *
   * Decided by the agent, which is the only side that knows the wake word
   * without the PWA importing zod. It exists because during a test two
   * recognisers run in parallel and endpoint independently: the wide one often
   * finishes a block or two before the wake one, and reporting that as "but not
   * the wake word" was a flat lie about a transcript with the wake word in it.
   */
  matchedWake: z.boolean().default(false),
  text: z.string().max(500).default(''),
  speakerScore: z.number().min(-1).max(1).nullish(),
  peak: z.number().min(0).max(1).default(0),
});
export type VoiceHeard = z.infer<typeof voiceHeardSchema>;

/**
 * Enrolment, as a mode the running agent enters.
 *
 * It cannot be a separate process: the agent already holds the microphone, and
 * a second opener gets `MMSYSERR_ALLOCATED` rather than a voiceprint. So the
 * server arms a window, the agent collects wake-word embeddings during it, and
 * both the button and the CLI drive that same one path.
 */
export const VOICE_ENROL_MS = 90_000;

/** Where the mean stops moving much. Fewer, and one odd delivery skews it. */
export const VOICE_ENROL_SAMPLES = 10;

/** Below this the embedding came from too little audio to mean anything. */
export const VOICE_ENROL_MIN_FRAMES = 40;

/**
 * How long a voiceprint from the current speaker model is.
 *
 * Vosk's were 128 numbers and the 3D-Speaker model's are 192, and the two
 * cannot be compared — not even by truncating, since the dimensions mean
 * nothing to each other. So a voiceprint of any other length is **stale**: kept,
 * because forgetting it silently would be a protection switched off behind your
 * back, but not enforced, and the Voice screen asks for a fresh enrolment.
 * Enforcing it would refuse every command, since nothing could ever score
 * against it.
 */
export const VOICEPRINT_DIMENSIONS = 192;

export function voiceprintIsCurrent(voiceprint: readonly number[] | null | undefined): boolean {
  return Array.isArray(voiceprint) && voiceprint.length === VOICEPRINT_DIMENSIONS;
}

/**
 * Mean of the length-normalised vectors.
 *
 * Normalising first matters: the model's vectors do not share a magnitude, and
 * averaging raw ones lets a single loud delivery dominate. Cosine similarity
 * ignores magnitude at comparison time, so it should be removed here too.
 */
export function averageVoiceprint(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) return [];

  const mean = new Array<number>(vectors[0].length).fill(0);
  for (const vector of vectors) {
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    for (let i = 0; i < vector.length; i++) mean[i] += vector[i] / norm / vectors.length;
  }
  return mean;
}

/** A 128-dim x-vector from the speaker model, averaged over enrolment clips. */
export const voiceEnrolSchema = z.object({
  voiceprint: z.array(z.number()).min(16).max(512),
  /** How many clips went into it — shown on the settings screen. */
  samples: z.number().int().positive().max(200),
});

/**
 * Irregular pasts, because the whole point is that "I drank water" should tick
 * off a habit whose phrase is "drink water". Suffix stripping alone cannot get
 * from `drank` to `drink`, and these are exactly the verbs people use for the
 * things they do every day.
 */
const IRREGULAR: Record<string, string> = {
  drank: 'drink', drunk: 'drink', ate: 'eat', eaten: 'eat', took: 'take', taken: 'take',
  went: 'go', gone: 'go', ran: 'run', did: 'do', made: 'make', read: 'read', slept: 'sleep',
  fed: 'feed', wrote: 'write', written: 'write', brushed: 'brush', swam: 'swim', paid: 'pay',
};

/**
 * One word, spelled two ways. The recogniser writes "mic" as "mike" whenever
 * it is not sure it heard a word about microphones (measured: "mic back on"
 * came back "mike back on" from both of Windows' voices at every volume), so a
 * phrase typed with "mic" could never match it. Kept to spellings that mean
 * nothing else in a command.
 */
const SAME_WORD: Record<string, string> = {
  mike: 'mic', mikes: 'mic', microphone: 'mic', microphones: 'mic',
};

/**
 * Words that carry no meaning in a command and vary wildly between the way a
 * phrase was typed and the way it gets said. Dropping them is what lets one
 * stored phrase cover "drink water", "I drank the water" and "just had some water".
 */
const FILLER = new Set([
  'i', 'a', 'an', 'the', 'some', 'my', 'me', 'just', 'please', 'ok', 'okay', 'now',
  'have', 'has', 'had', 'do', 'does', 'done', 'to', 'of', 'and', 'it', 'that', 'this',
  'was', 'is', 'am', 'been', 'be', 'get', 'got', 'for', 'so', 'then', 'already',
]);

/**
 * Words the grammar must always carry, whatever the phrases are.
 *
 * `spokenCount` reads these out of a transcript — but a grammar can only emit
 * what it contains, so without them "I drank two waters" came back as "waters"
 * and matched nothing at all. The counting feature was reading for words the
 * recogniser had never been allowed to say.
 */
export const ALWAYS_IN_VOCABULARY = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'twice', 'once', 'couple',
  /*
   * The same bargain as the counting words, for the same reason: `spokenAmount`
   * reads these, and a closed grammar can only emit what it contains — so
   * without them "drink water to max" comes back with the "max" replaced by
   * whatever sounded nearest, and the feature reads for a word the recogniser
   * was never allowed to say.
   */
  'max', 'maximum', 'full',
  /*
   * `and` earns its place differently from the counting words, and more
   * modestly. Nothing *reads* it — `segmentUtterance` deliberately does not look
   * for the joint, having learned that "water and" comes back as "watering".
   *
   * It is here so the recogniser has somewhere harmless to put the sound. A
   * closed grammar must emit *something* for every noise it hears, and denying
   * it the actual word only pushes the guess onto a neighbour. It is filler to
   * the matcher, so it can never affect which command wins.
   */
  'and',
] as const;

/** Spoken counts, so "I drank two waters" adds two rather than one. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  a: 1, an: 1, couple: 2, twice: 2, once: 1,
};

export function stem(word: string): string {
  // Through `dropSilentE` like every other path: the table maps "took" to
  // "take", and returning that raw would leave it disagreeing with the "tak"
  // that "take" itself reduces to — the one word in the sentence that had to
  // agree.
  if (IRREGULAR[word]) return dropSilentE(IRREGULAR[word]);
  // Order matters: check the longer suffixes first, and never strip a word down
  // to nothing or to a single letter.
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length <= suffix.length + 2 || !word.endsWith(suffix)) continue;

    /*
     * `-es` is only a plural ending after a sibilant, and checking that is what
     * makes this the inverse of `spokenVariants` rather than merely its rough
     * shape.
     *
     * Without it, "coffees" stripped to "coffe" while the stored "coffee"
     * stemmed to itself — so a phrase of "drink coffee" could never be reached
     * by saying "I drank two coffees", which is the ordinary way to say it. The
     * two functions have to agree or the grammar is being widened with forms the
     * matcher then fails to fold back, which is the exact failure the widening
     * was introduced to prevent.
     */
    if (suffix === 'es' && !/(s|x|z|ch|sh)$/.test(word.slice(0, -2))) continue;

    /*
     * A lone `-s` is never the plural of a word already ending `-ss`.
     *
     * English pluralises those with `-es` — "press" gives "presses", not
     * "presss" — so stripping the single `s` turned "press" into "pres" while
     * "pressed" reduced to "press", and the two halves of the same word stopped
     * matching. Predates the doubled-consonant work below and was found by the
     * round-trip check that work added: "floss" and "pass" fail identically.
     */
    if (suffix === 's' && word.endsWith('ss')) continue;

    const base = word.slice(0, -suffix.length);
    /*
     * `-ing` and `-ed` attach to a stem that has *already* lost its silent `e`
     * — "pause" gives "pausing", "take" gives "taking" — so stripping the
     * suffix has undone it and taking another `e` would go one too far.
     * "coffeed" is the case that shows it: strip `ed` and you have "coffe",
     * which is exactly what "coffee" itself reduces to.
     *
     * The plural endings are the other way round; they leave the `e` in place.
     */
    return suffix === 'ing' || suffix === 'ed' ? undouble(base) : dropSilentE(base);
  }
  return dropSilentE(word);
}

/**
 * Collapse a trailing `e`, on the stem rather than trying to restore it.
 *
 * English drops the `e` before `-ing` and `-ed`, so "take" gives "taking" and
 * "pause" gives "pausing". Putting it back correctly is a genuinely hard
 * problem — Porter needs a syllable measure and still gets "agreed" and "paused"
 * wrong in opposite directions. Removing it needs none of that, and both sides
 * land in the same place, which is all this has to achieve:
 *
 *   take, taking, taked  -> tak
 *   coffee, coffees      -> coffe
 *   pause, pausing       -> paus
 *
 * The cost is that two words differing only by a final `e` would collide. That
 * is a real loss in a dictionary and no loss at all here: the vocabulary is a
 * handful of phrases you wrote yourself, and the alternative was **"I'm taking
 * my vitamins" never matching a stored "take vitamins"** — a common sentence,
 * failing silently, because the grammar offered "taking" and the matcher then
 * refused to fold it back.
 */
function dropSilentE(word: string): string {
  return word.length > 3 && word.endsWith('e') ? word.slice(0, -1) : word;
}

/**
 * Undo the consonant English doubles before `-ed` and `-ing`.
 *
 * "sip" gives "sipped", so stripping `ed` leaves "sipp" — which matched nothing,
 * because the stored "sip" reduces to "sip". Exactly the same shape of failure
 * as "taking" reducing to "tak" while "take" stayed "take", and it hits a whole
 * class of ordinary short verbs: sip, jog, plan, stop, nap, chat, log, trim.
 *
 * **`l`, `s` and `z` are excluded, and that is not a detail.** Plenty of words
 * simply end in those doubled — "press", "fall", "buzz" — and collapsing them
 * would turn "pressed" into "pres" while "press" stayed "press", trading one
 * broken class for another. It is Porter's own condition, for the same reason.
 */
function undouble(word: string): string {
  const last = word.at(-1) ?? '';
  if (word.length > 3 && last === word.at(-2) && !'lsz'.includes(last) && !/[aeiou]/.test(last)) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * ...and the generator has to double it, or the recogniser can never say it.
 *
 * The two halves are useless apart. Without this, `spokenVariants('sip')` offers
 * the grammar "siped" and "siping" — spellings nobody says, which Vosk drops as
 * not being in its lexicon — so the recogniser has no way to emit "sipped" at
 * all and the stemmer fix above never gets a chance to fold it back.
 *
 * The condition is the usual one: a short word ending consonant-vowel-consonant,
 * where that last consonant is not w, x or y ("row" is not "rowwed").
 */
function doublesFinal(word: string): boolean {
  return /^[a-z]*[^aeiou][aeiou][^aeiouwxy]$/.test(word) && word.length <= 5;
}

/**
 * The forms of a word someone might actually say.
 *
 * The matcher stems, so a stored "drink water" already covers "I drank some
 * water" — but the *recogniser* cannot help: a grammar can only emit words it
 * contains, and the stored phrase gives it "drink" and not "drank". Asked to
 * transcribe "drank" it must pick something from the list anyway, and the thing
 * it picks is arbitrary. On this machine "I drank water" came back as "resume
 * water", which then matched a one-word "resume" phrase and paused the music.
 *
 * So the grammar is widened with the inflections, and the matcher stems them
 * all back to the same token. Widening is safe precisely because of that: every
 * generated form reduces to the word it came from, so a mis-hear between two of
 * them still matches the same command. Forms the model does not know are
 * dropped by Vosk harmlessly.
 */
export function spokenVariants(word: string): string[] {
  const base = word.toLowerCase().trim();
  if (!base) return [];

  const forms = new Set<string>([base]);

  // Irregular pasts, read backwards out of the table the stemmer uses.
  for (const [past, root] of Object.entries(IRREGULAR)) {
    if (root === base) forms.add(past);
  }

  // Too short to inflect sensibly — "go" would give "goed".
  if (base.length > 2) {
    forms.add(/(s|x|z|ch|sh)$/.test(base) ? `${base}es` : `${base}s`);
    const stemForSuffix = doublesFinal(base) ? `${base}${base.at(-1)}` : base;
    forms.add(base.endsWith('e') ? `${base}d` : `${stemForSuffix}ed`);
    forms.add(base.endsWith('e') ? `${base.slice(0, -1)}ing` : `${stemForSuffix}ing`);
  }

  return [...forms];
}

/** Meaningful, stemmed words. The unit both sides of a match are reduced to. */
export function voiceTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => SAME_WORD[word] ?? word)
      /*
       * Filler goes *before* stemming as well as after, and the first pass is
       * the one that matters.
       *
       * `FILLER` is spelled the way people write these words — "have", "some",
       * "please" — and stemming reaches them first: `dropSilentE` turns "have"
       * into "hav", which is in no list at all. Filtering only afterwards left
       * every filler word in the sentence counting as content, so "just had some
       * water" stopped reducing to "water".
       */
      .filter((word) => !FILLER.has(word))
      .map(stem)
      .filter((word) => !FILLER.has(word))
  );
}

/** How many the speaker asked for, defaulting to one. */
export function spokenCount(text: string): number {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const word of words) {
    const digits = Number(word);
    if (Number.isInteger(digits) && digits >= 1 && digits <= 20) return digits;
    // `a`/`an` are only a count next to something countable, and treating them
    // as one is the same answer as the default anyway — so only take words that
    // are unambiguously numbers.
    if (NUMBER_WORDS[word] !== undefined && word !== 'a' && word !== 'an') return NUMBER_WORDS[word];
  }
  return 1;
}

/**
 * Saying "to max" means all the way, however far that is.
 *
 * The counterpart to `spokenCount`, and the reason it is a separate word rather
 * than a number: for a gauge you rarely know the number. Six glasses of water
 * refills a 16%-a-glass gauge from empty and four does it from a third — you
 * would have to read the percentage and divide, which is exactly the sort of
 * arithmetic saying it out loud is meant to avoid.
 *
 * Three words, kept few on purpose. Every one of these goes into a *closed*
 * grammar that must map every noise it hears onto something it contains, so each
 * addition is one more thing an unrelated sound can become. "all the way" was
 * the obvious fourth and is not here: it would put "all" and "way" — two of the
 * commonest words in English — permanently into the vocabulary, to save two
 * characters over "max".
 */
const MAX_WORDS = new Set(['max', 'maximum', 'full']);

/** A count, or `max`. What one utterance asks to be recorded. */
export type SpokenAmount = number | 'max';

/**
 * How much was asked for: "two waters" is 2, "water to max" is everything.
 *
 * `max` outranks a number when both appear, because it is the stronger claim —
 * "two waters, actually fill it up" means fill it up.
 */
export function spokenAmount(text: string): SpokenAmount {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.some((word) => MAX_WORDS.has(word))) return 'max';
  return spokenCount(text);
}

/**
 * Turn that into a number of ticks for a particular habit.
 *
 * `max` means "as done as this thing gets", which is a different number in each
 * mode — and none of them is a constant the caller could have known:
 *
 *   - `gauge`    however many top-ups reach full from where it is now.
 *   - `target`   whatever is left of the target.
 *   - `interval` one. There is no "more done" than done.
 */
export function ticksFor(
  habit: {
    mode: string;
    targetPerPeriod: number;
    gaugeLevel: number;
    gaugeLevelAt: number;
    gaugeDrainPerDay: number;
    gaugeFillPercent: number;
  },
  amount: SpokenAmount,
  context: { doneThisPeriod: number },
  now = Date.now()
): number {
  if (amount !== 'max') return Math.max(1, amount);

  if (habit.mode === 'gauge') {
    const missing = GAUGE_FULL - gaugeLevelAt(habit, now);
    return Math.max(1, Math.ceil(missing / Math.max(1, habit.gaugeFillPercent)));
  }

  if (habit.mode === 'interval') return 1;

  return Math.max(1, habit.targetPerPeriod - context.doneThisPeriod);
}
