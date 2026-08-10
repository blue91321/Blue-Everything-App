/**
 * Vocabulary shared by the server, the PWA, and the Windows agent.
 *
 * These three talk only over HTTP, so this package is the single place where
 * their understanding of a task, a nudge, or an attention state can drift.
 * Keep it free of runtime dependencies beyond zod.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Attention                                                           */
/* ------------------------------------------------------------------ */

export const attentionStates = ['free', 'in-game', 'focused', 'away'] as const;
export const attentionStateSchema = z.enum(attentionStates);
export type AttentionState = z.infer<typeof attentionStateSchema>;

export const stoppingQualities = ['decent', 'prime'] as const;
export const stoppingQualitySchema = z.enum(stoppingQualities);
export type StoppingQuality = z.infer<typeof stoppingQualitySchema>;

/**
 * How good a moment a nudge insists on before it will interrupt.
 * `any` fires during ordinary desktop use; `prime` waits for a match to end
 * or for you to come back to the desk.
 */
export const nudgeQualities = ['any', 'decent', 'prime'] as const;
export const nudgeQualitySchema = z.enum(nudgeQualities);
export type NudgeQuality = z.infer<typeof nudgeQualitySchema>;

/** Ordered so a `prime` moment also satisfies anything that asked for less. */
export const qualityRank: Record<NudgeQuality, number> = { any: 0, decent: 1, prime: 2 };

export const attentionReportSchema = z.object({
  at: z.number().int().optional(),
  state: attentionStateSchema,
  reason: z.string().max(300),
  exe: z.string().max(260).nullish(),
  title: z.string().max(500).nullish(),
  idleMs: z.number().int().nonnegative().default(0),
  liveGames: z.array(z.string().max(260)).default([]),
  /** Windows' own Do Not Disturb / quiet time is switched on right now. */
  windowsDnd: z.boolean().default(false),
  /** Something has played sound recently — a video, a stream, a call. */
  audioPlaying: z.boolean().default(false),
  /** Present only on the poll where a transition actually happened. */
  stoppingPoint: z
    .object({ quality: stoppingQualitySchema, reason: z.string().max(300) })
    .nullish(),
});
export type AttentionReport = z.infer<typeof attentionReportSchema>;

/* ------------------------------------------------------------------ */
/* Tasks & projects                                                    */
/* ------------------------------------------------------------------ */

export const taskStatuses = ['todo', 'doing', 'done', 'dropped'] as const;
export const taskStatusSchema = z.enum(taskStatuses);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  notes: z.string().max(20_000).nullish(),
  projectId: z.string().uuid().nullish(),
  parentId: z.string().uuid().nullish(),
  status: taskStatusSchema.default('todo'),
  /** 0 = none, 3 = urgent. */
  priority: z.number().int().min(0).max(3).default(0),
  dueAt: z.number().int().nullish(),
  /** The date matters but the time of day doesn't. `dueAt` holds end of day. */
  dueIsAllDay: z.boolean().default(false),
  /** May this reach the phone? Null follows the default — see `resolvePush`. */
  pushToPhone: z.boolean().nullish(),
  scheduledAt: z.number().int().nullish(),
  estimateMinutes: z.number().int().positive().nullish(),
});

/** Local end of day, which is the instant an all-day task is due by. */
export function endOfDayFor(at: number): number {
  const day = new Date(at);
  day.setHours(23, 59, 59, 999);
  return day.getTime();
}
export type CreateTask = z.infer<typeof createTaskSchema>;
export const updateTaskSchema = createTaskSchema.partial();

export const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().max(20).nullish(),
  archived: z.boolean().default(false),
});
export const updateProjectSchema = createProjectSchema.partial();

/* ------------------------------------------------------------------ */
/* Habits                                                              */
/* ------------------------------------------------------------------ */

export const cadences = ['daily', 'weekly'] as const;
export const cadenceSchema = z.enum(cadences);
export type Cadence = z.infer<typeof cadenceSchema>;

