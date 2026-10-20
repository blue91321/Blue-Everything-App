/**
 * A wake word typed in a box, turned into what the keyword spotter can look for.
 *
 * The spotter does not take words. It takes **token sequences** from the
 * model's own SentencePiece vocabulary — `▁JA R VI S` rather than "jarvis" — and
 * a line it cannot read is refused with "Cannot find ID for token". The
 * `modelingUnit` / `bpeVocab` options that do this for the streaming recogniser
 * are not applied to keywords, so the encoding has to happen here.
 *
 * The obvious encoder is BPE, and the file is even called `bpe.model`. **It is a
 * unigram model**, and BPE got four of the nine example keywords that ship with
 * it wrong — the same four whether merges went by id or by the stored scores.
 * Unigram is the split whose pieces' log probabilities add up highest, found by
 * Viterbi, and that matched all nine. So the file's name was the first thing to
 * stop believing.
 *
 * The model file is protobuf, read by hand: two fields of one repeated message
 * are all this needs, which is the same call `zip.ts` and `bplist.ts` make about
 * their formats.
 */
import { readFileSync } from 'node:fs';

/** Each piece and its log probability. */
export type Pieces = Map<string, number>;

export function loadPieces(file: string): Pieces {
  const b = readFileSync(file);
  const pieces: Pieces = new Map();
  let o = 0;

  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = b[o++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  const skip = (wire: number): void => {
    if (wire === 0) varint();
    else if (wire === 1) o += 8;
    else if (wire === 2) {
      // Read first: `o += varint()` takes `o` before the call has moved it.
      const length = varint();
      o += length;
    }
    else if (wire === 5) o += 4;
    else throw new Error(`unreadable wire type ${wire} in ${file}`);
  };

  while (o < b.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;

    // Field 1 of the model is the repeated piece: its text (1) and score (2).
    if (field !== 1 || wire !== 2) {
      skip(wire);
      continue;
    }

    const length = varint();
    const end = o + length;
    let piece = '';
    let score = 0;
    while (o < end) {
      const k = varint();
      const f = Math.floor(k / 8);
      const w = k & 7;
      if (f === 1 && w === 2) {
        const length = varint();
        piece = b.toString('utf8', o, o + length);
        o += length;
      } else if (f === 2 && w === 5) {
        score = b.readFloatLE(o);
        o += 4;
      } else {
        skip(w);
      }
    }
    pieces.set(piece, score);
    o = end;
  }

  return pieces;
}

/** What a character with no piece of its own costs, as SentencePiece's `<unk>` does. */
const UNKNOWN = -20;

function encodeWord(word: string, pieces: Pieces): string[] {
  const s = [...`▁${word}`];
  const best = new Array<number>(s.length + 1).fill(-Infinity);
  const from = new Array<number>(s.length + 1).fill(-1);
  best[0] = 0;

  for (let end = 1; end <= s.length; end++) {
    // No piece in these vocabularies is anywhere near twenty characters.
    for (let start = Math.max(0, end - 20); start < end; start++) {
      if (best[start] === -Infinity) continue;
      const piece = s.slice(start, end).join('');
      const score = pieces.get(piece) ?? (end - start === 1 ? UNKNOWN : undefined);
      if (score === undefined) continue;
      if (best[start] + score > best[end]) {
        best[end] = best[start] + score;
        from[end] = start;
      }
    }
  }

  const parts: string[] = [];
  for (let end = s.length; end > 0; end = from[end]) parts.unshift(s.slice(from[end], end).join(''));
  return parts;
}

/** The model's vocabulary is upper case, so the text is too. */
export function tokensFor(phrase: string, pieces: Pieces): string[] {
  return phrase
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => encodeWord(word, pieces));
}

/**
 * The spotter's keyword file: one phrase per line, its tokens then `@` and a
 * name, so a hit comes back as the phrase rather than as token soup. Spaces in
 * the name are underscores, because a space ends it.
 */
export function keywordLines(phrases: string[], pieces: Pieces): string {
  return phrases
    .map((phrase) => phrase.trim().toLowerCase())
    .filter(Boolean)
    .map((phrase) => `${tokensFor(phrase, pieces).join(' ')} @${phrase.replace(/\s+/g, '_')}`)
    .join('\n');
}

/** A character the spotter has no piece for: the word cannot be said to it. */
export function unspellable(word: string, pieces: Pieces): boolean {
  return [...word.toUpperCase()].some((ch) => !pieces.has(ch) && !pieces.has(`▁${ch}`));
}
