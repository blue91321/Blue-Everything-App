/**
 * Blueprints, on the PC: hear the hotkeys a blueprint starts from, and do the
 * few things a blueprint does that only the PC can: press keys, open a
 * website, press a media key, start a game, and show a popup or ask a
 * question in it. Nothing else.
 *
 * The blueprint itself runs on the server, which cannot see a keyboard and is
 * meant to move to Docker where there is none. So this half asks the server,
 * in a long poll, which hotkeys to listen for and which keys to press, and says
 * on its next ask what it pressed. A press therefore reaches the keyboard in a
 * few milliseconds, and an idle agent makes one request every twenty seconds.
 *
 * Deleting the package folder takes this with it. `startBlueprints` is called
 * by the agent behind a dynamic import, as voice and integrations are.
 */
import { ServerUnreachable, type ServerClient } from '../../../agent/src/client.js';
import { createHotkeys, HotkeysUnavailable, type Hotkeys } from '../../../agent/src/hotkeys.js';
import * as popup from '../../../agent/src/popup.js';
import { existsSync } from 'node:fs';
import { playSoundFile, playTone, playWavBytes, TONE_NAMES, type ToneName } from '../../../agent/src/sound.js';
import { designWav, localSoundPath } from '../web/sound-design.js';
import type { TimelineBar } from '../web/keys.js';
import { isHeld, playTimeline, press } from './keys.js';
import { launch, openUrl, pressMediaKey } from './machine.js';
import { createWatcher, type Watched } from './watch.js';

/** How long the server may hold a poll open. Under its own 25-second cap. */
const WAIT_MS = 20_000;
/** With the package switched off on the server the route is not there: ask rarely. */
const NOT_THERE_MS = 5 * 60_000;

/** Something to do on this PC, as the server's `AgentTask`, with the id to report it by. */
type Task =
  | { id: string; do: 'keys'; keys: string; hold: number }
  | { id: string; do: 'url'; url: string }
  | { id: string; do: 'media'; action: string }
  | { id: string; do: 'launch'; name: string; path?: string; url?: string }
  | { id: string; do: 'timeline'; bars: TimelineBar[]; totalMs: number }
  | { id: string; do: 'check' }
  | { id: string; do: 'held'; keys: string }
  | { id: string; do: 'popup'; title: string; body: string; color: string; seconds: number; sound?: string; volume?: number }
  | { id: string; do: 'tone'; tone: string; volume?: number }
  | { id: string; do: 'sound'; fields: Record<string, string | number> }
  | { id: string; do: 'sound-file'; path: string; volume?: number }
  | { id: string; do: 'ask'; ask: string; title: string; body: string; placeholder: string; color: string; seconds: number }
  | { id: string; do: 'unask'; ask: string };

interface Answer {
  version: string;
  hotkeys: string[];
  /** Keys and buttons to watch, each for one game. Absent from a server older than it. */
  watch?: Watched[];
  tasks: Task[];
}

/** A popup's lines from a box's "More": one a line, and none for nothing. */
const linesOf = (body: string) =>
  body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((text) => ({ text }));

async function perform(task: Task, checkNow: () => void): Promise<boolean | number | void> {
  // A nudge was just queued: report now, so it shows now rather than next heartbeat.
  if (task.do === 'check') return checkNow();
  if (task.do === 'popup') {
    // A box older than its sound field says nothing, and keeps the nudge sound it always had; "none" is silent.
    const tone = task.sound === undefined ? null : task.sound;
    popup.show({ title: task.title, lines: linesOf(task.body), accent: task.color || undefined, forMs: task.seconds * 1000, sound: tone === null ? 'nudge' : undefined });
    if (tone && tone !== 'none' && (TONE_NAMES as string[]).includes(tone)) playTone(tone as ToneName, task.volume ?? 50);
    return;
  }
  if (task.do === 'unask') return popup.cancelAsk(task.ask);
  if (task.do === 'tone') {
    if (!(TONE_NAMES as string[]).includes(task.tone) || task.tone === 'none') throw new Error(`there is no sound called ${task.tone}`);
    return playTone(task.tone as ToneName, task.volume ?? 50);
  }
  if (task.do === 'sound') {
    const bytes = designWav(task.fields);
    if (!bytes) throw new Error('that is not a sound this can make');
    return playWavBytes(bytes);
  }
  if (task.do === 'sound-file') {
    // Checked again here: the server is one more thing that could be wrong about it.
    const path = localSoundPath(task.path);
    if (!path) throw new Error('only a .wav or .mp3 on one of this PC\'s own drives can be played');
    if (!existsSync(path)) throw new Error(`there is no file at ${path}`);
    return playSoundFile(path, task.volume ?? 100);
  }
  if (task.do === 'held') return isHeld(task.keys);
  if (task.do === 'keys') return press(task.keys, task.hold);
  if (task.do === 'timeline') return playTimeline(task.bars);
  if (task.do === 'url') return openUrl(task.url);
  if (task.do === 'media') return pressMediaKey(task.action);
  if (task.do === 'launch') return launch(task);
  throw new Error('nothing here knows how to do that');
}

