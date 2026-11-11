/**
 * Blueprints: boxes and wires that make the app do things, run here.
 *
 * A blueprint starts from an event (a match ending, a habit ticked, a time of
 * day), asks questions (am I in a game, is it the weekend) and does things
 * (nudge me, add a task). The boxes are `web/catalogue.ts` and the walk is
 * `web/engine.ts`; this file listens for the events, does the asking and the
 * doing, and keeps a log of every run.
 *
 * ### What it listens to costs nothing when nobody is listening
 *
 * Events come from core's `happenings`, which says a thing once when it
 * happens: no polling, and the attention heartbeat only says anything when the
 * state actually changed. The one timer is for "at a time of day": a single
 * timeout to the next one due, re-armed after each change, the shape Trips'
 * flight watching takes, and nothing at all with no such box. *Every so often*
 * shares it.
 *
 * ### A blueprint cannot run away with itself
 *
 * "When a habit is ticked, tick a habit" would go round for ever. Two guards:
 * a run started by another run's action is counted as one deeper, and past
 * three deep it is not started; and a blueprint that runs more than twenty
 * times in ten minutes switches itself off and says why on its card.
 *
 * ### Nudges go through the queue
 *
 * "Nudge me" writes an ordinary nudge, so it waits for a good moment, respects
 * quiet hours and goes to the phone exactly as every other reminder does. A
 * blueprint is a way of deciding *what* to say, never of getting round *when*.
 *
 * ### Keys are the agent's
 *
 * This server cannot hear a key or press one, and must not try: it is meant to
 * move to Docker, where there is no keyboard. So the blueprints half of the
 * agent long-polls `/api/blueprints/agent` for the hotkeys to listen for and
 * the keys to press, presses them, and says so on its next ask; a hotkey it
 * hears comes back as `/api/blueprints/hotkey`. "Press keys" waits for the
 * agent to say it pressed them, so a run never claims a press that did not
 * happen.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  changes,
  config,
  currentQuietReason,
  db,
  games,
  getSettings,
  habitProgress,
  happenings,
  isGuest,
  moduleIsRunning,
  notes,
  provideSpokenCommands,
  recordHabitDone,
  saveNote,
  spokenChanged,
  tasks,
  type ChangeScope,
  type Happenings,
  type SpokenCommand,
  type SpokenHeard,
} from '@everything/server/module-api';
import { isOpenableUrl } from '@everything/shared';
import { isLaunchUrl } from '@everything/shared/games';
import { noteKey } from '@everything/shared/notes';
import { TONES, isToneName } from '@everything/shared/sound';
import { designLength, designOf, localSoundPath, type SoundLine } from '../web/sound-design.js';
import { dayMatches, fill, HELD_BECAUSE, isBetween, MEDIA_OPTIONS, phrasesOf, specOf, type NodeSpec } from '../web/catalogue.js';
import { asNumber, formatNumber, MathError } from '../web/maths.js';
import { convertVoiceCommands } from './convert-voice.js';
import { cleanGraph, RunStopped, walk, type Blueprint, type Effects, type GraphNode, type Inputs, type Step } from '../web/engine.js';
import { normalKeys, parseTimeline, playable, timelineLength, type TimelineBar } from '../web/keys.js';
import {
  folderName,
  readBlueprints,
  readFolders,
  readRuns,
  readVariables,
  StoreError,
  variableName,
  writeBlueprints,
  writeRuns,
  writeVariables,
  type Folder,
  type Run,
} from './store.js';
import { gameName, newId, staysFor, TEMPLATES } from './rules.js';
import { forWait } from './fine-timer.js';
import { lastDue, nextDue } from '../web/schedule.js';

const MINUTE = 60_000;
const RUN_WINDOW_MS = 10 * MINUTE;
const RUNS_PER_WINDOW = 20;
const MAX_DEPTH = 3;
/** A time-of-day box more than this late (the PC asleep through it) is skipped. */
const LATE_MS = 10 * MINUTE;

/*
 * Not one of core's scopes, deliberately: core must not name a package. A
 * scope nobody lists reaches only the readers that ask for it, which is this
 * screen, so a run does not refetch every other screen on every device.
 */
const SCOPE = 'blueprints' as ChangeScope;

/* ---- What is known ------------------------------------------------- */

let list: Blueprint[] = [];
let folders: Folder[] = [];
let loadError: string | null = null;
let runs: Run[] = [];

function load(): void {
  try {
    list = readBlueprints();
    folders = readFolders();
    loadError = null;
  } catch (error) {
    list = [];
    folders = [];
    loadError = error instanceof StoreError ? error.message : String(error);
  }
  runs = readRuns().map((r) => (r.waiting ? { ...r, waiting: false, steps: [...r.steps, restartStep(r)] } : r));
  variables = readVariables();
}

function restartStep(run: Run): Step {
  return { node: run.steps.at(-1)?.node ?? run.from, result: 'stopped', said: 'The app restarted while it was still going, so this run stopped there.' };
}

function save(): void {
  if (loadError) throw new StoreError(loadError);
  writeBlueprints(list, folders);
}

/** The attention state as last said, for "Am I…". Null until the PC has reported. */
let attention: { state: string; away: boolean; game: string | null; games: string[] } | null = null;

/**
 * "Flip a switch" and "Is a switch on?", by name, shared by every blueprint so
 * one hotkey can turn another's behaviour on and off. In memory, so they are
 * all off when the app starts, as a script's variables are when it is run.
 */
const switches = new Map<string, boolean>();
const switchName = (node: GraphNode) => String(node.fields.name ?? '').trim().toLowerCase().slice(0, 60);

/**
 * "Set a variable", by name, shared by every blueprint and read anywhere as a
 * `{word}`. Unlike the switches these are kept on disk, written a second after
 * the last change like the run log, since a running total that empties itself
 * whenever the app restarts is not much of a total.
 */
let variables = new Map<string, number | string>();
let variablesTimer: NodeJS.Timeout | null = null;

/**
 * Where a variable starts before any "Set a variable" has changed it: the
 * "Starts at" of a Variable box with its name, this blueprint's own first,
 * then any other's. Undefined when no box names it.
 */
function startOf(name: string, prefer?: string): number | undefined {
  const own = list.find((b) => b.id === prefer);
  for (const bp of own ? [own, ...list.filter((b) => b !== own)] : list) {
    for (const n of bp.graph.nodes) {
      if (n.type !== 'variable' || variableName(n.fields.name) !== name) continue;
      const start = Number(n.fields.start);
      if (Number.isFinite(start)) return start;
    }
  }
  return undefined;
}

/** Every named variable's start, for filling in `{words}`; this blueprint's own win. */
function starts(prefer?: string): Map<string, number> {
  const out = new Map<string, number>();
  const own = list.find((b) => b.id === prefer);
  for (const bp of own ? [...list.filter((b) => b !== own), own] : list) {
    for (const n of bp.graph.nodes) {
      const name = n.type === 'variable' ? variableName(n.fields.name) : '';
      const start = Number(n.fields.start);
      if (name && Number.isFinite(start)) out.set(name, start);
    }
  }
  return out;
}

function setVariable(name: string, value: number | string | null): void {
  if (value === null) variables.delete(name);
  else variables.set(name, value);
  if (variablesTimer) return;
  variablesTimer = setTimeout(flushVariables, 1000);
  variablesTimer.unref?.();
}

function flushVariables(): void {
  if (variablesTimer) clearTimeout(variablesTimer);
  variablesTimer = null;
  try {
    writeVariables(variables);
  } catch (error) {
    console.warn('[blueprints] could not write the variables:', (error as Error).message);
  }
  changes.emitChange(SCOPE);
}

/** A variable as a word in a sentence: 12, not 12.000000001. */
const asWord = (value: number | string) => (typeof value === 'number' ? formatNumber(value) : value);

/** "Every so many times": how far each box has counted, and to what. Also in memory. */
const counters = new Map<string, { count: number; target: number; from: 'field' | 'wire'; times: number }>();

/* ---- Running -------------------------------------------------------- */

/** Which run, how deep: read when an action's own write announces something. */
const context = new AsyncLocalStorage<{ depth: number; blueprint: string }>();

/**
 * Real runs still going, so a hotkey pressed again, Stop, or changing or
 * removing the blueprint can end them. Most last milliseconds; one inside a
 * Wait or a Repeat can last hours.
 */
const active = new Map<string, { blueprint: string; from: string; abort: AbortController }>();

function clock(at = new Date()): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** Why a run was stopped, as its last step will say it. */
function stopReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : 'Stopped: the blueprint was changed or the app closed.';
}

/**
 * A wait, on time to the millisecond: see `fine-timer.ts` for why Windows
 * needed asking, and for the close check at the end that stands in where it
 * cannot be asked.
 */
/*
 * Notifications waiting for their moment, in memory: "as soon as I am free"
 * or "at the next good break". Shown from the attention happening, which says
 * when the state moves and when a stopping point arrives, and dropped once
 * they have waited as long as their box allows. A restart forgets them, as it
 * ends a Wait.
 */
interface Notice {
  title: string;
  body: string;
  color: string;
  sound: string;
  volume: number;
  when: 'now' | 'soon' | 'good';
  /** How long the popup stays up once shown, in seconds; 0 until it is closed. */
  seconds: number;
  giveUpAt: number;
}
/**
 * How long one waits for its moment. The box no longer says (its time is how
 * long it stays up), so a day: a "next good break" from yesterday is not one.
 */
const NOTICE_WAITS_MS = 24 * 60 * MINUTE;
const notices: Notice[] = [];
const WAITS_FOR = { now: 'now', soon: 'once you are free', good: 'at the next good break' } as const;