export const createHabitSchema = z.object({
  name: z.string().min(1).max(200),
  notes: z.string().max(20_000).nullish(),
  cadence: cadenceSchema.default('daily'),
  targetPerPeriod: z.number().int().positive().default(1),
  active: z.boolean().default(true),
  sortOrder: z.number().int().optional(),
  /** Nag every N minutes until the target is met; null to never interrupt. */
  reminderEveryMinutes: z.number().int().min(5).max(24 * 60).nullish(),
  /**
   * Minutes since local midnight before reminders may start. Null means as
   * soon as the period begins.
   */
  reminderStartMinute: z.number().int().min(0).max(24 * 60 - 1).nullish(),
  /** May this reach the phone? Null follows the default — see `resolvePush`. */
  pushToPhone: z.boolean().nullish(),
  /**
   * Things you might say to tick this off — "i drank water", "had a glass".
   * Empty means the habit can't be reached by voice at all, which is the
   * default: a habit nobody has written a phrase for should never win a match.
   */
  voicePhrases: z.array(z.string().min(1).max(120)).max(20).default([]),
});
export const updateHabitSchema = createHabitSchema.partial();

/** Whole-list reorder: ids in the order they should appear. */
export const reorderSchema = z.object({ ids: z.array(z.string().uuid()).max(500) });

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
export const wakeWordSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z]+(?: [a-z]+)*$/i, 'letters and single spaces only — it is matched against spoken words');

export const DEFAULT_WAKE_WORD = 'hey everything';

/**
 * Words a speech recogniser drops constantly and that carry no identity.
 *
 * "hey" is short, unstressed and usually run into the next word, so Vosk hears
 * "jarvis" far more often than it hears "hey jarvis". Requiring the whole
 * phrase meant the wake word failing on utterances where the distinctive part
 * was recognised perfectly.
 */
const WAKE_PREFIXES = new Set(['hey', 'ok', 'okay', 'hi', 'hello', 'yo', 'hay', 'a', 'uh', 'um']);

/**
 * The part of the wake word that actually has to be heard.
 *
 * Leading attention words are optional; whatever follows them is the name and
 * is required. This is not a loosening of the gate — the wake recogniser runs a
 * grammar containing only the wake word and `[unk]`, so the sole thing it can
 * emit besides "nothing" is wake-word words. What it changes is that a
 * half-heard "…jarvis" counts, which is the common case.
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

/**
 * Cosine similarity a speaker embedding must reach to count as you.
 *
 * Tuned for the failure that matters: a false accept logs a habit you didn't do,
 * which is quietly wrong data. A false reject means saying it again, which is
 * merely annoying. So this sits deliberately on the strict side of the equal-
 * error rate.
 */
export const DEFAULT_SPEAKER_THRESHOLD = 0.55;

/** How long after the wake word the command must arrive before we give up. */
export const VOICE_COMMAND_TIMEOUT_MS = 6000;

/**
 * How long it keeps listening *after* answering, with no wake word needed.
 *
 * Separate from the command timeout above, which is how long it waits for the
 * first thing after the wake word. This one is the conversation: having just
 * replied, how long is it still your turn.
 *
 * The right value is personal and the trade is real — longer means saying two
 * things in a row without repeating the wake word, but also a microphone acting
 * on stray speech for longer after every command. So it is a setting rather
 * than a number someone picked once.
 */
export const DEFAULT_VOICE_FOLLOW_UP_SECONDS = 6;

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

/**
 * Built-in avatars are emoji, not image files.
 *
 * Windows draws them in colour from Segoe UI Emoji, so a gallery costs no
 * checked-in binaries — the same reasoning that has the app icons generated at
 * build time rather than committed.
 */
export const AVATAR_CHOICES = ['🤖', '🎧', '🐈', '🦉', '👾', '🫡', '🧠', '⭐'] as const;
export const MAX_VOICE_FOLLOW_UP_SECONDS = 30;

