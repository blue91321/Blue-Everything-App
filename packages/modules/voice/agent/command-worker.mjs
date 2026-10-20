/**
 * The command recogniser, on a thread of its own.
 *
 * Plain JavaScript rather than TypeScript because a worker is started from a
 * file path, and whether `--import tsx` reaches a worker is one more thing that
 * can silently fail and leave voice deaf. This file is small, has one job, and
 * speaks a four-message protocol with `engine.ts`, which is typed.
 *
 * **Why a thread at all.** The model takes about 1.4s to load, and the
 * microphone's ring is eight 100ms buffers — 800ms. Loading it on the main
 * thread would drop the start of the very command it was loaded for, and freeze
 * the popup and the tray while it did. Here the load happens beside the
 * listener, and whatever arrives meanwhile waits in this thread's message queue:
 * the audio is buffered by the port, for free, in order.
 *
 * **And why it can end.** The JS binding has no explicit free; memory goes back
 * when the objects are collected. Terminating the thread is the one way to get
 * all of it back at a moment of our choosing — measured, 196MB → 55MB — which is
 * what lets "keep it for ten minutes after the last use" mean something.
 *
 * Protocol, in:  { type: 'audio', gen, samples: Float32Array }
 *                { type: 'reset', gen }
 * Protocol, out: { type: 'ready', ms }
 *                { type: 'partial', gen, words }
 *                { type: 'final', gen, words }
 *                { type: 'error', message }
 *
 * `words` is `[{ text, at }]`, `at` in seconds from the start of the stream —
 * which is what lets the listener drop the wake word by *when* it was said
 * rather than by what the recogniser thought it was.
 */

import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16000;

/**
 * The recogniser's tokens as words, each with when it started.
 *
 * A token opening with a space starts a word; anything else continues one,
 * punctuation included. Timestamps are per segment, so the segment's own start
 * is added: the stream is reset at every endpoint and the clock is not.
 */
function wordsOf(result) {
  const words = [];
  const base = result.start_time ?? 0;
  result.tokens.forEach((token, i) => {
    if (token.startsWith(' ') || words.length === 0) words.push({ text: token.trim(), at: base + (result.timestamps[i] ?? 0) });
    else words[words.length - 1].text += token;
  });
  return words.filter((word) => word.text);
}

let recogniser;
let stream;
let gen = 0;
let lastPartial = '';

try {
  const started = performance.now();
  const sherpa = require('sherpa-onnx-node');
  const model = workerData.model;
  recogniser = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
      tokens: model.tokens,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: 1,
    /*
     * The three endpoint rules. 2.4s of silence before anything is said ends an
     * empty utterance; 0.8s after speech ends a real one, which is what makes a
     * command land promptly; and nothing runs past 20s.
     */
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 0.8,
    rule3MinUtteranceLength: 20,
  });
  stream = recogniser.createStream();
  parentPort.postMessage({ type: 'ready', ms: Math.round(performance.now() - started) });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
}

parentPort.on('message', (message) => {
  if (!recogniser) return;

  if (message.type === 'reset') {
    gen = message.gen;
    // A fresh stream rather than `reset`, so nothing of the last exchange —
    // including half-decoded audio still inside the model's context — leaks into
    // the next one.
    stream = recogniser.createStream();
    lastPartial = '';
    return;
  }

  if (message.type !== 'audio' || message.gen !== gen) return;

  stream.acceptWaveform({ samples: message.samples, sampleRate: SAMPLE_RATE });
  while (recogniser.isReady(stream)) recogniser.decode(stream);

  const result = recogniser.getResult(stream);
  if (recogniser.isEndpoint(stream)) {
    parentPort.postMessage({ type: 'final', gen, words: wordsOf(result) });
    recogniser.reset(stream);
    lastPartial = '';
  } else if (result.text !== lastPartial) {
    lastPartial = result.text;
    parentPort.postMessage({ type: 'partial', gen, words: wordsOf(result) });
  }
});