/**
 * Whether now is a moment for one: *as soon as I am free* is any time you are
 * at the PC and not in a game or focused; *at the next good break* is a
 * stopping point, or that same freedom with no game open at all.
 */
function readyFor(when: Notice['when'], stopping = false): boolean {
  if (when === 'now') return true;
  if (!attention || attention.away) return false;
  if (when === 'good') return stopping || (attention.state === 'free' && attention.games.length === 0);
  return attention.state === 'free' || stopping;
}

/** The app's popup, now, silent unless the notification has a sound. */
async function showNotice(n: Notice): Promise<void> {
  await agentDo(
    { do: 'popup', title: n.title, body: n.body, color: n.color, seconds: n.seconds, sound: n.sound, volume: n.volume },
    'show the notification'
  );
}

/** Show whatever has been waiting for a moment like this one, and let go of what has waited too long. */
function deliverNotices(stopping: boolean): void {
  const now = Date.now();
  for (let i = notices.length - 1; i >= 0; i--) {
    const n = notices[i]!;
    if (n.giveUpAt <= now) notices.splice(i, 1);
    else if (readyFor(n.when, stopping)) {
      notices.splice(i, 1);
      void showNotice(n).catch(() => undefined);
    }
  }
}

/** A drawn sound in a few words, for the run log: a beep, a sweep, or so many lines. */
function soundWords(lines: SoundLine[]): string {
  if (lines.length === 0) return 'a drawn sound with no lines';
  const only = lines.length === 1 ? lines[0]!.points : null;
  const first = only?.[0];
  const last = only?.[only.length - 1];
  if (only && first && last && only.length === 2 && first.hz === last.hz) return `a ${formatNumber(first.hz)} Hz beep`;
  if (only && first && last && only.length === 2) return `a sweep from ${formatNumber(first.hz)} to ${formatNumber(last.hz)} Hz`;
  return `a drawn sound of ${lines.length === 1 ? 'one line' : `${lines.length} lines`}`;
}

/** How long one of the app's tones lasts, in ms. */
function toneLength(tone: string): number {
  return isToneName(tone) ? TONES[tone].reduce((n, b) => n + b.ms, 0) : 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new RunStopped(stopReason(signal)));
    const due = performance.now() + ms;
    const { closeMs, release } = forWait(ms);
    let over = false;
    let timer: NodeJS.Timeout | null = null;
    // Taken off again when the wait ends: a repeat "every second, until
    // stopped" waits on the one signal thousands of times.
    const onAbort = () => {
      over = true;
      if (timer) clearTimeout(timer);
      release();
      reject(new RunStopped(stopReason(signal)));
    };
    const check = () => {
      if (over) return;
      if (performance.now() < due) {
        // Early by a whisker, or in the close part at the end: look again after everything else.
        setImmediate(check);
        return;
      }
      over = true;
      signal.removeEventListener('abort', onAbort);
      release();
      resolve();
    };
    const coarse = ms - closeMs;
    if (coarse > 0) {
      timer = setTimeout(check, coarse);
      timer.unref?.();
    } else setImmediate(check);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Stop every run of a blueprint (or only those from one box), saying why. */
function stopRuns(blueprint: string, reason: string, from?: string): number {
  let stopped = 0;
  for (const [, run] of active) {
    if (run.blueprint !== blueprint || (from && run.from !== from) || run.abort.signal.aborted) continue;
    run.abort.abort(reason);
    stopped += 1;
  }
  return stopped;
}

/* ---- The agent: hotkeys heard, keys pressed ------------------------- */

/** The agent asked within this long ago, so a press has somewhere to go. */
const AGENT_FRESH_MS = 45_000;
const PRESS_TIMEOUT_MS = 5000;
/**
 * A hotkey heard this soon after a blueprint pressed those very keys is the
 * blueprint's own press coming back, not you. Without this, a blueprint that
 * presses its own hotkey would start itself for ever.
 */
const ECHO_MS = 500;

let agentSeenAt = 0;
let agentProblems: string[] = [];
/** Long polls parked until there is something to say. */
const parked = new Set<() => void>();
/**
 * Something only the PC can do, carried out by the agent half. A launch
 * arrives resolved from the games list (a path or a `steam://` address), never
 * as whatever the box said, so what one can start is bounded by what the PC
 * has run by itself.
 */
export type AgentTask =
  | { do: 'keys'; keys: string; hold: number }
  | { do: 'url'; url: string }
  | { do: 'media'; action: string }
  | { do: 'launch'; name: string; path?: string; url?: string }
  /** Played by the agent, so the gaps between presses are the PC's own timing. */
  | { do: 'timeline'; bars: TimelineBar[]; totalMs: number }
  /** Check in now: a nudge was just queued, and shows on the agent's next report. */
  | { do: 'check' }
  /** Is this key or button down right now? Answered with true or false. */
  | { do: 'held'; keys: string }
  /** The app's popup, now, in its own colour (empty for the app's accent). */
  | { do: 'popup'; title: string; body: string; color: string; seconds: number; sound?: string; volume?: number }
  /** One of the app's tones, by name, at a volume from 0 to 100. */
  | { do: 'tone'; tone: string; volume?: number }
  /** A sound made by `sound-design.ts` from a box's fields, which the agent draws the same way. */
  | { do: 'sound'; fields: Record<string, string | number> }
  /** A .wav or .mp3 on the PC, by a path `localSoundPath` allows. Answered with how long it lasts, in ms. */
  | { do: 'sound-file'; path: string; volume?: number }
  /**
   * A popup with a box to type in. Answered on `/api/blueprints/answer`, not
   * on the next poll, which may be parked for twenty seconds.
   */
  | { do: 'ask'; ask: string; title: string; body: string; placeholder: string; color: string; seconds: number }
  /** Take a question away: the run that asked it was stopped. */
  | { do: 'unask'; ask: string };

interface Job {
  id: string;
  task: AgentTask;
  sent: boolean;
  done: (error?: string, value?: unknown) => void;
}
const jobs: Job[] = [];
const lastPressed = new Map<string, number>();

/**
 * Whether a hotkey box is listening now: switched on, and if it names a game,
 * that game in front. So a hotkey for Warframe costs nothing at all, not even
 * a registration, until Warframe is being played.
 */
function listening(node: GraphNode): boolean {
  const game = String(node.fields.game ?? '');
  if (!game) return node.fields.listen !== 'watch';
  return gameOpen(game);
}

/** Whether a game is open: running, in front or not. The list is the heartbeat's. */
function gameOpen(exe: string): boolean {
  const want = exe.toLowerCase();
  return !!attention && (attention.games.includes(want) || (attention.state === 'in-game' && attention.game?.toLowerCase() === want));
}

/* ---- Can it run? ----------------------------------------------------- */

/**
 * Whether a blueprint can start, which is not the same as switched on
 * (2026-11-03). One whose only "When" is a phrase, with voice off, cannot run
 * at all, and reading "on" in green beside it was a claim it could; one that
 * waits for Warframe cannot run until Warframe is open. So each "When" box
 * says whether it could fire now (`live`), could once something it waits for
 * happens (`idle`: the game opening, voice coming off pause, the agent on the
 * PC), or cannot as things are set (`dead`: voice switched off, no keys,
 * no phrases). The blueprint is **on** if any can fire, **idle** if the best
 * is waiting, and **disabled** if none can.
 *
 * Nothing that cannot fire is listened for already: a disabled or idle
 * hotkey is not registered or watched, and a phrase nothing hears costs
 * nothing. This is what the screen says about it.
 */
export type BlueprintState = 'on' | 'idle' | 'disabled' | 'off' | 'stopped';

interface VoiceFacts {
  installed: boolean;
  enabled: boolean;
  paused: boolean;
  /** The listen shortcut works while voice is off. */
  borrowed: boolean;
}

let voiceFacts: VoiceFacts = { installed: false, enabled: false, paused: false, borrowed: false };

async function readVoiceFacts(): Promise<VoiceFacts> {
  const settings = await getSettings();
  const until = settings.voicePausedUntil;
  voiceFacts = {
    installed: moduleIsRunning('voice'),
    enabled: Boolean(settings.voiceEnabled),
    paused: until === -1 || (typeof until === 'number' && until > Date.now()),
    borrowed: Boolean(settings.voiceListenHotkeyWhileOff) && Boolean(settings.voiceListenHotkey),
  };
  return voiceFacts;
}

function triggerState(node: GraphNode, voice: VoiceFacts): { state: 'live' | 'idle' | 'dead'; why: string } {
  switch (node.type) {
    case 'on-voice': {
      if (phrasesOf(node.fields).length === 0) return { state: 'dead', why: '"When I say" has no phrases yet' };
      if (!voice.installed) return { state: 'dead', why: 'Voice is not running' };
      if (!voice.enabled) {
        return voice.borrowed
          ? { state: 'live', why: 'voice is off, so only from its listen shortcut' }
          : { state: 'dead', why: 'voice is switched off' };
      }
      if (voice.paused) return { state: 'idle', why: 'voice is paused' };
      return { state: 'live', why: 'listening for its phrases' };
    }
    case 'on-hotkey': {
      const watching = node.fields.listen === 'watch';
      const keys = String((watching ? node.fields.watch : node.fields.keys) ?? '');
      const game = String(node.fields.game ?? '');
      if (!keys) return { state: 'dead', why: 'the hotkey box has no keys set' };
      if (watching && !game) return { state: 'dead', why: 'a watched key needs a game to watch in' };
      if (agentProblems.some((p) => p.startsWith(`${keys} `))) return { state: 'dead', why: `${keys} is taken by another program` };
      if (!agentAround()) return { state: 'idle', why: 'waiting for the app on the PC' };
      if (game && !gameOpen(game)) return { state: 'idle', why: `waiting for ${gameName(game).replace(/\b\w/g, (c) => c.toUpperCase())} to be open` };
      return { state: 'live', why: game ? `${keys} while it is open` : keys };
    }
    case 'on-stop':
    case 'on-game-start':
    case 'on-away':
    case 'on-back':
      return attention ? { state: 'live', why: 'watching what you are doing' } : { state: 'idle', why: 'waiting for the PC to say what you are doing' };
    default:
      return { state: 'live', why: '' };
  }
}