export const voiceCommandSchema = z.object({
  /** What was heard after the wake word. Never the raw audio — see voice.ts. */
  text: z.string().min(1).max(500),
  /** Cosine similarity against the enrolled voiceprint, if one exists. */
  speakerScore: z.number().min(-1).max(1).nullish(),
  at: z.number().int().optional(),
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
   * Phrase words the speech model has no pronunciation for.
   *
   * These are silently dropped from the grammar, so a phrase containing one can
   * never match. Reported so the screen can say which, rather than leaving a
   * command that reads perfectly and never works.
   */
  unknownWords: z.array(z.string().max(60)).max(50).default([]),
  /** How many usable enrolment samples are in hand, while enrolling. */
  enrolSamples: z.number().int().min(0).max(200).optional(),
  /** How well the last sample agreed with the ones before it, 0-1. */
  enrolAgreement: z.number().min(-1).max(1).nullish(),
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

function stem(word: string): string {
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
    return suffix === 'ing' || suffix === 'ed' ? base : dropSilentE(base);
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
    forms.add(base.endsWith('e') ? `${base}d` : `${base}ed`);
    forms.add(base.endsWith('e') ? `${base.slice(0, -1)}ing` : `${base}ing`);
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
export const voiceCommandKinds = ['habit', 'note', 'url', 'hotkey', 'media', 'pause', 'cancel'] as const;
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
] as const;

export interface Hotkey {
  modifiers: string[];
  key: string;
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
  });

export const updateVoiceCommandSchema = createVoiceCommandSchema;

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

/* ------------------------------------------------------------------ */
/* Time tracking                                                       */
/* ------------------------------------------------------------------ */

export const timeSources = ['manual', 'auto'] as const;
export const timeSourceSchema = z.enum(timeSources);

export const startTimeEntrySchema = z.object({
  taskId: z.string().uuid().nullish(),
  label: z.string().max(300).nullish(),
  source: timeSourceSchema.default('manual'),
  startedAt: z.number().int().optional(),
});

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

export const createNoteSchema = z.object({
  title: z.string().max(300).nullish(),
  body: z.string().max(200_000).default(''),
  pinned: z.boolean().default(false),
});
export const updateNoteSchema = createNoteSchema.partial();

/* ------------------------------------------------------------------ */
/* Nudges                                                              */
/* ------------------------------------------------------------------ */

export const nudgeStates = ['pending', 'delivered', 'acknowledged', 'snoozed', 'dismissed', 'expired'] as const;
export const nudgeStateSchema = z.enum(nudgeStates);
export type NudgeState = z.infer<typeof nudgeStateSchema>;

export const createNudgeSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(2000).nullish(),
  taskId: z.string().uuid().nullish(),
  habitId: z.string().uuid().nullish(),
  /** Don't even consider delivering before this. Defaults to now. */
  earliestAt: z.number().int().optional(),
  /**
   * Past this, the nudge stops being polite and interrupts anyway — except
   * when you are away from the machine, where a toast would just be missed.
   */
  deadlineAt: z.number().int().nullish(),
  /** Drop it unfired after this. Recurring reminders set it; one-offs don't. */
  expiresAt: z.number().int().nullish(),
  minQuality: nudgeQualitySchema.default('decent'),
});
export type CreateNudge = z.infer<typeof createNudgeSchema>;

export const snoozeNudgeSchema = z.object({ minutes: z.number().int().positive().max(60 * 24) });

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const minuteOfDay = z.number().int().min(0).max(24 * 60 - 1);

/**
 * How the app looks.
 *
 * `dark` is the default rather than `system`: this thing is looked at in a dim
 * room next to a game, and following Windows would mean a white screen every
 * time the OS decided it was daytime. `system` is offered for anyone who wants
 * it, but it is a choice rather than the assumption.
 */
export const APP_THEMES = ['dark', 'light', 'system'] as const;
export type AppTheme = (typeof APP_THEMES)[number];
export const DEFAULT_THEME: AppTheme = 'dark';

