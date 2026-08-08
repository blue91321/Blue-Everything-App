/**
 * Voice, as one removable piece of the agent.
 *
 * Everything that holds a microphone, loads a speech model, draws the popup or
 * presses a key lives under this folder — including `actions.ts`, which is the
 * most dangerous file in the project, and the ~150MB of models in `models/`.
 * Deleting the folder takes all of it: the capability, the disk, and the 198MB
 * the models occupy while listening.
 *
 * That is the point of putting `actions.ts` here rather than in core. It exists
 * only to carry out spoken commands, so an install with no voice has no reason
 * to carry code that can press keys into whatever window has focus.
 *
 * `startVoice()` is called by the agent behind a dynamic import it is allowed
 * to fail. Nothing in core imports this file by name.
 */
import {
  VOICE_ENROL_SAMPLES,
  averageVoiceprint,
  cosineSimilarity,
  type VoiceHeard,
} from '@everything/shared';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ServerUnreachable, type ServerClient, type VoiceConfig, type VoiceOutcome } from '../../client.js';
import { mediaIsPlaying } from '../../audio.js';
import { openUrl, pressKeys, pressMediaKey } from './actions.js';
import { listScreens, forgetAvatar, type Avatar, type Placement } from '../../overlay.js';
// The popup is core now, and voice is one of its callers rather than its owner.
// Nudges use the same window, which is the point: it is the only surface here
// that draws above an exclusive-fullscreen game.
import * as popup from '../../popup.js';
import { createVoiceListener } from './voice.js';
import { unknownWords, VoskUnavailable } from './vosk.js';

const OVERLAY_RESULT_MS = popup.POPUP_RESULT_MS;
const OVERLAY_ASK_MS = popup.POPUP_ASK_MS;

const TONE_FOR: Record<string, 'good' | 'bad' | 'muted'> = {
  'habit-checked': 'good',
  'note-added': 'good',
  opened: 'good',
  'keys-sent': 'good',
  paused: 'muted',
  cancelled: 'muted',
  'captured-as-note': 'muted',
  'no-match': 'bad',
};

/**
 * Voice state is long-polled, not polled.
 *
 * The agent has no live connection to the server, so it has to ask. Asking on a
 * timer traded latency for request rate and lost both ways: at 10 seconds, a
 * third of a test window was gone before the microphone was listening, and it
 * still cost a request every 10 seconds forever.
 *
 * So the request is held open by the server until something actually changes.
 * Pressing "Test it" now reaches the microphone in milliseconds, and an idle
 * agent makes *fewer* requests than before, not more.
 *
 * The exception is while a test is running, where the screen is showing a live
 * level meter and needs frequent readings rather than a held connection.
 */
const VOICE_WAIT_MS = 20_000;
const VOICE_TEST_POLL_MS = 400;

/** Switched off: enough to release the device, nothing to listen for. */
const EMPTY_VOICE_CONFIG: VoiceConfig = {
  enabled: false,
  wakeWord: '',
  requireKnownSpeaker: false,
  speakerThreshold: 1,
  voiceprint: null,
  vocabulary: [],
  version: '',
};

/**
 * Long enough for the listener to have opened the new device, short enough that
 * the screen doesn't look stuck. Several ticks of the 100ms loop.
 */
const VOICE_SETTLE_MS = 600;

/** Backoff while the server is down, so a stopped server isn't a hot loop. */
const VOICE_RETRY_MS = 15_000;

export interface VoiceFeature {
  stop(): void;
}

/**
 * Start listening.
 *
 * `clock` is passed in rather than redefined so every line the agent logs looks
 * the same whichever half of it produced the line.
 */