function statusOf(bp: Blueprint, voice: VoiceFacts): { state: BlueprintState; why: string } {
  if (!bp.enabled) return { state: 'off', why: 'switched off' };
  if (bp.stopped) return { state: 'stopped', why: bp.stopped };
  const events = bp.graph.nodes.filter((n) => specOf(n.type)?.kind === 'event').map((n) => triggerState(n, voice));
  if (events.length === 0) return { state: 'disabled', why: 'it has no "When" box, so nothing starts it' };
  const live = events.find((e) => e.state === 'live');
  if (live) return { state: 'on', why: live.why };
  const idle = events.find((e) => e.state === 'idle');
  if (idle) return { state: 'idle', why: idle.why };
  return { state: 'disabled', why: events[0]!.why };
}

async function statuses(): Promise<Record<string, { state: BlueprintState; why: string }>> {
  const voice = await readVoiceFacts();
  return Object.fromEntries(list.map((bp) => [bp.id, statusOf(bp, voice)]));
}

/** The states, for telling the screen when one moves. Voice from its last reading. */
const statusKey = () => list.map((bp) => `${bp.id}:${statusOf(bp, voiceFacts).state}`).join('|');

function hotkeyNodes(): GraphNode[] {
  const out: GraphNode[] = [];
  for (const bp of list) {
    if (!bp.enabled || bp.stopped) continue;
    for (const node of bp.graph.nodes) if (node.type === 'on-hotkey' && listening(node)) out.push(node);
  }
  return out;
}

/** Every hotkey to register (it takes the keys), once each, in one spelling. */
function hotkeyList(): string[] {
  const out = new Set<string>();
  for (const node of hotkeyNodes()) if (node.fields.listen !== 'watch' && node.fields.keys) out.add(String(node.fields.keys));
  return [...out].sort();
}

/**
 * Every key or button to watch, with the game it is for: the agent checks the
 * game is in front at the moment of the press, as the script's
 * `IsWarframeActive` did, since this list follows the game a heartbeat late.
 */
function watchList(): Array<{ keys: string; game: string }> {
  const out = new Map<string, { keys: string; game: string }>();
  for (const node of hotkeyNodes()) {
    if (node.fields.listen !== 'watch' || !node.fields.watch || !node.fields.game) continue;
    const entry = { keys: String(node.fields.watch), game: String(node.fields.game) };
    out.set(`${entry.keys}@${entry.game}`, entry);
  }
  return [...out.values()].sort((a, b) => `${a.keys}@${a.game}`.localeCompare(`${b.keys}@${b.game}`));
}

const hotkeyVersion = () => [hotkeyList().join('|'), watchList().map((w) => `${w.keys}@${w.game}`).join('|')].join('#');

function wakeAgent(): void {
  for (const resolve of parked) resolve();
  parked.clear();
}

function agentAround(): boolean {
  return parked.size > 0 || Date.now() - agentSeenAt < AGENT_FRESH_MS;
}

/** The keys a task presses, for the echo guard: a hotkey heard just after is the task's own press. */
function pressedBy(task: AgentTask): string[] {
  if (task.do === 'keys') return [task.keys];
  if (task.do !== 'timeline') return [];
  return task.bars.map((b) => b.keys);
}

/**
 * Ask the agent to do something on the PC, and wait until it says it has. A
 * refusal it gives (nothing is playing, a game gone from disk) is the step's
 * failure, in its words.
 */
function agentDo(task: AgentTask, what: string): Promise<unknown> {
  if (!agentAround()) {
    return Promise.reject(new Error(`Nothing on the PC can ${what}: the agent isn't running there.`));
  }
  const hold =
    task.do === 'keys' ? task.hold : task.do === 'timeline' ? task.totalMs : task.do === 'ask' ? task.seconds * 1000 + 10_000 : 0;
  return new Promise((resolve, reject) => {
    const job: Job = {
      id: newId(),
      task,
      sent: false,
      done: (error, value) => {
        clearTimeout(timeout);
        for (const keys of pressedBy(task)) lastPressed.set(keys, Date.now());
        if (error) reject(new Error(error));
        else resolve(value);
      },
    };
    const timeout = setTimeout(() => {
      const at = jobs.indexOf(job);
      if (at !== -1) jobs.splice(at, 1);
      reject(new Error(`The agent did not ${what} within ${Math.round((PRESS_TIMEOUT_MS + hold) / 1000)} seconds.`));
    }, PRESS_TIMEOUT_MS + hold);
    timeout.unref?.();
    jobs.push(job);
    wakeAgent();
  });
}

/**
 * From the side of the agent: this PC, the agent's own key, or, on a friend's
 * copy, any of their devices. The rule voice's agent routes follow.
 */
function agentSide(request: FastifyRequest): boolean {
  return (
    request.isLocal ||
    request.deviceKind === 'windows-agent' ||
    (isGuest && request.deviceId !== null && request.deviceKind !== 'instance')
  );
}

/**
 * A game by the games list's name for it ("Warframe"), which is what the
 * picker shows, or tidied from the file name for one not on it. `{game}` was
 * the file name, so "Played {game}" wrote "Played warframe".
 */
async function gameLabel(exe: string): Promise<string> {
  const [row] = await db.select({ label: games.label }).from(games).where(eq(games.exe, exe.toLowerCase()));
  return row?.label ?? gameName(exe).replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Ends when the run is stopped, so a wait on somebody else can be cut short. */
function untilStopped(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new RunStopped(stopReason(signal)));
    signal.addEventListener('abort', () => reject(new RunStopped(stopReason(signal))), { once: true });
  });
}