/**
 * The accent, by name rather than by hex.
 *
 * A free colour picker would need `--accent-text` derived from luminance at
 * runtime to keep labels legible on top of it, and would happily let you pick
 * something unreadable. A short list pairs each accent with a foreground that
 * has been looked at, in both themes, which is the part that actually matters.
 *
 * The names live here because the server validates them; the hex values live
 * in the PWA's stylesheet, because CSS is a better place to keep colours than
 * a TypeScript constant the browser then has to apply by hand.
 */
export const ACCENT_COLORS = ['blue', 'amber', 'green', 'teal', 'purple', 'pink', 'red', 'grey'] as const;
export type AccentColor = (typeof ACCENT_COLORS)[number];
export const DEFAULT_ACCENT: AccentColor = 'blue';

/**
 * The accent as the *icon renderer* needs it, since a PNG cannot read a CSS
 * variable.
 *
 * These are the dark-theme values, and app icons use them whatever the theme
 * is: a home-screen icon sits on the OS's wallpaper, not on our background, and
 * has no idea whether the app inside is currently light.
 *
 * **This table and the `[data-accent=…]` rules in `styles.css` must agree.**
 * They cannot be shared — the PWA deliberately does not import this package,
 * and CSS cannot import TypeScript — so `make-icons.mjs` reads both and fails
 * the build if they drift. A logo that is a different blue from the app it
 * belongs to is exactly the sort of thing nobody notices for months.
 */
export const ACCENT_HEX: Record<AccentColor, string> = {
  blue: '#4c8dff',
  amber: '#ffb454',
  green: '#5fd18c',
  teal: '#3fc9c2',
  purple: '#a78bfa',
  pink: '#f472b6',
  red: '#ff7a7a',
  grey: '#9aa3b8',
};

/** The background every generated icon is drawn on. Matches the dark `--bg`. */
export const ICON_BACKGROUND = '#14161c';

/**
 * The mark itself.
 *
 * `pause` is the original and still the default — the app's whole idea is
 * holding something back until the moment is right, and the glyph says so.
 * The rest are there because it is your app and you should be able to make it
 * look like your.
 *
 * `image` means "use the file that was uploaded". It is a shape like the others
 * rather than a separate boolean, because the two are genuinely exclusive and a
 * `useCustomLogo` flag alongside a shape would allow the nonsense state of a
 * custom logo *and* a triangle.
 */
export const LOGO_SHAPES = ['pause', 'circle', 'triangle', 'square', 'image'] as const;
export type LogoShape = (typeof LOGO_SHAPES)[number];
export const DEFAULT_LOGO_SHAPE: LogoShape = 'pause';

export const LOGO_SHAPE_LABELS: Record<LogoShape, string> = {
  pause: 'Pause',
  circle: 'Circle',
  triangle: 'Triangle',
  square: 'Square',
  image: 'My own picture',
};