export function startBlueprints(
  client: ServerClient,
  log: (message: string) => void,
  /** Check in with the server at once. Absent from an agent older than it. */
  checkNow: () => void = () => {}
): { stop(): void } {
  let stopped = false;
  let version = '';
  let problems: string[] = [];
  let done: Array<{ id: string; error?: string; value?: boolean | number }> = [];
  let resting: NodeJS.Timeout | null = null;

  let hotkeys: Hotkeys | null = null;
  try {
    hotkeys = createHotkeys('EverythingBlueprintHotkeys', (keys) => {
      void client
        .send('/api/blueprints/hotkey', { method: 'POST', body: JSON.stringify({ keys }) })
        .catch((error: Error) => log(`blueprints: could not report ${keys}: ${error.message}`));
    });
  } catch (error) {
    // No desktop (a service account): presses still work, hotkeys cannot.
    if (!(error instanceof HotkeysUnavailable)) throw error;
    log(`blueprints: hotkeys unavailable (${error.message})`);
  }

  const watcher = createWatcher((keys, up) => {
    void client
      .send('/api/blueprints/hotkey', { method: 'POST', body: JSON.stringify({ keys, watched: true, ...(up ? { up } : {}) }) })
      .catch((error: Error) => log(`blueprints: could not report ${keys}: ${error.message}`));
  });

  const rest = (ms: number) =>
    new Promise<void>((resolve) => {
      resting = setTimeout(resolve, ms);
      resting.unref();
    });

  async function loop(): Promise<void> {
    let backoff = 2000;
    while (!stopped) {
      try {
        const answer = await client.send<Answer>(
          '/api/blueprints/agent',
          { method: 'POST', body: JSON.stringify({ version, waitMs: WAIT_MS, problems, done }) },
          WAIT_MS + 10_000
        );
        done = [];
        if (answer.version !== version) {
          version = answer.version;
          hotkeys?.apply(answer.hotkeys.map((keys) => ({ id: keys, combo: keys })));
          problems = hotkeys ? hotkeys.problems() : answer.hotkeys.length ? ['This PC has no desktop to listen for hotkeys on.'] : [];
          if (answer.hotkeys.length) log(`blueprints: listening for ${answer.hotkeys.join(', ')}`);
          const watch = answer.watch ?? [];
          watcher.apply(watch);
          if (watch.length) log(`blueprints: watching ${watch.map((w) => `${w.keys} in ${w.game}`).join(', ')}`);
        }
        // One at a time, in the order asked: a macro's presses must not overlap.
        for (const task of answer.tasks ?? []) {
          /*
           * A question can wait minutes for an answer, and the presses behind it
           * must not wait with it: it is put up, and the answer goes back on its
           * own request the moment it is given, not on the next ask, which may
           * sit for twenty seconds.
           */
          if (task.do === 'ask') {
            void popup
              .ask({
                id: task.ask,
                title: task.title,
                lines: linesOf(task.body),
                placeholder: task.placeholder || undefined,
                accent: task.color || undefined,
                forMs: task.seconds * 1000,
                sound: 'nudge',
              })
              .then((reply) => client.send('/api/blueprints/answer', { method: 'POST', body: JSON.stringify({ ask: task.ask, answer: reply }) }))
              .catch((error: Error) => log(`blueprints: could not send an answer back: ${error.message}`));
            continue;
          }
          try {
            const value = await perform(task, checkNow);
            done.push(typeof value === 'boolean' || typeof value === 'number' ? { id: task.id, value } : { id: task.id });
          } catch (error) {
            done.push({ id: task.id, error: (error as Error).message });
          }
        }
        backoff = 2000;
      } catch (error) {
        if (stopped) return;
        const notThere = !(error instanceof ServerUnreachable) && / 40[34] /.test((error as Error).message);
        await rest(notThere ? NOT_THERE_MS : backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  void loop();

  return {
    stop() {
      stopped = true;
      if (resting) clearTimeout(resting);
      hotkeys?.destroy();
      watcher.stop();
    },
  };
}