/** The real asking and doing, or, for a test, the real asking and only saying. */
function effectsFor(run: Run, vars: Record<string, string>, signal: AbortSignal): Effects {
  const dry = run.dry;
  let shownAt = 0;
  /**
   * What a test set its variables to, so the boxes after a Set read what it
   * would have set, and nothing real changes. Null is forgotten.
   */
  const rehearsed = new Map<string, number | string | null>();
  const variable = (name: string): number | string | undefined => {
    // Forgotten in a test is back to its start, as it is for real.
    if (rehearsed.has(name)) return rehearsed.get(name) ?? startOf(name, run.blueprint);
    return variables.get(name) ?? startOf(name, run.blueprint);
  };
  /** A text box with its `{words}` filled in: the run's own, then the variables. */
  const text = (node: GraphNode, key: string, words: Record<string, string>): string => {
    const named: Record<string, string> = {};
    const from = starts(run.blueprint);
    for (const [name, value] of from) named[name] = asWord(value);
    for (const [name, value] of variables) named[name] = asWord(value);
    for (const [name, value] of rehearsed) {
      if (value !== null) named[name] = asWord(value);
      else if (from.has(name)) named[name] = asWord(from.get(name)!);
      else delete named[name];
    }
    return fill(String(node.fields[key] ?? ''), { ...named, ...words }).trim();
  };
  /** Said once, the first time a run settles in to wait, so the screen shows it going. */
  const settle = () => {
    if (dry || run.waiting) return;
    run.waiting = true;
    record(run);
  };
  return {
    rehearsal: dry,

    variable,

    async pause(ms: number) {
      if (dry) return;
      settle();
      await sleep(ms, signal);
    },

    alive() {
      if (signal.aborted) throw new RunStopped(stopReason(signal));
    },

    // A long repeat is shown as it goes, but not more than every two seconds:
    // each showing rewrites the run log and refetches the screen.
    progress() {
      if (dry || Date.now() - shownAt < 2000) return;
      shownAt = Date.now();
      record(run);
    },

    async check(node: GraphNode, spec: NodeSpec, inputs: Inputs) {
      const now = new Date();
      switch (spec.type) {
        case 'if-doing': {
          const want = String(node.fields.state);
          const label = spec.fields[0]!.options!.find((o) => o.id === want)?.label ?? want;
          if (!attention) return { yes: false, said: 'Not known yet: the PC has not reported since the app started.' };
          const yes = want === 'away' ? attention.away || attention.state === 'away' : !attention.away && attention.state === want;
          // "In a game" can name one: then it is that game in front, not any.
          const game = want === 'in-game' ? String(node.fields.game ?? '') : '';
          if (game) {
            const playing = yes && attention.game ? attention.game.toLowerCase() : '';
            const named = await gameLabel(game);
            if (playing === game) return { yes: true, said: `Yes, in ${named}` };
            return { yes: false, said: playing ? `No, in ${await gameLabel(playing)}, not ${named}` : `No, not in ${named}` };
          }
          return { yes, said: yes ? `Yes, ${label}` : `No, not ${label}` };
        }
        case 'if-time': {
          const from = String(node.fields.from);
          const to = String(node.fields.to);
          const yes = isBetween(now.getHours() * 60 + now.getMinutes(), from, to);
          return { yes, said: `It is ${clock(now)}, ${yes ? 'between' : 'not between'} ${from} and ${to}` };
        }
        case 'if-day': {
          const yes = dayMatches(String(node.fields.days), now.getDay());
          const weekend = now.getDay() === 0 || now.getDay() === 6;
          return { yes, said: `It is a ${weekend ? 'weekend' : 'weekday'}` };
        }
        case 'if-held': {
          const keys = String(node.fields.keys);
          if (!keys) throw new Error('"Am I holding a key?" has no key set yet.');
          // Asked for real in a Test too, like every check: it changes nothing.
          const yes = (await agentDo({ do: 'held', keys }, `see whether ${keys} is held`)) === true;
          return { yes, said: `${keys} is ${yes ? 'held down' : 'not held'}` };
        }
        case 'if-switch': {
          const name = switchName(node);
          if (!name) throw new Error('"Is a switch on?" has no switch named yet.');
          const yes = switches.get(name) ?? false;
          return { yes, said: `"${name}" is ${yes ? 'on' : 'off'}` };
        }
        case 'counter': {
          const key = `${run.blueprint}:${node.id}`;
          const times = Number(node.fields.times);
          const was = counters.get(key);
          /*
           * X is read when a count starts, so a Random number wired in picks a
           * new target each time round rather than every run. A typed number is
           * read afresh when it changes, so editing it takes at once.
           */
          const fresh = !was || (was.from === 'field' && was.times !== times);
          let state = was && !fresh ? { ...was } : null;
          if (!state) {
            const wired = await inputs.number('x');
            const target = Math.max(1, Math.min(10_000, Math.round(wired ?? times)));
            state = { count: 0, target, from: wired === null ? 'field' : 'wire', times };
          }
          state.count += 1;
          const yes = state.count >= state.target;
          const said = `${state.count} of ${state.target}: ${yes ? 'yes, counting from 1 again' : 'not yet'}`;
          // A test counts in a copy, so pressing Test does not move the real count.
          if (!dry) {
            if (yes) counters.delete(key);
            else counters.set(key, state);
          }
          return { yes, said };
        }
        case 'if-habit': {
          const id = String(node.fields.habit);
          if (!id) throw new Error('Pick a habit for "Is this habit done?"');
          const progress = await habitProgress(id);
          if (!progress) throw new Error('That habit is not there any more.');
          /*
           * A gauge is never finished (it is draining the moment it is full),
           * so for one the question is the one its reminders ask: is it above
           * the line where it starts asking.
           */
          const yes = progress.habit.mode === 'gauge' ? !progress.wantsDoing : progress.met;
          return { yes, said: `${progress.say}: ${yes ? 'done for now' : 'wants doing'}` };
        }
      }
      throw new Error(`Nothing knows how to check "${spec.label}".`);
    },

    async act(node: GraphNode, spec: NodeSpec) {
      switch (spec.type) {
        case 'nudge': {
          // "Notification": the app's popup, on its own, not through the nudge queue.
          const title = text(node, 'title', vars);
          if (!title) throw new Error('"Notification" has nothing to say yet.');
          const when = node.fields.when === 'now' ? 'now' : node.fields.when === 'soon' ? 'soon' : 'good';
          const note: Notice = {
            title,
            body: text(node, 'body', vars),
            color: String(node.fields.color ?? ''),
            sound: String(node.fields.sound ?? 'none'),
            volume: Number(node.fields.volume ?? 50),
            when,
            seconds: staysFor(node.fields),
            giveUpAt: Date.now() + NOTICE_WAITS_MS,
          };
          if (dry) return when === 'now' || readyFor(when) ? `Would show: ${title}` : `Would show ${WAITS_FOR[when]}: ${title}`;
          if (when === 'now' || readyFor(when)) {
            await showNotice(note);
            return `Showed: ${title}`;
          }
          notices.push(note);
          return `Will show ${WAITS_FOR[when]}: ${title}`;
        }
        case 'add-task': {
          const title = text(node, 'title', vars);
          if (!title) throw new Error('"Add a task" has no task written in it.');
          const dueIn = Number(node.fields.dueIn);
          if (dry) return `Would add the task "${title}"${dueIn ? `, due in ${dueIn} minutes` : ''}`;
          const [created] = await db
            .insert(tasks)
            .values({ title, dueAt: dueIn ? Date.now() + dueIn * MINUTE : null, source: 'blueprints' })
            .returning();
          changes.emitChange('tasks');
          if (created) happenings.say('task-added', { taskId: created.id, title: created.title });
          return `Added the task "${title}"`;
        }
        case 'tick-habit': {
          const id = String(node.fields.habit);
          if (!id) throw new Error('Pick a habit for "Tick a habit".');
          // "As many as I said" reads `{amount}`, which only "I say" gives; from
          // anywhere else it is one.
          const said = vars.amount === 'max' ? 'max' : Math.max(1, Math.min(20, Number(vars.amount) || 1));
          const amount = node.fields.howMany === 'said' ? said : Number(node.fields.amount);
          if (dry) {
            const progress = await habitProgress(id);
            if (!progress) throw new Error('That habit is not there any more.');
            return `Would tick ${progress.habit.name}${amount === 'max' ? ' to full' : amount > 1 ? ` ${amount} times` : ''}`;
          }
          const progress = await recordHabitDone(id, amount);
          if (!progress) throw new Error('That habit is not there any more.');
          changes.emitChange('habits');
          return `Ticked: ${progress.say}`;
        }
        case 'note-line': {
          const title = text(node, 'note', vars) || 'Blueprint log';
          const line = text(node, 'line', vars);
          if (!line) throw new Error('"Write in a note" has no line written in it.');
          if (dry) return `Would write "${line}" in ${title}`;
          const [existing] = await db
            .select({ id: notes.id, title: notes.title, folder: notes.folder, body: notes.body })
            .from(notes)
            .where(eq(notes.titleKey, noteKey(title)))
            .limit(1);
          // The title and folder go back with the body: `saveNote` writes the
          // whole note, and a missing title is taken from the first line, so a
          // log appended without it renamed itself "tick 1" and the next run
          // could not find it.
          if (existing) {
            await saveNote(
              { title: existing.title, folder: existing.folder, body: `${existing.body.replace(/\s+$/, '')}\n${line}\n` },
              existing.id
            );
          }
          else await saveNote({ title, body: `${line}\n` });
          changes.emitChange('notes');
          return `Wrote "${line}" in ${title}`;
        }
        case 'wait': {
          const amount = Number(node.fields.minutes);
          const unit = node.fields.unit === 'ms' ? 'millisecond' : node.fields.unit === 'seconds' ? 'second' : 'minute';
          const said = `${formatNumber(amount)} ${unit}${amount === 1 ? '' : 's'}`;
          if (dry) return `Would wait ${said}`;
          settle();
          // At least a millisecond, so a loop always gives way; at most a day, which is what a wait is for.
          const ms = amount * (unit === 'millisecond' ? 1 : unit === 'second' ? 1000 : MINUTE);
          await sleep(Math.min(24 * 60 * MINUTE, Math.max(1, ms)), signal);
          return `Waited ${said}`;
        }
        case 'set-variable': {
          const name = variableName(node.fields.name);
          if (!name) throw new Error('"Set a variable" needs a name: letters, numbers and _, like score or hp_left.');
          const how = String(node.fields.how);
          let to: number | string | null;
          if (how === 'forget') to = null;
          else if (how === 'text') to = text(node, 'words', vars);
          else {
            // The sum was worked out by the walk; here it is only applied.
            const n = Number(node.fields.value);
            const was = variable(name);
            let base = 0;
            if (how !== 'set' && was !== undefined) {
              try {
                base = asNumber(was, name);
              } catch (error) {
                if (error instanceof MathError) throw new Error(`${error.message} So it cannot be added to or multiplied.`);
                throw error;
              }
            }
            if (how === 'div' && n === 0) throw new Error(`That would divide {${name}} by zero.`);
            // A percentage up or down: by 10 is ×1.1 or ×0.9, so 50 becomes 55 or 45.
            const pct = Number(node.fields.percent);
            to =
              how === 'add'
                ? base + n
                : how === 'sub'
                  ? base - n
                  : how === 'mul'
                    ? base * n
                    : how === 'div'
                      ? base / n
                      : how === 'pctup'
                        ? base * (1 + pct / 100)
                        : how === 'pctdown'
                          ? base * (1 - pct / 100)
                          : n;
            if (!Number.isFinite(to)) throw new Error(`{${name}} would not be a number.`);
          }
          const shown = to === null ? 'forgotten' : typeof to === 'number' ? formatNumber(to) : `"${to}"`;
          if (dry) {
            rehearsed.set(name, to);
            return to === null ? `Would forget {${name}}` : `Would set {${name}} to ${shown}`;
          }
          setVariable(name, to);
          return to === null ? `Forgot {${name}}` : `Set {${name}} to ${shown}`;
        }
        case 'play-sound': {
          const fields = specOf('play-sound')!.fields;
          const labelOf = (key: string, id: unknown) => fields.find((f) => f.key === key)?.options?.find((o) => o.id === id)?.label ?? String(id);
          const kind = String(node.fields.sound || 'tone');
          const quiet = await currentQuietReason();
          if (quiet && node.fields.quiet === 'skip') return `Not played: ${HELD_BECAUSE[quiet] ?? 'reminders are being held'}`;
          let what: string;
          let lasts = 0;
          let task: AgentTask;
          if (kind === 'file') {
            const path = localSoundPath(text(node, 'path', vars));
            if (!path) throw new Error('"Play a sound" needs the full path of a .wav or .mp3 file on this PC, like C:\\Sounds\\ding.mp3.');
            what = path.split(/[\\/]/).pop()!;
            task = { do: 'sound-file', path, volume: Number(node.fields.volume ?? 50) };
          } else if (kind === 'tone') {
            const tone = String(node.fields.tone || 'chime');
            what = labelOf('tone', tone);
            lasts = toneLength(tone);
            task = { do: 'tone', tone, volume: Number(node.fields.volume ?? 50) };
          } else {
            // The words are filled in here, {game} and the rest, so the PC says what the run knows.
            const fields = kind === 'speech' ? { ...node.fields, say: text(node, 'say', vars) } : node.fields;
            const design = designOf(fields)!;
            what =
              design.kind === 'speech'
                ? `"${String(fields.say).slice(0, 80)}" spoken`
                : design.kind === 'click'
                  ? labelOf('click', design.click).split(':')[0]!.toLowerCase() + ' click'
                  : soundWords(design.lines);
            if (design.kind === 'speech' && !String(fields.say).trim()) throw new Error('"Play a sound" has no words to say yet.');
            if (design.times > 1) what += ` ${design.times} times`;
            lasts = designLength(design);
            task = { do: 'sound', fields };
          }
          if (dry) return `Would play ${what}`;
          const answered = await agentDo(task, `play ${what}`);
          // A file says how long it is once the PC has opened it.
          if (kind === 'file' && typeof answered === 'number') lasts = Math.min(10 * MINUTE, Math.max(0, answered));
          if (node.fields.then === 'after' && lasts > 0) {
            settle();
            await sleep(lasts, signal);
          }
          return `Played ${what}`;
        }
        case 'show-popup': {
          const title = text(node, 'title', vars);
          if (!title) throw new Error('"Show a popup" has nothing to say yet.');
          const quiet = await currentQuietReason();
          if (quiet && node.fields.quiet === 'skip') return `Not shown: ${HELD_BECAUSE[quiet] ?? 'reminders are being held'}`;
          if (dry) return `Would show: ${title}`;
          const seconds = Number(node.fields.seconds);
          await agentDo({ do: 'popup', title, body: text(node, 'body', vars), color: String(node.fields.color ?? ''), seconds }, 'show the popup');
          return `Showed: ${title}`;
        }
        case 'ask': {
          const title = text(node, 'title', vars) || 'A question';
          const quiet = await currentQuietReason();
          if (quiet && node.fields.quiet === 'skip') {
            return { said: `Not asked: ${HELD_BECAUSE[quiet] ?? 'reminders are being held'}`, pin: 'none' };
          }
          const saveAs = variableName(node.fields.saveAs);
          if (dry) {
            vars.answer = 'what you typed';
            if (saveAs) rehearsed.set(saveAs, vars.answer);
            return { said: `Would ask: ${title}, and go on as if it were answered`, pin: 'answered' };
          }
          settle();
          const ask = newId();
          const seconds = Number(node.fields.seconds);
          const asking = agentDo(
            {
              do: 'ask',
              ask,
              title,
              body: text(node, 'body', vars),
              placeholder: text(node, 'placeholder', vars),
              color: String(node.fields.color ?? ''),
              seconds,
            },
            'ask'
          );
          // Stopped while it waits: the question comes off the screen too.
          const takeBack = () => void agentDo({ do: 'unask', ask }, 'take the question away').catch(() => undefined);
          signal.addEventListener('abort', takeBack, { once: true });
          let answer: unknown;
          try {
            answer = await Promise.race([asking, untilStopped(signal)]);
          } finally {
            signal.removeEventListener('abort', takeBack);
          }
          const typed = typeof answer === 'string' ? answer.trim().slice(0, 500) : '';
          if (!typed) return { said: 'No answer', pin: 'none' };
          vars.answer = typed;
          if (saveAs) {
            const n = Number(typed.replace(/,/g, ''));
            setVariable(saveAs, Number.isFinite(n) && /\d/.test(typed) ? n : typed);
          }
          return { said: `Answered "${typed}"${saveAs ? `, kept as {${saveAs}}` : ''}`, pin: 'answered' };
        }
        case 'press-keys': {
          if (node.fields.mode === 'timeline') {
            const bars = playable(parseTimeline(node.fields.timeline));
            if (bars.length === 0) throw new Error('"Press keys" has no keys on its timeline yet.');
            const totalMs = timelineLength(bars);
            const what = `${bars.map((b) => b.keys).join(', ')} over ${totalMs} ms`;
            if (dry) return `Would play ${what}`;
            await agentDo({ do: 'timeline', bars, totalMs }, 'play the timeline');
            return `Played ${what}`;
          }
          const keys = String(node.fields.keys);
          if (!keys) throw new Error('"Press keys" has no keys set yet.');
          const hold = Number(node.fields.hold);
          if (dry) return `Would press ${keys}${hold ? `, held ${hold} ms` : ''}`;
          await agentDo({ do: 'keys', keys, hold }, `press ${keys}`);
          return `Pressed ${keys}`;
        }
        case 'open-url': {
          const url = text(node, 'url', vars);
          // Only http and https: anything else hands the shell a `file:` path or
          // somebody's protocol handler. The agent checks again.
          if (!isOpenableUrl(url)) throw new Error(`"${url || 'nothing'}" is not an http or https address.`);
          if (dry) return `Would open ${url}`;
          await agentDo({ do: 'url', url }, `open ${url}`);
          return `Opened ${url}`;
        }
        case 'media': {
          const action = String(node.fields.action);
          const label = MEDIA_OPTIONS.find((o) => o.id === action)?.label ?? action;
          if (dry) return `Would press ${label}`;
          // Whether anything is playing is the agent's to say: only it can see
          // the output meter, and it refuses when nothing is.
          await agentDo({ do: 'media', action }, `press ${label}`);
          return label;
        }
        case 'launch-game': {
          const exe = String(node.fields.game);
          if (!exe) throw new Error('Pick a game for "Start a game".');
          const [row] = await db.select().from(games).where(eq(games.exe, exe));
          // Three failures, told apart, because they have three different fixes.
          if (!row) throw new Error(`${exe} is not on the games list.`);
          const target = row.launchUrl && isLaunchUrl(row.launchUrl) ? { url: row.launchUrl } : row.launchPath ? { path: row.launchPath } : null;
          if (!target) throw new Error(`Not sure how to start ${row.label} yet: run it once and the PC will know.`);
          if (dry) return `Would start ${row.label}`;
          await agentDo({ do: 'launch', name: row.label, ...target }, `start ${row.label}`);
          return `Started ${row.label}`;
        }
        case 'play-music': {
          const what = String(node.fields.what);
          const label = what === 'stop' ? 'Stopped adding songs' : what === 'random' ? 'Playing random music' : 'Playing shuffled music';
          if (dry) return `Would: ${label.toLowerCase()}`;
          const done =
            what === 'stop'
              ? await musicRequest('/api/integrations/spotify/shuffle/stop', {})
              : await musicRequest('/api/integrations/spotify/shuffle', { mode: 'play', order: what === 'random' ? 'random' : 'shuffle' });
          if (!done.ok) throw new Error(done.why);
          return label;
        }
        case 'set-switch': {
          const name = switchName(node);
          if (!name) throw new Error('"Flip a switch" has no switch named yet.');
          const was = switches.get(name) ?? false;
          const to = node.fields.to === 'on' ? true : node.fields.to === 'off' ? false : !was;
          vars.switch = to ? 'on' : 'off';
          if (dry) return `Would turn "${name}" ${vars.switch}`;
          switches.set(name, to);
          changes.emitChange(SCOPE);
          return `Turned "${name}" ${vars.switch}`;
        }
        case 'new-note': {
          const body = text(node, 'text', vars);
          if (!body || /^\{said\}$/.test(body)) throw new Error('Nothing to write down.');
          if (dry) return `Would note: ${body}`;
          // Through `saveNote`, so it is titled, tagged and linkable like any note.
          await saveNote({ body });
          changes.emitChange('notes');
          return `Noted: ${body}`;
        }
      }
      throw new Error(`Nothing knows how to do "${spec.label}".`);
    },
  };
}