export const updateSettingsSchema = z.object({
  /** Dark unless asked otherwise — see APP_THEMES. */
  theme: z.enum(APP_THEMES).optional(),
  accentColor: z.enum(ACCENT_COLORS).optional(),
  /**
   * Setting this to `image` with nothing uploaded is refused by the route
   * rather than the schema — the schema cannot see the filesystem, and a logo
   * silently falling back to a pause glyph would look like the upload failed.
   */
  logoShape: z.enum(LOGO_SHAPES).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietStartMinute: minuteOfDay.optional(),
  quietEndMinute: minuteOfDay.optional(),
  followWindowsDnd: z.boolean().optional(),
  /** Absolute time; null clears the manual pause. */
  dndUntil: z.number().int().nullish(),
  remindersEnabled: z.boolean().optional(),
  /** A short tone with each popup. On by default; see the schema. */
  soundEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  /** What a task or habit that hasn't chosen gets. Not the master switch. */
  pushDefault: z.boolean().optional(),
  voiceEnabled: z.boolean().optional(),
  wakeWord: wakeWordSchema.optional(),
  requireKnownSpeaker: z.boolean().optional(),
  speakerThreshold: z.number().min(0).max(1).optional(),
  /**
   * Stored as the device *name*, not its index. Windows renumbers inputs when
   * something is plugged in or removed, so an index saved today can silently
   * mean a different microphone tomorrow. Null follows the Windows default.
   */
  voiceInputDevice: z.string().max(200).nullish(),
  /** Seconds to keep listening after answering. 0 switches follow-ups off. */
  voiceFollowUpSeconds: z.number().int().min(0).max(MAX_VOICE_FOLLOW_UP_SECONDS).optional(),
  /** Seconds to keep listening after a miss. 0 means don't wait for a retry. */
  voiceRetrySeconds: z.number().int().min(0).max(MAX_VOICE_FOLLOW_UP_SECONDS).optional(),
  overlayPlacement: overlayPlacementSchema.optional(),
  /** Device name of the screen to anchor to; null follows the mouse. */
  overlayScreen: z.string().max(200).nullish(),
  /** An emoji, `file` for the uploaded one, or empty for no avatar. */
  overlayAvatar: z.string().max(80).optional(),
});

/**
 * Is `at` inside the quiet window?
 *
 * Start > end wraps past midnight, which is the normal case for sleep. Whether
 * quiet hours apply at all is a separate flag — don't infer it from the times.
 */