export function startVoice(client: ServerClient, clock: () => string): VoiceFeature {
  // The popup itself belongs to core and is already running; voice only claims
  // the click handler, since it is the only thing that ever offers a choice.
  popup.onChoiceMade((id) => void chooseCommand(id));

  /**
   * Whether a media command is allowed to fire right now.
   *
   * The whole point of the guard: with an always-on microphone, a mis-heard word
   * skipping a track in a silent room is worse than most misfires because there
   * is nothing to notice. If the output meter says nothing has played, the
   * command does not go out.
   *
   * Checked here rather than on the server because only this process can see the
   * meter — and it is the same reading `attention.ts` already takes, so it costs
   * nothing extra.
   */
  function mediaAllowed(): boolean {
    try {
      return mediaIsPlaying();
    } catch {
      // No sound card, or COM refused. An unknown answer is not a yes for
      // something that presses keys.
      return false;
    }
  }

  function performAction(result: VoiceOutcome): void {
    // A chained outcome's instructions live on its parts, in the order they were
    // said. Run them in that order: "pause the music and open my notes" should
    // not decide for itself which happens first.
    if (result.steps?.length) {
      for (const step of result.steps) performAction(step);
      return;
    }

    // Anything that touches *this machine* comes back as an instruction; the
    // server does the database half itself. It has no business assuming it runs
    // on your desk, and one day it won't.
    if (!result.action) return;
    try {
      if (result.action.do === 'open-url') openUrl(result.action.url);
      if (result.action.do === 'press-keys') pressKeys(result.action.keys);

      if (result.action.do === 'media') {
        if (!mediaAllowed()) {
          console.log(`[${clock()}] media ignored — nothing is playing`);
          popup.show({
            title: 'Nothing is playing',
            lines: [{ text: `so "${result.text}" was ignored`, tone: 'muted' }],
          });
          popup.hide(OVERLAY_RESULT_MS);
          return;
        }
        pressMediaKey(result.action.action);
      }
      // Drop whatever was in progress, but leave the microphone open — the wake
      // word works again straight away, which is the whole difference from pause.
      if (result.action.do === 'cancel') voice.cancelExchange();
      // A pause needs nothing here: the server has recorded it, and the next
      // long-poll answer reports voice as disabled, which closes the microphone.
    } catch (error) {
      console.error(`[${clock()}] voice action refused: ${(error as Error).message}`);
      popup.show({ title: 'Refused', lines: [{ text: (error as Error).message, tone: 'bad' }] });
      popup.hide(OVERLAY_RESULT_MS);
    }
  }

  function showResult(result: VoiceOutcome): void {
    console.log(`[${clock()}] voice (${result.outcome}): ${result.say ?? `"${result.text}"`}`);

    if (result.outcome === 'ambiguous' && result.choices?.length) {
      popup.show({
        title: 'Which one?',
        lines: [{ text: result.say ?? 'That matches more than one thing.', tone: 'muted' }],
        choices: result.choices,
      });
      popup.hide(OVERLAY_ASK_MS);
      return;
    }

    /*
     * A chain gets a line each, not one run-together summary.
     *
     * The point of showing anything at all is that you can tell at a glance
     * whether it did what you said. "Drink water · Skip forward" as a single
     * title reads as one odd command; two lines read as two things that
     * happened, and a part that failed stands out in its own colour instead of
     * being buried mid-sentence.
     */
    /*
     * The sound says the same thing as the colour, for the case the popup is
     * behind a fullscreen game or simply not being looked at. A miss gets its
     * own falling tone rather than silence, because "it did nothing" and "it
     * never heard you" are the two outcomes worth telling apart without looking.
     */
    const sound = result.outcome === 'no-match' ? 'miss' : 'ok';

    if (result.steps?.length) {
      popup.show({
        title: `Heard ${result.steps.length} things`,
        lines: result.steps.map((step) => ({
          text: step.say ?? step.text,
          tone: TONE_FOR[step.outcome] ?? 'muted',
        })),
        sound,
      });
    } else {
      popup.show({
        title: result.say ?? result.text,
        // Coloured by outcome, so a miss does not look like a success at a glance —
        // which matters most for the ones that changed nothing.
        lines: [{ text: `heard "${result.text}"`, tone: TONE_FOR[result.outcome] ?? 'muted' }],
        sound,
      });
    }

    /*
     * How long to stay open depends on what just happened.
     *
     *  - a hit: you may add a second thing, so the follow-up window — unless
     *    this command asked not to, which is what `allowFollowUp` is for.
     *  - a miss: you are about to repeat yourself, which takes longer. Once only.
     *  - a pause: you asked for silence, so carrying on would be perverse.
     */
    const failed = result.outcome === 'no-match';
    // A chain reports itself as `chained`, so an ending buried in one of its
    // parts — "never mind and stop listening" — would otherwise be missed and
    // the microphone would be reopened on top of a pause that just closed it.
    const ends = (outcome: VoiceOutcome): boolean =>
      outcome.outcome === 'paused' ||
      outcome.outcome === 'ambiguous' ||
      outcome.outcome === 'cancelled' ||
      (outcome.steps ?? []).some(ends);

    const followUp = ends(result)
      ? 0
      : failed
        ? retryUsed
          ? 0
          : retryMs
        : result.allowFollowUp === false
          ? 0
          : followUpMs;

    if (failed) retryUsed = true;
    if (followUp > 0) voice.listenAgain(followUp);

    // The window stays up for as long as it is still listening, so "it is waiting
    // for me" and "it has finished" are never the same picture.
    popup.hide(result.outcome === 'cancelled' ? 900 : Math.max(OVERLAY_RESULT_MS, followUp));
  }

  async function chooseCommand(id: string): Promise<void> {
    try {
      const result = await client.runVoiceCommand(id);
      performAction(result);
      showResult(result);
    } catch (error) {
      console.error(`[${clock()}] could not run that: ${(error as Error).message}`);
    }
  }

  const voice = createVoiceListener((heard) => {
    if (!heard.accepted) {
      const why = heard.reason === 'wrong-speaker' ? "didn't sound like you" : 'no voice sample to check against';
      console.log(`[${clock()}] voice ignored (${why}): "${heard.text}"`);
      popup.show({ title: 'Not you', lines: [{ text: why, tone: 'bad' }] });
      popup.hide(2000);
      return;
    }

    client
      .voiceCommand({ text: heard.text, speakerScore: heard.speakerScore })
      .then((result) => {
        performAction(result);
        showResult(result);
      })
      .catch((error) => console.error(`[${clock()}] voice command failed: ${(error as Error).message}`));
  });

  // An EventEmitter with no `error` listener throws on emit, which would take the
  // whole agent down because a microphone was unplugged.
  voice.on('error', (error: Error) => {
    console.error(`[${clock()}] voice: ${error.message}`);
    if (error instanceof VoskUnavailable) {
      console.error('         voice is off until this is fixed — run: npm run voice-setup -w @everything/agent');
    }
  });

  voice.on('wake', ({ speakerScore }: { speakerScore: number | null }) => {
    const score = speakerScore === null ? '' : ` (voice match ${(speakerScore * 100).toFixed(0)}%)`;
    console.log(`[${clock()}] listening…${score}`);
    // A fresh wake is a new exchange, so the one retry is available again.
    retryUsed = false;
    // `forMs: 0` because the result replaces this and `missed` covers trailing
    // off — a timer here would take the window away while it is still listening.
    popup.show({
      title: 'Listening…',
      lines: [{ text: 'go ahead', tone: 'muted' }],
      forMs: 0,
      sound: 'wake',
    });
  });

  // Woke, but nothing usable followed — take the window away rather than leaving
  // "Listening…" on screen for a question that was never asked.
  voice.on('missed', () => {
    if (!popup.visible()) return;

    // Woke but caught nothing — the same failure as a no-match, and it gets the
    // same one retry rather than closing the moment you pause to think.
    const retry = retryUsed ? 0 : retryMs;
    retryUsed = true;

    popup.show({
      title: "Didn't catch that",
      lines: [{ text: retry > 0 ? 'say it again' : 'say the wake word to try again', tone: 'muted' }],
      sound: 'miss',
    });
    if (retry > 0) voice.listenAgain(retry);
    popup.hide(Math.max(2000, retry));
  });

  // During a test the screen is showing what the agent hears, so it is posted the
  // moment it happens rather than waiting for the next heartbeat.
  voice.on('heard', (event: VoiceHeard) => {
    client.voiceHeard(event).catch(() => {});
  });

  /* ---------------- enrolment ---------------- */

  let enrolSamples: number[][] = [];
  let enrolAgreement: number | null = null;

  voice.on('enrol-short', ({ frames }: { frames: number }) => {
    console.log(`[${clock()}] enrol: too short to measure (${frames} frames)`);
    popup.show({
      title: `Teaching it your voice — ${enrolSamples.length} of ${VOICE_ENROL_SAMPLES}`,
      lines: [{ text: 'that was too short — say it a little slower', tone: 'bad' }],
    });
  });

  voice.on('enrol-sample', ({ embedding }: { embedding: number[] }) => {
    // Measured against the running mean, so drift shows up while there is still
    // time to start over rather than after the voiceprint is stored.
    enrolAgreement =
      enrolSamples.length > 0 ? cosineSimilarity(embedding, averageVoiceprint(enrolSamples)) : null;
    enrolSamples.push(embedding);

    const count = enrolSamples.length;
    console.log(`[${clock()}] enrol: ${count}/${VOICE_ENROL_SAMPLES}`);

    popup.show({
      title: `Teaching it your voice — ${count} of ${VOICE_ENROL_SAMPLES}`,
      lines: [
        { text: count < VOICE_ENROL_SAMPLES ? 'say it again' : 'that is enough — saving', tone: 'muted' },
        ...(enrolAgreement === null
          ? []
          : [
              {
                text: `consistency ${Math.round(enrolAgreement * 100)}%`,
                tone: enrolAgreement < 0.5 ? 'bad' : 'good',
              } as const,
            ]),
      ],
    });

    if (count < VOICE_ENROL_SAMPLES) return;

    const voiceprint = averageVoiceprint(enrolSamples);
    const spread = enrolSamples.map((sample) => cosineSimilarity(sample, voiceprint));
    const worst = Math.min(...spread);
    enrolSamples = [];

    client
      .enrolVoice(voiceprint, VOICE_ENROL_SAMPLES)
      .then(() => {
        console.log(`[${clock()}] enrol: stored, worst sample ${Math.round(worst * 100)}%`);
        popup.show({
          title: 'Voice learned',
          lines:
            worst < 0.5
              ? [{ text: 'those varied a lot — enrol again somewhere quieter', tone: 'bad' }]
              : [{ text: `only your voice will be obeyed now`, tone: 'good' }],
        });
        popup.hide(5000);
      })
      .catch((error) => {
        console.error(`[${clock()}] enrol failed: ${(error as Error).message}`);
        popup.show({ title: 'Could not save', lines: [{ text: (error as Error).message, tone: 'bad' }] });
        popup.hide(5000);
      });
  });

  /* ---------------- the heartbeat ---------------- */

  let voiceVersion = 0;
  let appliedVoice = '';

  /**
   * Phrase words the model cannot pronounce, recomputed when the vocabulary
   * changes. Sent on the next heartbeat so the Voice screen can name them.
   */
  let missingWords: string[] = [];
  let missingCheckedFor = '';
  /** Mirrored from settings so `showResult` can size the overlay's stay. */
  let followUpMs = 0;
  /** The same, for a miss rather than a hit. */
  let retryMs = 0;

  /**
   * Whether the retry after a miss has already been spent this exchange.
   *
   * Reopening on *every* failure would let one misheard cough hold the microphone
   * open forever: nothing said, retry, nothing said, retry. One retry per wake,
   * reset when the wake word actually fires again.
   */
  let retryUsed = false;

  /**
   * The screen list is read live rather than cached.
   *
   * Monitors get plugged in, and the whole reason the settings screen shows a
   * list is that it changes — one captured at startup is the one guaranteed to be
   * wrong. Cheap enough: it runs on the voice heartbeat, not per frame.
   */
  function screensFor(): { id: string; label: string; primary: boolean }[] {
    try {
      return listScreens().map(({ id, label, primary }) => ({ id, label, primary }));
    } catch {
      // A session with no desktop. An empty list says that honestly.
      return [];
    }
  }

  /** Where the downloaded avatar lands, and which version is already there. */
  const avatarFile = resolve(tmpdir(), 'everything-voice-avatar');
  let avatarAt = 0;
  let overlayLook = '';

  /**
   * Push placement and avatar into the window, downloading the picture if it is
   * new. Only does work when something actually changed — this runs on every
   * heartbeat, and re-decoding a PNG twice a minute forever would be silly.
   */
  async function applyOverlayLook(answer: {
    overlayPlacement?: string;
    overlayScreen?: string | null;
    overlayAvatar?: string;
    avatarVersion?: number;
  }): Promise<void> {
    const signature = `${answer.overlayPlacement}:${answer.overlayScreen}:${answer.overlayAvatar}:${answer.avatarVersion}`;
    if (signature === overlayLook) return;
    overlayLook = signature;

    let avatar: Avatar = { kind: 'none', value: '' };

    if (answer.overlayAvatar === 'file') {
      try {
        if ((answer.avatarVersion ?? 0) !== avatarAt) {
          const bytes = await client.avatarImage();
          await writeFile(avatarFile, bytes);
          avatarAt = answer.avatarVersion ?? 0;
          // The path is reused, so the decoded copy has to be thrown away or the
          // old picture would keep being drawn from cache.
          forgetAvatar(avatarFile);
        }
        avatar = { kind: 'image', value: avatarFile };
      } catch (error) {
        console.error(`[${clock()}] could not fetch the avatar: ${(error as Error).message}`);
      }
    } else if (answer.overlayAvatar) {
      avatar = { kind: 'emoji', value: answer.overlayAvatar };
    }

    popup.configure({
      placement: {
        mode: (answer.overlayPlacement ?? 'cursor') as Placement,
        screen: answer.overlayScreen ?? null,
      },
      avatar,
    });
  }

  let voiceLoopStopped = false;

  async function voiceTick(): Promise<number> {
    const status = voice.status();
    // Both modes want a live screen rather than a held connection.
    const busy = Math.max(voice.testingUntil ?? 0, voice.enrolUntil ?? 0) > Date.now();

    const answer = await client.voiceAgentReport({
      listening: status.listening,
      device: status.device,
      devices: status.devices,
      screens: screensFor(),
      unknownWords: missingWords,
      error: status.error,
      peak: status.peak,
      // While testing or enrolling the screen wants live progress, so ask now.
      waitMs: busy ? 0 : VOICE_WAIT_MS,
      since: voiceVersion,
      enrolSamples: enrolSamples.length,
      enrolAgreement,
    });

    voiceVersion = answer.version;
    followUpMs = answer.followUpMs ?? 0;
    /*
     * This assignment was missing before this file existed, which made
     * `voiceRetrySeconds` dead: the server computed it and sent it, the slider
     * on the Voice tab wrote it, and the agent read `retryMs` in three places —
     * but nothing ever put the answer into it, so it was always 0 and "reopen
     * the microphone after a miss" silently never happened.
     *
     * It presented as the feature simply not working rather than as an error,
     * which is why it survived: a retry that does not happen looks exactly like
     * a retry that was not configured.
     */
    retryMs = answer.retryMs ?? 0;
    await applyOverlayLook(answer);

    // The vocabulary is the expensive half of the payload and only changes when a
    // phrase does, so it is fetched only when there is something to listen for.
    // Rebuilding the recognisers is separately guarded by its own `version`.
    if (answer.enabled) {
      const full = await client.voiceConfig();

      /*
       * Which phrase words the model cannot pronounce.
       *
       * Only when the vocabulary actually changed, and only while voice is on:
       * the lookup needs the speech model loaded, and loading 130MB to answer a
       * question nobody asked would be a poor trade.
       */
      if (full.version !== missingCheckedFor) {
        missingCheckedFor = full.version;
        try {
          missingWords = unknownWords(full.checkWords ?? full.vocabulary);
          if (missingWords.length > 0) {
            console.log(`[${clock()}] cannot be recognised: ${missingWords.join(', ')}`);
          }
        } catch {
          missingWords = [];
        }
      }

      voice.configure({ ...full, ...answer });
    } else {
      voice.configure({ ...EMPTY_VOICE_CONFIG, wakeWord: answer.wakeWord ?? '' });
    }

    /*
     * A report is gathered *before* the config that arrives with it is applied,
     * so a settings change would be visible one round trip late. That reads as
     * "the microphone I just picked didn't take" — the exact doubt this screen
     * was added to remove. When something actually changed, report again once the
     * new device has had a moment to open.
     */
    const signature = `${answer.enabled}:${answer.inputDevice ?? ''}:${answer.wakeWord ?? ''}`;
    const changed = signature !== appliedVoice;
    appliedVoice = signature;

    if (answer.testUntil > Date.now() || (answer.enrolUntil ?? 0) > Date.now()) return VOICE_TEST_POLL_MS;

    // Leaving enrolment with a half-collected set would silently poison the next
    // attempt, which would then average two different sittings together.
    if (enrolSamples.length > 0 && (answer.enrolUntil ?? 0) === 0) {
      enrolSamples = [];
      enrolAgreement = null;
    }

    return changed ? VOICE_SETTLE_MS : 0;
  }

  /**
   * Self-scheduling rather than an interval: each pass decides when the next one
   * happens, and a held-open request must never overlap the one behind it.
   */
  async function voiceLoop(): Promise<void> {
    while (!voiceLoopStopped) {
      let delay = VOICE_RETRY_MS;
      try {
        delay = await voiceTick();
      } catch (error) {
        // Quiet: the attention loop already reports an unreachable server, and
        // voice should not double up on that noise.
        if (!(error instanceof ServerUnreachable)) {
          console.error(`[${clock()}] could not read voice settings: ${(error as Error).message}`);
        }
      }
      if (delay > 0) await new Promise((done) => setTimeout(done, delay).unref());
    }
  }

  void voiceLoop();

  return {
    stop() {
      voiceLoopStopped = true;
      voice.stop();
      // The popup is core and outlives this feature — nudges still use it. Only
      // the click handler was ours, so it goes back to doing nothing.
      popup.onChoiceMade(() => {});
    },
  };
}