/**
 * Keep a run in the log and tell the screen, at most once a second: a hotkey
 * on the left mouse button is a run per click, and a file written and every
 * open screen refetching per click is the cost a macro must not have.
 */
let logTimer: NodeJS.Timeout | null = null;

function record(run: Run): void {
  const at = runs.findIndex((r) => r.id === run.id);
  if (at === -1) runs.push(run);
  else runs[at] = run;
  runs = runs.slice(-100);
  if (logTimer) return;
  logTimer = setTimeout(flushLog, 1000);
  logTimer.unref?.();
}

function flushLog(): void {
  if (logTimer) clearTimeout(logTimer);
  logTimer = null;
  try {
    writeRuns(runs);
  } catch (error) {
    console.warn('[blueprints] could not write the run log:', (error as Error).message);
  }
  changes.emitChange(SCOPE);
}

/**
 * Recent real runs of one blueprint, for the runaway guard. Runs started by a
 * hotkey are not counted: a person pressing a key twenty times in ten minutes
 * is using a macro, not a blueprint starting itself.
 */
function recentRuns(id: string, now: number): number {
  return runs.filter((r) => r.blueprint === id && !r.dry && !r.hand && now - r.at < RUN_WINDOW_MS).length;
}

async function start(
  bp: Blueprint,
  from: string,
  vars: Record<string, string>,
  dry: boolean,
  depth = 0,
  hand = false,
  /** Written in the run log. Not for a voice test, which is asked per phrase typed. */
  log = true
): Promise<Run> {
  const run: Run = { id: newId(), blueprint: bp.id, at: Date.now(), from, dry, steps: [], ...(hand ? { hand } : {}) };
  const filled = { time: clock(), ...vars };
  const abort = new AbortController();
  if (!dry) active.set(run.id, { blueprint: bp.id, from, abort });
  try {
    // The walk writes into `run.steps` as it goes, so a run recorded while it
    // waits shows how far it got.
    await context.run({ depth, blueprint: bp.id }, () =>
      walk(bp.graph, from, { ...effectsFor(run, filled, abort.signal), halt: () => abort.abort(new RunStopped('The run ended.')) }, run.steps, filled)
    );
  } finally {
    active.delete(run.id);
    run.waiting = false;
  }
  if (log) record(run);
  return run;
}