export function isQuietHour(at: Date, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return false;
  const minute = at.getHours() * 60 + at.getMinutes();
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/** Why reminders are currently silent, or null if they aren't. */
export type QuietReason = 'reminders-off' | 'paused' | 'quiet-hours' | 'windows-dnd';

export interface QuietInputs {
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  followWindowsDnd: boolean;
  dndUntil: number | null;
  remindersEnabled: boolean;
  windowsDnd?: boolean;
}

/**
 * One place that decides whether anything is allowed to interrupt, so the
 * server, the phone and the settings screen can never disagree about why it's
 * gone quiet.
 */
export function quietReason(at: Date, input: QuietInputs): QuietReason | null {
  if (!input.remindersEnabled) return 'reminders-off';
  if (input.dndUntil && input.dndUntil > at.getTime()) return 'paused';
  if (input.quietHoursEnabled && isQuietHour(at, input.quietStartMinute, input.quietEndMinute)) return 'quiet-hours';
  if (input.followWindowsDnd && input.windowsDnd) return 'windows-dnd';
  return null;
}

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

export const deviceKinds = ['windows-agent', 'phone', 'browser', 'extension'] as const;
export const deviceKindSchema = z.enum(deviceKinds);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

export const registerDeviceSchema = z.object({
  name: z.string().min(1).max(120),
  kind: deviceKindSchema,
});

/* ------------------------------------------------------------------ */
/* Away from the PC                                                    */
/* ------------------------------------------------------------------ */

/** No keyboard or mouse for this long before the phone is even considered. */
export const AWAY_FROM_PC_IDLE_MS = 15 * 60_000;

/**
 * Has you actually left, as opposed to sitting still?
 *
 * Idle time alone can't tell the difference: watching a two-hour film looks
 * exactly like an empty chair to the keyboard. Sound is what separates them, so
 * a push only goes out when the machine has been untouched *and* silent.
 *
 * Deliberately conservative — a missed phone nudge is a small loss, while a
 * phone buzzing in your pocket while you're sat watching something is exactly the
 * badly-timed interruption this whole app exists to prevent.
 */
export function isAwayFromPc(input: { idleMs: number; audioPlaying?: boolean }): boolean {
  return input.idleMs >= AWAY_FROM_PC_IDLE_MS && !input.audioPlaying;
}

/**
 * Does this particular thing get to buzz your pocket?
 *
 * Three states collapsed to two, in one place so the sweep, the API and the
 * settings screen cannot disagree about what an unset value means.
 *
 * The point of the null is that it keeps *tracking* the default. Stamping every
 * task with the default at creation would look identical on the day it was
 * made and diverge silently forever after: changing your mind about the default
 * would leave everything already on the list answering the old question, and
 * nothing on screen to say why.
 *
 * Deliberately not consulted for whether push happens *at all* — `pushEnabled`
 * is that switch, and it outranks this. A task saying "yes, push me" on an
 * install with the phone switched off means nothing, and should.
 */
export function resolvePush(own: boolean | number | null | undefined, fallback: boolean): boolean {
  if (own === null || own === undefined) return fallback;
  return Boolean(own);
}

/* ------------------------------------------------------------------ */
/* Vault                                                               */
/* ------------------------------------------------------------------ */

/**
 * A master password this short is not worth the Argon2id cost protecting it.
 * Long beats complex — the strength comes from length, so the UI should ask for
 * a passphrase rather than punctuation.
 */
export const MIN_MASTER_PASSWORD = 12;

export const vaultSetupSchema = z.object({
  masterPassword: z.string().min(MIN_MASTER_PASSWORD).max(1024),
  /** Off only if you explicitly accepts that a forgotten password is final. */
  withRecovery: z.boolean().default(true),
});

export const vaultUnlockSchema = z.object({
  masterPassword: z.string().min(1).max(1024),
});

export const vaultItemSchema = z.object({
  title: z.string().min(1).max(300),
  username: z.string().max(300).default(''),
  password: z.string().max(2000).default(''),
  /** Used to match a login form to an entry; encrypted like everything else. */
  url: z.string().max(2000).default(''),
  notes: z.string().max(20_000).default(''),
  /** TOTP secret, if the site has one. */
  totp: z.string().max(300).default(''),
});
export type VaultItemInput = z.infer<typeof vaultItemSchema>;
export const vaultItemUpdateSchema = vaultItemSchema.partial();

export const vaultRecoverSchema = z.object({
  shareA: z.string().min(1).max(200),
  shareB: z.string().min(1).max(200),
  newMasterPassword: z.string().min(MIN_MASTER_PASSWORD).max(1024),
});

export const vaultImportSchema = z.object({
  /** The raw export. Held in memory only; never written down or logged. */
  csv: z.string().min(1).max(20 * 1024 * 1024),
  /** Preview first; nothing is written until this is true. */
  commit: z.boolean().default(false),
  /** Bring in logins that already exist for the same site and username. */
  includeDuplicates: z.boolean().default(false),
});

/**
 * Deleting the vault takes the master password, not merely an unlocked
 * session. It is irreversible, so it should cost a deliberate act rather than
 * a stray click on an already-open screen.
 */
export const vaultDestroySchema = z.object({
  masterPassword: z.string().min(1).max(1024),
});

export const vaultChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(MIN_MASTER_PASSWORD).max(1024),
});

/**
 * Does a stored entry's URL match the page a login form is on?
 *
 * Compares registrable-ish host suffixes, so an entry for `example.com` fills
 * on `login.example.com`. Deliberately does *not* match the other way round: an
 * entry for `login.example.com` should not fill on `example.com.evil.test`.
 */
export function urlMatchesEntry(entryUrl: string, pageUrl: string): boolean {
  const host = (value: string): string | null => {
    try {
      return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  };

  const entryHost = host(entryUrl);
  const pageHost = host(pageUrl);
  if (!entryHost || !pageHost) return false;
  if (entryHost === pageHost) return true;

  // Suffix match must land on a dot boundary, or "evil-example.com" would match
  // "example.com".
  return pageHost.endsWith(`.${entryHost}`);
}

/** Shape the API returns for a nudge the client should show right now. */
export interface DeliverableNudge {
  id: string;
  title: string;
  body: string | null;
  taskId: string | null;
  habitId: string | null;
  minQuality: NudgeQuality;
  /** True when this fired because its deadline passed, not because the moment was good. */
  escalated: boolean;
}
