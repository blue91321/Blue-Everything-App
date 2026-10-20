/**
 * Prove the recognisers work, without saying anything.
 *
 *   npm run voice-try -w @everything/agent
 *   npm run voice-try -w @everything/agent -- "i drank two waters"
 *
 * `voice-setup` answers "are the models here and is the microphone live". This
 * answers the next question — *does it actually recognise anything* — which
 * otherwise needs a person in the chair repeating a phrase at a log.
 *
 * Windows' own speech synthesiser writes the audio. It proves nothing about the
 * speaker check, since it is not your voice, but it does prove the speaker model
 * loads and produces an embedding of the right length.
 */
import {
  matchVoiceCommand,
  spokenCount,
  VOICEPRINT_DIMENSIONS,
  wakeWordRequired,
  type VoiceCandidate,
} from '@everything/shared';
import { ServerClient } from '../../../../agent/src/client.js';
import { speakerEmbedding, toFloat } from '../engine.js';
import { cleanUp, say, spot, transcribe } from './speech-test.js';

try {
  const client = new ServerClient();
  const config = await client.voiceConfig();
  const habits = await client.habits();

  const candidates: VoiceCandidate[] = habits
    .filter((habit) => habit.active && habit.voicePhrases.length > 0)
    .map((habit) => ({ id: habit.id, phrases: habit.voicePhrases }));

  const wakeWord = config.wakeWord.toLowerCase();
  const phrases = [...new Set([wakeWord, wakeWordRequired(wakeWord).join(' ')])];
  console.log(`\nWake word: "${config.wakeWord}"\n`);

  /* The wake word, and something that isn't it. */
  console.log('Wake spotter');
  const wakeAudio = say(config.wakeWord);
  const woke = spot(wakeAudio, phrases);
  console.log(`  said the wake word        -> ${woke.length ? `heard "${woke[0].phrase}" at ${woke[0].atMs}ms` : 'NOTHING'}`);
  const unrelated = spot(say('the quarterly report is due on friday'), phrases);
  console.log(`  said something unrelated  -> ${unrelated.length ? `woke as "${unrelated[0].phrase}" <- SHOULD NOT` : '(correctly ignored)'}`);

  const embedding = speakerEmbedding(toFloat(wakeAudio));
  console.log(
    `  speaker embedding         -> ${embedding ? `${embedding.length} dimensions${embedding.length === VOICEPRINT_DIMENSIONS ? '' : ` <- EXPECTED ${VOICEPRINT_DIMENSIONS}`}` : 'NONE — is speaker.onnx there?'}`
  );

  /* The command. */
  const phrase = process.argv[2] ?? candidates[0]?.phrases[0] ?? 'i drank two waters';
  console.log('\nCommand recogniser');
  const heard = await transcribe(say(phrase));
  console.log(`  said "${phrase}"`);
  console.log(`  heard                     -> "${heard.text}"  (model loaded in ${heard.loadMs}ms)`);

  const match = matchVoiceCommand(heard.text, candidates);
  const habit = habits.find((h) => h.id === match?.id);
  console.log(
    `  would                     -> ${habit ? `tick off "${habit.name}" ${spokenCount(heard.text)}x (matched "${match!.phrase}")` : 'match no habit'}`
  );

  const failed = [
    woke.length === 0 && 'the wake word was not recognised',
    unrelated.length > 0 && 'unrelated speech woke it',
    embedding?.length !== VOICEPRINT_DIMENSIONS && 'no usable speaker embedding was produced',
    !heard.text && 'the command recogniser heard nothing',
  ].filter(Boolean);

  console.log(failed.length ? `\nFAILED: ${failed.join('; ')}\n` : '\nThe whole chain works.\n');
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  cleanUp();
}