/**
 * Ask the Music feature, over HTTP to this same server: integrations is
 * another package and may not be imported. Loopback with no forwarding
 * headers is what local trust lets through, and a 404 is that package being
 * switched off or gone. The voice package did exactly this before its
 * commands became blueprints.
 */
async function musicRequest(path: string, body: unknown): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.PORT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404) return { ok: false, why: "Music isn't installed" };
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      return { ok: false, why: data.error ?? `Music answered ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : 'Music did not answer' };
  }
}

/* ---- Spoken commands, for voice ------------------------------------- */

/*
 * Voice matches a sentence against these and asks for the one it chose to be
 * run, through core's spoken port: voice and blueprints may not import each
 * other. One per "When I say" box. Voice keeps what is about hearing (the
 * matching, chains, "did you mean", the follow-up window); a blueprint keeps
 * what is about doing.
 */
function spokenList(): SpokenCommand[] {
  const out: SpokenCommand[] = [];
  for (const bp of list) {
    const words = JSON.stringify(bp.graph.nodes.filter((n) => specOf(n.type)?.kind === 'action').map((n) => n.fields));
    const habits = [...new Set(bp.graph.nodes.filter((n) => n.type === 'tick-habit' && n.fields.habit).map((n) => String(n.fields.habit)))];
    for (const node of bp.graph.nodes) {
      if (node.type !== 'on-voice') continue;
      out.push({
        id: `${bp.id}:${node.id}`,
        phrases: phrasesOf(node.fields),
        label: bp.name,
        allowFollowUp: node.fields.keep !== 'no',
        // A box that writes down what was said after the phrase must have all of
        // it, so voice never splits it as one half of "this and that".
        takesRest: words.includes('{said}'),
        enabled: bp.enabled && !bp.stopped,
        habits,
        edit: { screen: 'blueprints', focus: bp.id },
      });
    }
  }
  return out;
}

/** What a run did, in one line for the popup: its Do boxes, or why it stopped. */
function summarise(run: Run, name: string): { ok: boolean; say: string } {
  const last = run.steps.at(-1);
  if (last && (last.result === 'failed' || last.result === 'stopped')) return { ok: false, say: last.said };
  const done = run.steps.filter((s) => s.result === 'done' && s.pin === 'then').map((s) => s.said);
  if (done.length) return { ok: true, say: done.join(' · ') };
  const answer = [...run.steps].reverse().find((s) => s.result === 'yes' || s.result === 'no');
  return { ok: true, say: answer ? `${name}: ${answer.said}, so nothing to do` : `${name} has nothing after "I say" yet` };
}

/**
 * Longer than any ordinary run and short enough for a popup. A run still going
 * past it (a Wait, a Repeat) carries on, and voice is told it started.
 */
const SPOKEN_WAIT_MS = 4000;

async function runSpoken(id: string, heard: SpokenHeard, dry = false): Promise<{ ok: boolean; say: string }> {
  const [bpId, nodeId] = id.split(':');
  const bp = list.find((b) => b.id === bpId);
  if (!bp || !bp.graph.nodes.some((n) => n.id === nodeId && n.type === 'on-voice')) {
    return { ok: false, say: 'That voice command is not there any more' };
  }
  if (!dry && (!bp.enabled || bp.stopped)) return { ok: false, say: `${bp.name} is switched off` };
  const vars = { said: heard.rest, amount: String(heard.amount) };
  // A person said it, so the runaway guard does not count it; and a test from
  // the Voice screen's "Try a phrase" is not written in the run log, or every
  // phrase tried would be a run of somebody's blueprint.
  const running = start(bp, nodeId!, vars, dry, 0, true, !dry);
  const settled = await Promise.race([running, new Promise<null>((resolve) => setTimeout(() => resolve(null), SPOKEN_WAIT_MS).unref?.())]);
  if (!settled) return { ok: true, say: `${bp.name}: started, and still going` };
  return summarise(settled, bp.name);
}

/** Which keys a hotkey box answers to, by how it listens. */
function hotkeyOf(node: GraphNode, watched: boolean): string {
  const watching = node.fields.listen === 'watch';
  return watching === watched ? String(watching ? node.fields.watch : node.fields.keys) : '';
}

/** A watched key let go: stop what it started, where its box says letting go does. */
function hotkeyReleased(keys: string): void {
  for (const bp of list) {
    for (const node of bp.graph.nodes) {
      if (node.type === 'on-hotkey' && node.fields.release === 'stop' && hotkeyOf(node, true) === keys) {
        stopRuns(bp.id, `Stopped: ${keys} was let go.`, node.id);
      }
    }
  }
}

/** A hotkey the agent heard: start, stop or restart what listens for it. */
function hotkeyPressed(keys: string, watched = false): void {
  // The blueprint's own press of these keys, coming back.
  if (Date.now() - (lastPressed.get(keys) ?? 0) < ECHO_MS) return;
  for (const bp of list) {
    if (!bp.enabled || bp.stopped) continue;
    for (const node of bp.graph.nodes) {
      if (node.type !== 'on-hotkey' || hotkeyOf(node, watched) !== keys) continue;
      // A watched press was checked against the window in front by the agent at
      // that moment, which is fresher than the heartbeat `listening` reads.
      if (!watched && !listening(node)) continue;
      const going = [...active.values()].some((r) => r.blueprint === bp.id && r.from === node.id && !r.abort.signal.aborted);
      const again = String(node.fields.again);
      if (going && again === 'ignore') continue;
      if (going && again === 'stop') {
        stopRuns(bp.id, `Stopped: ${keys} was pressed again.`, node.id);
        continue;
      }
      if (going && again === 'restart') stopRuns(bp.id, `Started again: ${keys} was pressed again.`, node.id);
      setImmediate(() => {
        void start(bp, node.id, {}, false, 0, true).catch((error) =>
          console.warn(`[blueprints] ${bp.name} failed:`, (error as Error).message)
        );
      });
    }
  }
}

/** An event happened: start every switched-on blueprint with a box that matches. */
function fire(type: string, matches: (node: GraphNode) => boolean, vars: Record<string, string>): void {
  const parent = context.getStore();
  const depth = parent ? parent.depth + 1 : 0;
  if (depth > MAX_DEPTH) return;
  const now = Date.now();
  for (const bp of list) {
    if (!bp.enabled || bp.stopped) continue;
    // A blueprint's own action does not start that same blueprint again.
    if (parent?.blueprint === bp.id) continue;
    for (const node of bp.graph.nodes) {
      if (node.type !== type || !matches(node)) continue;
      if (recentRuns(bp.id, now) >= RUNS_PER_WINDOW) {
        bp.stopped = `Switched itself off: it ran ${RUNS_PER_WINDOW} times in ten minutes. Check it is not starting itself, then switch it back on.`;
        try {
          save();
        } catch {
          /* the store is refusing writes; the in-memory stop still holds */
        }
        changes.emitChange(SCOPE);
        break;
      }
      // Handed off: a listener must not hold up the request that said it.
      setImmediate(() => {
        void start(bp, node.id, vars, false, depth).catch((error) =>
          console.warn(`[blueprints] ${bp.name} failed:`, (error as Error).message)
        );
      });
    }
  }
}

function listen(): Array<() => void> {
  const contains = (node: GraphNode, title: string) => {
    const want = String(node.fields.contains ?? '').trim().toLowerCase();
    return !want || title.toLowerCase().includes(want);
  };
  return [
    happenings.hear('attention', (a: Happenings['attention']) => {
      // Kept before it is replaced: going straight from one game to another is a start too.
      const wasPlaying = attention?.state === 'in-game' ? attention.game : null;
      const heard = hotkeyVersion();
      const was = statusKey();
      attention = { state: a.state, away: a.away, game: a.game, games: a.games ?? [] };
      if (notices.length) deliverNotices(Boolean(a.stoppingPoint));
      // A game opening or closing moves a blueprint between on and idle: say so.
      if (statusKey() !== was) changes.emitChange(SCOPE);
      // A hotkey for one game starts or stops being listened for: tell the agent now.
      if (hotkeyVersion() !== heard) wakeAgent();
      const stop = a.stoppingPoint;
      const started = a.state === 'in-game' && (a.previous !== 'in-game' || a.game !== wasPlaying);
      if (stop || started) {
        // The name is a lookup, so these two fire a moment after the rest.
        void (a.game ? gameLabel(a.game) : Promise.resolve(''))
          .catch(() => gameName(a.game ?? ''))
          .then((game) => {
            if (stop) fire('on-stop', (n) => n.fields.quality === 'any' || stop.quality === 'prime', { game });
            if (started) {
              const exe = a.game?.toLowerCase() ?? '';
              fire('on-game-start', (n) => !n.fields.game || n.fields.game === exe, { game });
            }
          });
      }
      if (a.away && a.previousAway === false) fire('on-away', () => true, {});
      if (!a.away && a.previousAway === true) fire('on-back', () => true, {});
    }),
    happenings.hear('habit-done', (h) => fire('on-habit', (n) => !n.fields.habit || n.fields.habit === h.habitId, { habit: h.name })),
    happenings.hear('task-done', (t) => fire('on-task-done', (n) => contains(n, t.title), { task: t.title })),
    happenings.hear('task-added', (t) => fire('on-task-added', (n) => contains(n, t.title), { task: t.title })),
  ];
}

/* ---- Timed boxes ---------------------------------------------------- */

/*
 * *At a time of day* and *Every so often* share one timeout: to whichever is
 * next due, re-armed after every change and at least every six hours, and
 * nothing at all with neither box switched on. The arithmetic is
 * `web/schedule.ts`, the same the screen shows under the box.
 */
let timer: NodeJS.Timeout | null = null;
let armedAt = Date.now();
const LONGEST_SLEEP = 6 * 60 * MINUTE;
const TIMED = new Set(['on-time', 'on-every']);

/**
 * When each blueprint's count began, for *Every so often* counted from the
 * start: the app starting, or the blueprint being switched on or its timed
 * boxes changed. Moving a box about does not restart it.
 */
const bases = new Map<string, number>();
const bootAt = Date.now();

function baseOf(bp: Blueprint): number {
  return bases.get(bp.id) ?? bootAt;
}

/** A graph without where its boxes sit: what it does, for telling a change from a tidy-up. */
function behaviour(graph: Blueprint['graph']): string {
  return JSON.stringify({
    nodes: graph.nodes.map(({ x: _x, y: _y, color: _color, ...rest }) => rest),
    wires: graph.wires.map(({ id: _id, ...rest }) => rest),
  });
}

/** What the timed boxes of a graph say, so a change to anything else is not one. */
function timing(bp: Blueprint): string {
  return JSON.stringify(bp.graph.nodes.filter((n) => TIMED.has(n.type)).map((n) => [n.id, n.type, n.fields]));
}

/** A count starts: note when, and run what was asked to run straight away. */
function startCount(bp: Blueprint, at = Date.now()): void {
  bases.set(bp.id, at);
  if (!bp.enabled || bp.stopped) return;
  for (const node of bp.graph.nodes) {
    if (node.type === 'on-every' && node.fields.from === 'start' && node.fields.first === 'now') {
      fire('on-every', (n) => n.id === node.id, { time: clock() });
    }
  }
}

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  armedAt = Date.now();
  let soonest: number | null = null;
  for (const bp of list) {
    if (!bp.enabled || bp.stopped) continue;
    for (const node of bp.graph.nodes) {
      if (!TIMED.has(node.type)) continue;
      const due = nextDue(node.type, node.fields, armedAt, baseOf(bp));
      if (due !== null && (soonest === null || due < soonest)) soonest = due;
    }
  }
  if (soonest === null) return;
  timer = setTimeout(tick, Math.min(Math.max(soonest - Date.now(), 1000), LONGEST_SLEEP));
  timer.unref?.();
}

function tick(): void {
  const now = Date.now();
  const since = armedAt;
  for (const bp of list) {
    if (!bp.enabled || bp.stopped) continue;
    for (const node of bp.graph.nodes) {
      if (!TIMED.has(node.type)) continue;
      const due = lastDue(node.type, node.fields, now, baseOf(bp));
      // Come round since the last look, and not so long ago that the PC was
      // plainly asleep through it. Only the latest counts: what was missed
      // while asleep is not made up in a burst.
      if (due !== null && due > since && now - due < LATE_MS) {
        fire(node.type, (n) => n.id === node.id, { time: clock(new Date(due)) });
      }
    }
  }
  arm();
}

/* ---- Routes --------------------------------------------------------- */

/** A new blueprint from a template. Off: it does things, and should start because you said so. */
function newBlueprint(templateId: unknown, name: unknown): Blueprint {
  const template = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0]!;
  const now = Date.now();
  const bp: Blueprint = {
    id: newId(),
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : template.name === 'Empty' ? 'New blueprint' : template.name,
    enabled: false,
    graph: template.graph(),
    stopped: null,
    createdAt: now,
    updatedAt: now,
  };
  bases.set(bp.id, now);
  return bp;
}

/** What a test fills the `{words}` with, since nothing happened to give them. */
async function sampleVars(bp: Blueprint, from: string): Promise<Record<string, string>> {
  const node = bp.graph.nodes.find((n) => n.id === from);
  return {
    game: attention?.game ? await gameLabel(attention.game) : 'a game',
    habit: 'a habit',
    task: 'a task',
    count: '1',
    ...(node?.type === 'on-time' ? { time: String(node.fields.at) } : {}),
    ...(node?.type === 'on-every' ? { time: clock() } : {}),
  };
}

function present() {
  return {
    blueprints: list,
    folders,
    runs: runs.slice(-60),
    /** Runs still going: in a Wait or a Repeat. */
    waiting: [...active.keys()].filter((id) => runs.some((r) => r.id === id)),
    templates: TEMPLATES.map(({ id, name, blurb }) => ({ id, name, blurb })),
    error: loadError,
    /** What "Am I…" would see now, so the screen can say it. */
    attention,
    /** Whether the agent is there to hear hotkeys and press keys, and what it could not register. */
    agent: { around: agentAround(), problems: agentProblems },
    /** Switches that are on, so the screen can say so: a script's GUI showed "ON". */
    switchesOn: [...switches].filter(([, on]) => on).map(([name]) => name).sort(),
    /** Every variable and what it holds, for the side column and the maths boxes' previews. */
    variables: Object.fromEntries([...variables].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export async function routes(app: FastifyInstance): Promise<void> {
  load();
  void readVoiceFacts().catch(() => undefined);
  // Voice's own commands from before they were blueprints, made into one each,
  // once. A store that cannot be read is left alone, as everything else is.
  if (!loadError) {
    try {
      const { made, commit } = await convertVoiceCommands();
      if (made.length) {
        list.push(...made);
        save();
        console.log(`[blueprints] made ${made.length} voice command${made.length === 1 ? '' : 's'} into blueprints`);
      }
      commit();
    } catch (error) {
      console.warn('[blueprints] could not convert the voice commands:', (error as Error).message);
    }
  }
  provideSpokenCommands({
    list: spokenList,
    run: runSpoken,
    async create(preset) {
      const bp = newBlueprint('voice', preset?.name ? `Say: ${preset.name}` : 'New voice command');
      // From a habit's editor: "When I say" already leads to ticking it, as
      // many as was said, so what is left is the phrases.
      if (preset?.habit) {
        const say = bp.graph.nodes[0]!;
        const tick = { id: newId(), type: 'tick-habit', x: say.x + 280, y: say.y, fields: { habit: preset.habit, howMany: 'said', amount: 1 } };
        bp.graph = cleanGraph({ nodes: [...bp.graph.nodes, tick], wires: [{ id: newId(), from: say.id, pin: 'then', to: tick.id }] });
      }
      list.push(bp);
      save();
      spokenChanged();
      changes.emitChange(SCOPE);
      return { edit: { screen: 'blueprints', focus: bp.id } };
    },
  });
  const unlisten = listen();
  // The app starting is where a count "from the start" begins.
  for (const bp of list) startCount(bp, bootAt);
  arm();
  app.addHook('onClose', async () => {
    unlisten.forEach((off) => off());
    if (timer) clearTimeout(timer);
    for (const [, run] of active) run.abort.abort('Stopped: the app closed.');
    if (logTimer) flushLog();
    if (variablesTimer) flushVariables();
    wakeAgent();
  });

  /*
   * The agent's three routes say nothing to the change stream by themselves:
   * the long poll ends every twenty seconds and a watched key is a request per
   * click, and announcing either reloaded every open screen, the phone's
   * included, on that timer (found in the log as the reader's chapter list
   * refetched every 20s while reading). They announce under SCOPE when
   * something others should see did change: the agent coming back, its
   * problems, a run.
   */
  const QUIET = { config: { announce: false } };

  /** A question on the PC answered, or given up on (null), from the agent's popup. */
  app.post('/api/blueprints/answer', QUIET, async (request, reply) => {
    if (!agentSide(request)) return reply.code(403).send({ error: 'Only the agent says this.' });
    const body = (request.body ?? {}) as { ask?: unknown; answer?: unknown };
    agentSeenAt = Date.now();
    const at = jobs.findIndex((j) => j.task.do === 'ask' && j.task.ask === body.ask);
    if (at === -1) return { ok: false };
    const [job] = jobs.splice(at, 1);
    job!.done(undefined, typeof body.answer === 'string' ? body.answer.slice(0, 500) : null);
    return { ok: true };
  });

  /** Forget a variable, from the side column. */
  app.delete('/api/blueprints/variables/:name', async (request, reply) => {
    const name = variableName((request.params as { name: string }).name);
    if (!name || !variables.has(name)) return reply.code(404).send({ error: 'There is no such variable.' });
    setVariable(name, null);
    flushVariables();
    return reply.code(204).send();
  });

  /**
   * The agent's half: what to listen for and what to press, held open until
   * there is something to say, and answered with what it has done since.
   */
  app.post('/api/blueprints/agent', QUIET, async (request, reply) => {
    if (!agentSide(request)) return reply.code(403).send({ error: 'Only the agent asks this.' });
    const body = (request.body ?? {}) as { version?: unknown; waitMs?: unknown; problems?: unknown; done?: unknown };
    const wasAround = agentAround();
    agentSeenAt = Date.now();
    // The app on the PC coming back moves hotkey blueprints from idle to on.
    if (!wasAround) changes.emitChange(SCOPE);
    for (const d of Array.isArray(body.done) ? body.done : []) {
      const done = d as { id?: unknown; error?: unknown; value?: unknown };
      const at = jobs.findIndex((j) => j.id === done.id);
      if (at === -1) continue;
      const [job] = jobs.splice(at, 1);
      // Only a yes or no (a held key) or a number (a sound file's length) comes back this way; an answer typed has its own route.
      const value = typeof done.value === 'boolean' || (typeof done.value === 'number' && Number.isFinite(done.value)) ? done.value : undefined;
      job!.done(typeof done.error === 'string' && done.error ? done.error : undefined, value);
    }
    if (Array.isArray(body.problems)) {
      const problems = body.problems.slice(0, 20).map((p) => String(p).slice(0, 200));
      if (JSON.stringify(problems) !== JSON.stringify(agentProblems)) {
        agentProblems = problems;
        changes.emitChange(SCOPE);
      }
    }
    const waitMs = Math.min(Number(body.waitMs) || 0, 25_000);
    if (waitMs > 0 && body.version === hotkeyVersion() && !jobs.some((j) => !j.sent)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timeout);
          parked.delete(done);
          resolve();
        };
        const timeout = setTimeout(done, waitMs);
        timeout.unref?.();
        parked.add(done);
      });
    }
    agentSeenAt = Date.now();
    const sending = jobs.filter((j) => !j.sent);
    for (const job of sending) {
      job.sent = true;
      // Marked now as well as when it is done: the hotkey this press sets off
      // can arrive before the agent's next ask says it pressed it.
      const until = Date.now() + (job.task.do === 'keys' ? job.task.hold : job.task.do === 'timeline' ? job.task.totalMs : 0);
      for (const keys of pressedBy(job.task)) lastPressed.set(keys, until);
    }
    return {
      version: hotkeyVersion(),
      hotkeys: hotkeyList(),
      watch: watchList(),
      tasks: sending.map(({ id, task }) => ({ id, ...task })),
    };
  });

  /** A hotkey the agent heard. */
  app.post('/api/blueprints/hotkey', QUIET, async (request, reply) => {
    if (!agentSide(request)) return reply.code(403).send({ error: 'Only the agent says this.' });
    const body = (request.body ?? {}) as { keys?: unknown; watched?: unknown; up?: unknown };
    const watched = body.watched === true;
    // A watched key may be bare or a mouse button; a registered one has a modifier.
    const keys = normalKeys(String(body.keys ?? ''), !watched, watched);
    if (!keys) return reply.code(400).send({ error: 'Not a hotkey.' });
    agentSeenAt = Date.now();
    if (body.up === true) hotkeyReleased(keys);
    else hotkeyPressed(keys, watched);
    return { ok: true };
  });

  /** Stop every run of this blueprint that is still going. */
  app.post('/api/blueprints/:id/stop', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!list.some((b) => b.id === id)) return reply.code(404).send({ error: 'No such blueprint.' });
    return { stopped: stopRuns(id, 'Stopped from the Blueprints screen.') };
  });

  app.get('/api/blueprints', async () => ({ ...present(), statuses: await statuses() }));

  app.post('/api/blueprints', async (request, reply) => {
    const body = (request.body ?? {}) as { template?: unknown; name?: unknown };
    const bp = newBlueprint(body.template, body.name);
    list.push(bp);
    try {
      save();
    } catch (error) {
      list.pop();
      return reply.code(409).send({ error: (error as Error).message });
    }
    spokenChanged();
    changes.emitChange(SCOPE);
    return reply.code(201).send(bp);
  });

  /*
   * Folders on the list. Removing one moves what was in it back to the top
   * rather than taking it away, the way the menu's folders do: a folder is an
   * arrangement, and deleting an arrangement should not delete the things.
   */
  const saveFolders = (reply: FastifyReply, undo: () => void): boolean => {
    try {
      save();
      changes.emitChange(SCOPE);
      return true;
    } catch (error) {
      undo();
      void reply.code(409).send({ error: (error as Error).message });
      return false;
    }
  };

  app.post('/api/blueprints/folders', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown };
    if (folders.length >= 100) return reply.code(400).send({ error: 'That is a hundred folders already.' });
    const folder: Folder = { id: newId(), name: folderName(body.name) };
    folders.push(folder);
    if (!saveFolders(reply, () => folders.pop())) return reply;
    return reply.code(201).send(folder);
  });

  app.put('/api/blueprints/folders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const folder = folders.find((f) => f.id === id);
    if (!folder) return reply.code(404).send({ error: 'No such folder.' });
    const was = folder.name;
    folder.name = folderName((request.body as { name?: unknown } | null)?.name);
    if (!saveFolders(reply, () => (folder.name = was))) return reply;
    return folder;
  });

  app.delete('/api/blueprints/folders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const at = folders.findIndex((f) => f.id === id);
    if (at === -1) return reply.code(404).send({ error: 'No such folder.' });
    const [gone] = folders.splice(at, 1);
    const moved = list.filter((b) => b.folder === id);
    for (const b of moved) b.folder = null;
    const undo = () => {
      folders.splice(at, 0, gone!);
      for (const b of moved) b.folder = id;
    };
    if (!saveFolders(reply, undo)) return reply;
    return reply.code(204).send();
  });

  app.put('/api/blueprints/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const bp = list.find((b) => b.id === id);
    if (!bp) return reply.code(404).send({ error: 'No such blueprint.' });
    const body = (request.body ?? {}) as { name?: unknown; enabled?: unknown; graph?: unknown; folder?: unknown };
    const before = JSON.stringify(bp);
    if (body.folder !== undefined) {
      if (body.folder !== null && !folders.some((f) => f.id === body.folder)) return reply.code(400).send({ error: 'There is no such folder.' });
      bp.folder = body.folder as string | null;
      // Where it is listed is not what it does: moving it is not an edit, and starts and stops nothing.
      if (body.name === undefined && body.enabled === undefined && body.graph === undefined) {
        try {
          save();
        } catch (error) {
          Object.assign(bp, JSON.parse(before));
          return reply.code(409).send({ error: (error as Error).message });
        }
        changes.emitChange(SCOPE);
        return bp;
      }
    }
    const wasOn = bp.enabled && !bp.stopped;
    const timedBefore = timing(bp);
    if (typeof body.name === 'string') bp.name = body.name.trim().slice(0, 80) || 'Untitled';
    if (typeof body.enabled === 'boolean') {
      bp.enabled = body.enabled;
      if (body.enabled) bp.stopped = null;
    }
    if (body.graph !== undefined) {
      const graph = cleanGraph(body.graph);
      // A wait in progress is a run of the old graph; carrying on would do
      // what the blueprint no longer says. Where the boxes sit is not what it
      // says, so dragging one about leaves a running repeat alone.
      if (behaviour(graph) !== behaviour(bp.graph)) stopRuns(bp.id, 'Stopped: the blueprint was changed while it was going.');
      bp.graph = graph;
    }
    if (!bp.enabled) stopRuns(bp.id, 'Stopped: the blueprint was switched off.');
    bp.updatedAt = Date.now();
    try {
      save();
    } catch (error) {
      Object.assign(bp, JSON.parse(before));
      return reply.code(409).send({ error: (error as Error).message });
    }
    // Switched on, or its timed boxes changed: a count from the start begins again.
    if ((bp.enabled && !wasOn) || timing(bp) !== timedBefore) startCount(bp);
    arm();
    wakeAgent();
    spokenChanged();
    changes.emitChange(SCOPE);
    return bp;
  });

  app.delete('/api/blueprints/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const at = list.findIndex((b) => b.id === id);
    if (at === -1) return reply.code(404).send({ error: 'No such blueprint.' });
    const [gone] = list.splice(at, 1);
    try {
      save();
    } catch (error) {
      list.splice(at, 0, gone!);
      return reply.code(409).send({ error: (error as Error).message });
    }
    stopRuns(id, 'Stopped: the blueprint was deleted.');
    bases.delete(id);
    // Its runs go with it: a log of a blueprint that is not there explains nothing.
    runs = runs.filter((r) => r.blueprint !== id);
    try {
      writeRuns(runs);
    } catch (error) {
      console.warn('[blueprints] could not write the run log:', (error as Error).message);
    }
    arm();
    wakeAgent();
    spokenChanged();
    changes.emitChange(SCOPE);
    return reply.code(204).send();
  });

  /**
   * Test (`dry`) from any event box: checks are asked for real, nothing is
   * done, and the answer is the path it would take. A real run only from a
   * "When I press Run" box, since starting "a match ends" by hand would be a
   * match that did not end.
   */
  app.post('/api/blueprints/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    const bp = list.find((b) => b.id === id);
    if (!bp) return reply.code(404).send({ error: 'No such blueprint.' });
    const body = (request.body ?? {}) as { from?: unknown; dry?: unknown };
    const dry = body.dry !== false;
    const events = bp.graph.nodes.filter((n) => specOf(n.type)?.kind === 'event');
    const from = events.find((n) => n.id === body.from) ?? (dry ? events[0] : events.find((n) => n.type === 'on-button'));
    if (!from) {
      return reply.code(400).send({
        error: dry ? 'There is no "When" box to start from.' : 'Running by hand needs a "When I press Run" box.',
      });
    }
    if (!dry && from.type !== 'on-button') return reply.code(400).send({ error: 'Only a "When I press Run" box can be started by hand.' });
    if (!dry && recentRuns(bp.id, Date.now()) >= RUNS_PER_WINDOW) {
      return reply.code(429).send({ error: `It has run ${RUNS_PER_WINDOW} times in ten minutes already.` });
    }
    // A run by hand that waits or repeats would hold this request open for it,
    // so it is started and the run handed back as it stands.
    if (!dry && bp.graph.nodes.some((n) => n.type === 'wait' || n.type === 'repeat' || n.type === 'ask')) {
      void start(bp, from.id, {}, false);
      return { started: true };
    }
    return start(bp, from.id, dry ? await sampleVars(bp, from.id) : {}, dry);
  });
}
