/**
 * Text to speech, made here: words become sounds (phonemes), and the sounds
 * become a voice by formant synthesis, the way speech synthesisers worked
 * before recordings: a buzz at a speaking pitch (the vocal cords), shaped by
 * resonators set to the mouth's formants, with noise for breath and hiss. No
 * recordings and nothing fetched, so the board's ▶ and the PC make the same
 * bytes; the noise has a fixed seed for that reason. Asked for (2026-11-07) as
 * "something that will put them together if I type in some words".
 *
 * - **Words to sounds** (`textToSounds`): a dictionary of common and awkward
 *   words, then English spelling rules for the rest. Square brackets give
 *   sounds exactly: `[HH AH L OW1]` (a 1 after a vowel stresses it).
 * - **Sounds to a plan** (`planSpeech`): how long each sound lasts, where the
 *   pitch goes. Both can be changed in the voice editor and are kept as
 *   `voiceEdit` on the box, at 100% speed and in semitones from the voice's
 *   own pitch, so the speed and the voice still apply to them.
 * - **A plan to samples** (`speechSamples`): a Klatt-style cascade of four
 *   resonators fed by a glottal pulse and breath noise, and a hiss resonator
 *   beside it for s, sh, f and th.
 *
 * Only `type`s are imported, so the agent and `blueprints-check` read it as is.
 */

export type SoundGroup = 'Vowels' | 'Two-part vowels' | 'Hums and glides' | 'Hisses' | 'Pops' | 'Breath and pauses';

/** One of the sounds, ARPAbet-named as dictionaries name them. */
export interface PhonemeSpec {
  id: string;
  group: SoundGroup;
  /** A word with the sound in it, the letters that make it in capitals. */
  example: string;
  /** How long it lasts at 100% speed, in ms. */
  ms: number;
  /** The first three formants for a man's voice; for a consonant, where the mouth is (its locus). */
  f?: [number, number, number];
  /** Where a two-part vowel ends up. */
  to?: [number, number, number];
  voiced: boolean;
  /** A hiss: its centre, its width and how loud, 0 to 1. */
  hiss?: [number, number, number];
  /** A pop: the burst's centre and width. */
  pop?: [number, number];
}

const V = (id: string, example: string, ms: number, f: [number, number, number], to?: [number, number, number]): PhonemeSpec => ({
  id,
  group: to ? 'Two-part vowels' : 'Vowels',
  example,
  ms,
  f,
  ...(to ? { to } : {}),
  voiced: true,
});

/** Every sound, the values the usual ones from Peterson and Barney's and Klatt's tables. */
export const PHONEMES: PhonemeSpec[] = [
  V('IY', 'sEE', 150, [270, 2290, 3010]),
  V('IH', 'sIt', 100, [390, 1990, 2550]),
  V('EH', 'bEd', 110, [530, 1840, 2480]),
  V('AE', 'cAt', 140, [660, 1720, 2410]),
  V('AA', 'fAther', 140, [730, 1090, 2440]),
  V('AO', 'lAW', 140, [570, 840, 2410]),
  V('AH', 'cUp', 90, [640, 1190, 2390]),
  V('UH', 'bOOk', 100, [440, 1020, 2240]),
  V('UW', 'fOOd', 140, [300, 870, 2240]),
  V('ER', 'bIRd', 140, [490, 1350, 1690]),
  V('AX', 'Ago', 60, [500, 1500, 2500]),
  V('EY', 'dAY', 170, [480, 1900, 2500], [330, 2200, 2800]),
  V('AY', 'mY', 190, [730, 1090, 2440], [330, 2000, 2600]),
  V('OW', 'gO', 170, [540, 1000, 2400], [380, 820, 2300]),
  V('AW', 'hOW', 190, [730, 1090, 2440], [360, 850, 2300]),
  V('OY', 'bOY', 200, [570, 840, 2410], [330, 2000, 2600]),
  { id: 'L', group: 'Hums and glides', example: 'Let', ms: 65, f: [360, 1000, 2700], voiced: true },
  { id: 'R', group: 'Hums and glides', example: 'Red', ms: 65, f: [350, 1060, 1380], voiced: true },
  { id: 'W', group: 'Hums and glides', example: 'Wet', ms: 60, f: [300, 610, 2200], voiced: true },
  { id: 'Y', group: 'Hums and glides', example: 'Yes', ms: 60, f: [260, 2070, 3020], voiced: true },
  { id: 'M', group: 'Hums and glides', example: 'Me', ms: 70, f: [280, 1000, 2200], voiced: true },
  { id: 'N', group: 'Hums and glides', example: 'No', ms: 65, f: [280, 1650, 2600], voiced: true },
  { id: 'NG', group: 'Hums and glides', example: 'siNG', ms: 75, f: [280, 2200, 2700], voiced: true },
  { id: 'S', group: 'Hisses', example: 'Sea', ms: 110, f: [400, 1700, 2600], voiced: false, hiss: [5500, 2200, 0.9] },
  { id: 'Z', group: 'Hisses', example: 'Zoo', ms: 90, f: [400, 1700, 2600], voiced: true, hiss: [5500, 2200, 0.5] },
  { id: 'SH', group: 'Hisses', example: 'SHe', ms: 120, f: [400, 1900, 2500], voiced: false, hiss: [2800, 1400, 1.7] },
  { id: 'ZH', group: 'Hisses', example: 'meaSure', ms: 90, f: [400, 1900, 2500], voiced: true, hiss: [2800, 1400, 0.9] },
  { id: 'F', group: 'Hisses', example: 'Fan', ms: 100, f: [400, 1100, 2200], voiced: false, hiss: [5000, 6000, 0.35] },
  { id: 'V', group: 'Hisses', example: 'Van', ms: 70, f: [400, 1100, 2200], voiced: true, hiss: [5000, 6000, 0.2] },
  { id: 'TH', group: 'Hisses', example: 'THin', ms: 100, f: [400, 1400, 2600], voiced: false, hiss: [6000, 6000, 0.3] },
  { id: 'DH', group: 'Hisses', example: 'THis', ms: 55, f: [400, 1400, 2600], voiced: true, hiss: [6000, 6000, 0.18] },
  { id: 'P', group: 'Pops', example: 'Pet', ms: 100, f: [400, 900, 2300], voiced: false, pop: [1200, 1800] },
  { id: 'B', group: 'Pops', example: 'Bed', ms: 70, f: [400, 900, 2300], voiced: true, pop: [1200, 1800] },
  { id: 'T', group: 'Pops', example: 'Top', ms: 100, f: [400, 1800, 2600], voiced: false, pop: [4000, 2500] },
  { id: 'D', group: 'Pops', example: 'Dog', ms: 70, f: [400, 1800, 2600], voiced: true, pop: [4000, 2500] },
  { id: 'K', group: 'Pops', example: 'Kit', ms: 100, f: [400, 2000, 2500], voiced: false, pop: [2200, 1500] },
  { id: 'G', group: 'Pops', example: 'Go', ms: 70, f: [400, 2000, 2500], voiced: true, pop: [2200, 1500] },
  { id: 'CH', group: 'Pops', example: 'CHin', ms: 130, f: [400, 1900, 2500], voiced: false, pop: [4000, 2500], hiss: [2800, 1400, 1.7] },
  { id: 'JH', group: 'Pops', example: 'Jam', ms: 110, f: [400, 1900, 2500], voiced: true, pop: [4000, 2500], hiss: [2800, 1400, 0.9] },
  { id: 'HH', group: 'Breath and pauses', example: 'Hat', ms: 70, voiced: false },
  { id: '_', group: 'Breath and pauses', example: 'a short pause', ms: 150, voiced: false },
];
const SPEC = new Map(PHONEMES.map((p) => [p.id, p]));
export const phonemeSpec = (id: string): PhonemeSpec | undefined => SPEC.get(id);
const isVowel = (id: string) => /^(IY|IH|EH|AE|AA|AO|AH|UH|UW|ER|AX|EY|AY|OW|AW|OY)$/.test(id);

/** A sound as said: which, for how long at 100% speed, and whether it carries the word's stress. */
export interface SaidSound {
  p: string;
  ms: number;
  stress?: boolean;
}

/**
 * Words this file says better than the spelling rules would, in ARPAbet, a 1
 * after the stressed vowel where it is not the first. Common words first, then
 * ones the rules get wrong (the 'o' of "one", the 'ou' of "you").
 */
const WORDS = `a:AX|the:DH AX|to:T UW|of:AH V|and:AE N D|or:AO R|is:IH Z|are:AA R|was:W AA Z|were:W ER|be:B IY|been:B IH N|
i:AY|im:AY M|me:M IY|my:M AY|you:Y UW|your:Y AO R|youre:Y AO R|he:HH IY|she:SH IY|we:W IY|they:DH EY|them:DH EH M|it:IH T|its:IH T S|
that:DH AE T|this:DH IH S|these:DH IY Z|those:DH OW Z|there:DH EH R|their:DH EH R|theyre:DH EH R|then:DH EH N|than:DH AE N|with:W IH DH|
what:W AH T|where:W EH R|when:W EH N|why:W AY|how:HH AW|who:HH UW|which:W IH CH|hello:HH AX L OW1|hi:HH AY|hey:HH EY|bye:B AY|
goodbye:G UH D B AY1|yes:Y EH S|yeah:Y EH|no:N OW|not:N AA T|okay:OW K EY1|ok:OW K EY1|one:W AH N|two:T UW|three:TH R IY|four:F AO R|
five:F AY V|six:S IH K S|seven:S EH V AX N|eight:EY T|nine:N AY N|ten:T EH N|eleven:IH L EH1 V AX N|twelve:T W EH L V|zero:Z IH R OW|
hundred:HH AH N D R AX D|thousand:TH AW Z AX N D|do:D UW|does:D AH Z|done:D AH N|doing:D UW IH NG|have:HH AE V|has:HH AE Z|had:HH AE D|
said:S EH D|says:S EH Z|say:S EY|here:HH IY R|come:K AH M|some:S AH M|love:L AH V|give:G IH V|live:L IH V|get:G EH T|got:G AA T|
good:G UH D|great:G R EY T|world:W ER L D|people:P IY P AX L|time:T AY M|game:G EY M|play:P L EY|water:W AO T ER|welcome:W EH L K AX M|
back:B AE K|morning:M AO R N IH NG|evening:IY V N IH NG|night:N AY T|thank:TH AE NG K|thanks:TH AE NG K S|please:P L IY Z|sorry:S AA R IY|
friend:F R EH N D|friends:F R EH N D Z|again:AX G EH1 N|from:F R AH M|for:F AO R|can:K AE N|cant:K AE N T|dont:D OW N T|wont:W OW N T|
will:W IH L|would:W UH D|could:K UH D|should:SH UH D|by:B AY|now:N AW|know:N OW|new:N UW|out:AW T|about:AX B AW1 T|all:AO L|any:EH N IY|
many:M EH N IY|only:OW N L IY|very:V EH R IY|really:R IY L IY|eye:AY|everything:EH V R IY TH IH NG|everyone:EH V R IY W AH N|blue:B L UW|
minute:M IH N IH T|minutes:M IH N IH T S|hour:AW ER|hours:AW ER Z|second:S EH K AX N D|ready:R EH D IY|start:S T AA R T|stop:S T AA P|
go:G OW|break:B R EY K|drink:D R IH NG K|take:T EY K|reminder:R IY M AY1 N D ER|remember:R IY M EH1 M B ER|computer:K AX M P Y UW1 T ER|
warframe:W AO R F R EY M|level:L EH V AX L|match:M AE CH|win:W IH N|won:W AH N|lose:L UW Z|lost:L AO S T|nice:N AY S|work:W ER K|
working:W ER K IH NG|school:S K UW L|home:HH OW M|today:T AX D EY1|tomorrow:T AX M AA1 R OW|day:D EY|week:W IY K|music:M Y UW Z IH K|
listen:L IH S AX N|voice:V OY S|sound:S AW N D|talk:T AO K|walk:W AO K|other:AH DH ER|another:AX N AH1 DH ER|mother:M AH DH ER|
father:F AA DH ER|brother:B R AH DH ER|year:Y IY R|our:AW ER|wash:W AA SH|want:W AA N T|answer:AE N S ER|two:T UW|too:T UW|
put:P UH T|push:P UH SH|pull:P UH L|full:F UH L|done:D AH N|gone:G AO N|move:M UW V|does:D AH Z|busy:B IH Z IY|women:W IH M IH N|
woman:W UH M AX N|reload:R IY L OW1 D|replay:R IY P L EY1|return:R IY T ER1 N|repeat:R IY P IY1 T|body:B AA D IY|very:V EH R IY|man:M AE N|men:M EH N|child:CH AY L D|children:CH IH L D R AX N|claude:K L AO D|blueprint:B L UW P R IH N T`;
const DICT = new Map(
  WORDS.split('|').map((entry) => {
    const [w, p] = entry.trim().split(':');
    return [w!, p!.trim()] as const;
  })
);
/** Words said without stress and short, so a sentence does not plod. */
const LIGHT = new Set([
  'a',
  'the',
  'to',
  'of',
  'and',
  'or',
  'is',
  'are',
  'was',
  'be',
  'it',
  'its',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'an',
  'as',
  'that',
  'than',
  'then',
  'can',
  'will',
  'your',
  'my',
]);

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** A number in words, up to the thousands; past that, digit by digit. */
function numberWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`;
  if (n < 1_000_000) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ''}`;
  return String(n)
    .split('')
    .map((d) => ONES[Number(d)])
    .join(' ');
}

const VOWEL_LETTERS = 'aeiouy';
const LONG: Record<string, string> = { a: 'EY', e: 'IY', i: 'AY', o: 'OW', u: 'UW', y: 'AY' };
const SHORT: Record<string, string> = { a: 'AE', e: 'EH', i: 'IH', o: 'AA', u: 'AH', y: 'IH' };
/** Letters that go together, longest first, and what they say. */
const GROUPS: Array<[string, string]> = [
  ['tion', 'SH AX N'],
  ['sion', 'ZH AX N'],
  ['ture', 'CH ER'],
  ['ough', 'AO'],
  ['augh', 'AO'],
  ['eigh', 'EY'],
  ['tch', 'CH'],
  ['igh', 'AY'],
  ['dge', 'JH'],
  ['all', 'AO L'],
  ['ing', 'IH NG'],
  ['air', 'EH R'],
  ['ear', 'IY R'],
  ['eer', 'IY R'],
  ['oor', 'AO R'],
  ['our', 'AW ER'],
  ['th', 'TH'],
  ['sh', 'SH'],
  ['ch', 'CH'],
  ['ph', 'F'],
  ['wh', 'W'],
  ['ck', 'K'],
  ['ng', 'NG'],
  ['nk', 'NG K'],
  ['qu', 'K W'],
  ['gh', ''],
  ['ee', 'IY'],
  ['ea', 'IY'],
  ['oo', 'UW'],
  ['ou', 'AW'],
  ['oi', 'OY'],
  ['oy', 'OY'],
  ['ai', 'EY'],
  ['ay', 'EY'],
  ['au', 'AO'],
  ['aw', 'AO'],
  ['oa', 'OW'],
  ['ie', 'IY'],
  ['ei', 'EY'],
  ['ey', 'IY'],
  ['ue', 'UW'],
  ['ow', 'AW'],
  ['ew', 'UW'],
  ['ar', 'AA R'],
  ['or', 'AO R'],
  ['er', 'ER'],
  ['ir', 'ER'],
  ['ur', 'ER'],
];
const ONE: Record<string, string> = {
  b: 'B',
  c: 'K',
  d: 'D',
  f: 'F',
  g: 'G',
  h: 'HH',
  j: 'JH',
  k: 'K',
  l: 'L',
  m: 'M',
  n: 'N',
  p: 'P',
  q: 'K',
  r: 'R',
  s: 'S',
  t: 'T',
  v: 'V',
  w: 'W',
  x: 'K S',
  z: 'Z',
};

/** A word by the spelling rules: groups of letters, a silent final e that lengthens the vowel before it, soft c and g, and a few endings. */
function spell(word: string): string[] {
  const w = word.toLowerCase();
  const out: string[] = [];
  // A final -ed: after t or d it is a syllable, after a hiss or a pop it is T, otherwise D.
  if (w.length > 3 && w.endsWith('ed') && !VOWEL_LETTERS.includes(w[w.length - 3]!)) {
    const stem = spell(w.slice(0, -2));
    const last = stem[stem.length - 1] ?? '';
    return [...stem, ...(last === 'T' || last === 'D' ? ['IH', 'D'] : ['P', 'K', 'S', 'SH', 'CH', 'F', 'TH'].includes(last) ? ['T'] : ['D'])];
  }
  // A final -s after a voiced sound is Z.
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    const stem = DICT.get(w.slice(0, -1))?.split(' ') ?? spell(w.slice(0, -1));
    const last = (stem[stem.length - 1] ?? '').replace('1', '');
    return [...stem, ['P', 'T', 'K', 'F', 'TH'].includes(last) ? 'S' : ['S', 'Z', 'SH', 'CH', 'JH'].includes(last) ? 'IH Z' : 'Z'].flatMap((x) => x.split(' '));
  }
  let i = 0;
  if (w.startsWith('kn') || w.startsWith('wr') || w.startsWith('gn')) i = 1;
  while (i < w.length) {
    const rest = w.slice(i);
    const ch = w[i]!;
    // A vowel, one consonant, and a final e: the long vowel, and the e says nothing.
    if ('aeiou'.includes(ch) && i + 2 === w.length - 1 && w[w.length - 1] === 'e' && !VOWEL_LETTERS.includes(w[i + 1]!) && w.length > 3) {
      out.push(LONG[ch]!, ...(ch === 'u' ? [] : []));
      const c = w[i + 1]!;
      out.push(...(c === 'c' ? ['S'] : c === 'g' ? ['JH'] : c === 's' ? ['Z'] : (ONE[c] ?? '').split(' ')));
      break;
    }
    // A final consonant-le: "table".
    if (rest === 'le' && i > 0 && !VOWEL_LETTERS.includes(w[i - 1]!)) {
      out.push('AX', 'L');
      break;
    }
    // A final e after something else says nothing, unless it is the only vowel.
    if (ch === 'e' && i === w.length - 1 && i > 0 && [...w.slice(0, -1)].some((c) => VOWEL_LETTERS.includes(c))) break;
    // "ow" ends a word as in "show", and is "ow" as in "town" inside one.
    if (rest === 'ow') {
      out.push('OW');
      break;
    }
    // An a, o or u in the first syllable, before one consonant and another vowel, is long: "over", "lazy", "music".
    if (
      'aou'.includes(ch) &&
      ![...w.slice(0, i)].some((c) => VOWEL_LETTERS.includes(c)) &&
      i + 2 < w.length &&
      !VOWEL_LETTERS.includes(w[i + 1]!) &&
      'aeiouy'.includes(w[i + 2]!) &&
      !'rwx'.includes(w[i + 1]!) &&
      !GROUPS.some(([g]) => rest.startsWith(g))
    ) {
      out.push(LONG[ch]!);
      i++;
      continue;
    }
    const group = GROUPS.find(([g]) => rest.startsWith(g));
    if (group) {
      if (group[1]) out.push(...group[1].split(' '));
      i += group[0].length;
      continue;
    }
    // A doubled consonant is said once.
    if (i > 0 && ch === w[i - 1] && !VOWEL_LETTERS.includes(ch)) {
      i++;
      continue;
    }
    if (ch === 'y') {
      // Y begins a word as a consonant, ends one as "ee" (or "eye" when it is the only vowel), and is a vowel inside one.
      if (i === 0) out.push('Y');
      else if (i === w.length - 1) out.push([...w.slice(0, -1)].some((c) => 'aeiou'.includes(c)) ? 'IY' : 'AY');
      else out.push('IH');
    } else if ('aeiou'.includes(ch)) out.push(i === w.length - 1 && ch === 'o' ? 'OW' : i === w.length - 1 && ch === 'e' ? 'IY' : SHORT[ch]!);
    else if (ch === 'c') out.push('eiy'.includes(w[i + 1] ?? '') ? 'S' : 'K');
    else if (ch === 'g') out.push('eiy'.includes(w[i + 1] ?? '') && i + 1 < w.length - 1 ? 'JH' : 'G');
    else if (ch === 's') out.push(i > 0 && i < w.length - 1 && 'aeiou'.includes(w[i - 1]!) && 'aeiou'.includes(w[i + 1]!) ? 'Z' : 'S');
    else if (ONE[ch]) out.push(...ONE[ch]!.split(' '));
    i++;
  }
  return out;
}

/** A word's sounds, with its stress: the dictionary's, or the first vowel's. */
function wordSounds(word: string, light: boolean): SaidSound[] {
  const raw = DICT.get(word) ?? spell(word).join(' ');
  const parts = raw.split(/\s+/).filter(Boolean);
  const marked = parts.some((p) => p.endsWith('1'));
  let stressed = false;
  return parts.map((part) => {
    const p = part.replace('1', '');
    const spec = SPEC.get(p);
    let stress = false;
    if (!light && isVowel(p) && !stressed && (marked ? part.endsWith('1') : true)) {
      stress = true;
      stressed = true;
    }
    return { p, ms: (spec?.ms ?? 80) * (light && isVowel(p) ? 0.7 : 1), ...(stress ? { stress } : {}) };
  });
}

/** What the box is told to say, as it is compared with the text an edit was made for. */
export const normalText = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Text as sounds. Punctuation pauses (a comma briefly, an end of sentence
 * longer); numbers are said; square brackets are sounds given exactly.
 */
export function textToSounds(text: string): SaidSound[] {
  const out: SaidSound[] = [];
  const tokens = text.match(/\[[^\]]*\]|\d+|[A-Za-z']+|[,.;:!?]/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('[')) {
      for (const part of token
        .slice(1, -1)
        .toUpperCase()
        .split(/[\s,]+/)
        .filter(Boolean)) {
        const p = part.replace('1', '');
        const spec = SPEC.get(p);
        if (spec) out.push({ p, ms: spec.ms, ...(part.endsWith('1') ? { stress: true } : {}) });
      }
    } else if (/^\d+$/.test(token)) {
      for (const w of numberWords(Number(token)).split(' ')) out.push(...wordSounds(w, false));
    } else if (/^[,;:]$/.test(token)) out.push({ p: '_', ms: 180 });
    else if (/^[.!?]$/.test(token)) out.push({ p: '_', ms: 320 });
    else {
      const w = token.toLowerCase().replace(/'/g, '');
      out.push(...wordSounds(w, LIGHT.has(w)));
    }
  }
  // The last vowel before the end is drawn out a little, as the end of a phrase is.
  for (let i = out.length - 1; i >= 0; i--) {
    if (isVowel(out[i]!.p)) {
      out[i] = { ...out[i]!, ms: Math.round(out[i]!.ms * 1.25) };
      break;
    }
  }
  while (out.length && out[out.length - 1]!.p === '_') out.pop();
  return out.map((s) => ({ ...s, ms: Math.round(s.ms * (s.stress ? 1.15 : 1)) }));
}

/** The voices on offer: a speaking pitch and how much smaller the mouth is than a man's. */
export const VOICES: Record<string, { label: string; hz: number; size: number }> = {
  deep: { label: 'Deep', hz: 85, size: 0.95 },
  man: { label: 'Man', hz: 115, size: 1 },
  woman: { label: 'Woman', hz: 200, size: 1.16 },
  child: { label: 'Child', hz: 280, size: 1.28 },
  robot: { label: 'Robot (one note)', hz: 110, size: 1 },
};

/** What a box asks to be said: the words, the voice, the speed, and any changes made in the voice editor. */
export interface SpeechInput {
  say: string;
  voice: string;
  /** 50 to 200, percent. */
  speed: number;
  edit: VoiceEdit;
}

/**
 * Changes made in the voice editor, for the text they were made for: the
 * sounds (each at 100% speed) and the pitch line (ms at 100% speed, and
 * semitones from the voice's pitch). Null in either means "as the words say".
 */
export interface VoiceEdit {
  for: string;
  sounds: SaidSound[] | null;
  pitch: Array<[number, number]> | null;
}

export const NO_EDIT: VoiceEdit = { for: '', sounds: null, pitch: null };

/** A voice edit as the box keeps it, cleaned: known sounds, 10 ms to a second each, 400 at most; a pitch line in time order, two octaves either way. */
export function parseVoiceEdit(raw: unknown): VoiceEdit {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return NO_EDIT;
    }
  }
  if (!value || typeof value !== 'object') return NO_EDIT;
  const v = value as { for?: unknown; sounds?: unknown; pitch?: unknown };
  const sounds = Array.isArray(v.sounds)
    ? v.sounds
        .slice(0, 400)
        .map((s): SaidSound | null => {
          const [p, ms, stress] = Array.isArray(s) ? s : [];
          if (typeof p !== 'string' || !SPEC.has(p) || !Number.isFinite(Number(ms))) return null;
          return { p, ms: Math.round(Math.min(1000, Math.max(10, Number(ms)))), ...(stress ? { stress: true } : {}) };
        })
        .filter((s): s is SaidSound => s !== null)
    : null;
  const pitch = Array.isArray(v.pitch)
    ? v.pitch
        .slice(0, 200)
        .map((q) => (Array.isArray(q) ? [Number(q[0]), Number(q[1])] : [NaN, NaN]))
        .filter(([t, st]) => Number.isFinite(t) && Number.isFinite(st))
        .map(([t, st]): [number, number] => [Math.round(Math.max(0, Math.min(20_000, t!))), Math.round(Math.max(-24, Math.min(24, st!)) * 10) / 10])
        .sort((a, b) => a[0] - b[0])
    : null;
  return { for: typeof v.for === 'string' ? v.for.slice(0, 300) : '', sounds, pitch };
}

export function voiceEditText(edit: VoiceEdit): string {
  if (!edit.sounds && !edit.pitch) return '';
  return JSON.stringify({ for: edit.for, sounds: edit.sounds?.map((s) => (s.stress ? [s.p, s.ms, 1] : [s.p, s.ms])) ?? null, pitch: edit.pitch });
}

/** A sound in the plan: when it starts and how long it lasts, at the speed asked for. */
export interface PlannedSound extends SaidSound {
  start: number;
  length: number;
}

export interface SpeechPlan {
  sounds: PlannedSound[];
  /** The pitch line, ms (at the speed asked for) and Hz. */
  pitch: Array<[number, number]>;
  /** The same in the editor's units: ms at 100% speed and semitones from the voice. */
  pitchEdit: Array<[number, number]>;
  total: number;
  /** Whether the edit applies: it was made for these words. */
  edited: { sounds: boolean; pitch: boolean };
  base: number;
  size: number;
}

/**
 * The pitch a sentence has unless told otherwise: starting a little high and
 * settling lower, up on each stressed vowel, and at the end falling for a
 * statement or rising for a question. In semitones from the voice's pitch, at
 * 100% speed, so the editor can show it and you can drag it.
 */
function autoPitch(sounds: SaidSound[], say: string): Array<[number, number]> {
  const total = sounds.reduce((t, s) => t + s.ms, 0);
  if (!total) return [];
  const asks = /\?\s*$/.test(say);
  const exclaims = /!\s*$/.test(say);
  const lift = exclaims ? 3 : 0;
  const decline = (t: number) => 1.5 - 3.5 * (t / total) + lift;
  const points: Array<[number, number]> = [[0, decline(0)]];
  let t = 0;
  for (const s of sounds) {
    if (isVowel(s.p)) points.push([Math.round(t + s.ms / 2), Math.round((decline(t + s.ms / 2) + (s.stress ? 2.5 : 0)) * 10) / 10]);
    t += s.ms;
  }
  points.push([total, asks ? 6 : decline(total) - 1.5]);
  return points;
}

/** The plan for a box: the sounds and their times, and the pitch line, from the words and any edit made for them. */
export function planSpeech(input: SpeechInput): SpeechPlan {
  const voice = VOICES[input.voice] ?? VOICES.man!;
  const speed = Math.min(200, Math.max(50, input.speed || 100)) / 100;
  const forThese = input.edit.for === normalText(input.say);
  const said = forThese && input.edit.sounds ? input.edit.sounds : textToSounds(input.say);
  const pitchEdit = forThese && input.edit.pitch ? input.edit.pitch : autoPitch(said, input.say);
  let t = 0;
  const sounds: PlannedSound[] = said.map((s) => {
    const length = s.ms / speed;
    const out = { ...s, start: t, length };
    t += length;
    return out;
  });
  const robot = input.voice === 'robot';
  return {
    sounds,
    pitch: pitchEdit.map(([ms, st]) => [ms / speed, voice.hz * 2 ** ((robot ? 0 : st) / 12)]),
    pitchEdit,
    total: t,
    edited: { sounds: Boolean(forThese && input.edit.sounds), pitch: Boolean(forThese && input.edit.pitch) },
    base: voice.hz,
    size: voice.size,
  };
}

/** A box's fields as words to say. */
export function speechInputOf(fields: Record<string, unknown>): SpeechInput {
  const speed = Number(fields.speed);
  return { say: String(fields.say ?? ''), voice: String(fields.voice ?? 'man'), speed: Number.isFinite(speed) ? speed : 100, edit: parseVoiceEdit(fields.voiceEdit) };
}

/** How long the words take, in ms. */
export function speechLength(input: SpeechInput): number {
  return Math.round(planSpeech(input).total);
}

/** One stretch of the synthesiser's settings: the targets it moves towards while that stretch lasts. */
interface Stretch {
  start: number;
  end: number;
  /** Formants at their steady points (one for a consonant, two for a vowel, which holds, and for a two-part vowel, which moves). */
  anchors: Array<[number, [number, number, number]]>;
  voice: number;
  breath: number;
  hiss: number;
  hissAt: [number, number];
  nasal: boolean;
}

/** The plan as stretches: a pop is a closure, a burst and (unvoiced) a breath; everything else one stretch. */
function stretches(plan: SpeechPlan): Stretch[] {
  const out: Stretch[] = [];
  const scale = (f: [number, number, number]): [number, number, number] => [f[0] * plan.size, f[1] * plan.size, f[2] * plan.size];
  for (const s of plan.sounds) {
    const spec = SPEC.get(s.p);
    if (!spec) continue;
    const a = s.start;
    const b = s.start + s.length;
    const at = (u: number) => a + (b - a) * u;
    const base = { breath: 0, hiss: 0, hissAt: [3000, 2000] as [number, number], nasal: false };
    if (s.p === '_') out.push({ ...base, start: a, end: b, anchors: [], voice: 0 });
    else if (s.p === 'HH') out.push({ ...base, start: a, end: b, anchors: [], voice: 0, breath: 0.7 });
    else if (spec.pop) {
      const f = scale(spec.f!);
      const closure = (b - a) * (spec.voiced ? 0.7 : 0.55);
      const burst = Math.min(18, (b - a) * 0.15);
      const burstEnd = a + closure + burst;
      out.push({ ...base, start: a, end: a + closure, anchors: [[a + closure / 2, f]], voice: spec.voiced ? 0.15 : 0 });
      out.push({ ...base, start: a + closure, end: burstEnd, anchors: [[a + closure + burst / 2, f]], voice: spec.voiced ? 0.3 : 0, hiss: 0.9, hissAt: spec.pop });
      if (spec.hiss)
        out.push({ ...base, start: burstEnd, end: b, anchors: [[(burstEnd + b) / 2, f]], voice: spec.voiced ? 0.4 : 0, hiss: spec.hiss[2], hissAt: [spec.hiss[0], spec.hiss[1]] });
      else if (burstEnd < b) out.push({ ...base, start: burstEnd, end: b, anchors: [], voice: spec.voiced ? 0.8 : 0, breath: spec.voiced ? 0 : 0.6 });
    } else if (spec.hiss) {
      out.push({ ...base, start: a, end: b, anchors: [[at(0.5), scale(spec.f!)]], voice: spec.voiced ? 0.45 : 0, hiss: spec.hiss[2], hissAt: [spec.hiss[0], spec.hiss[1]] });
    } else if (spec.to) {
      out.push({
        ...base,
        start: a,
        end: b,
        anchors: [
          [at(0.2), scale(spec.f!)],
          [at(0.85), scale(spec.to)],
        ],
        voice: 1,
      });
    } else if (isVowel(s.p)) {
      out.push({
        ...base,
        start: a,
        end: b,
        anchors: [
          [at(0.3), scale(spec.f!)],
          [at(0.7), scale(spec.f!)],
        ],
        voice: 1,
      });
    } else {
      const nasal = ['M', 'N', 'NG'].includes(s.p);
      out.push({ ...base, start: a, end: b, anchors: [[at(0.5), scale(spec.f!)]], voice: nasal ? 0.55 : 0.8, nasal });
    }
  }
  return out;
}

/** A fixed-seed noise source, so the same words make the same bytes everywhere. */
function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** The glottal pulse over one cycle (Rosenberg's): it opens smoothly, shuts more quickly, and stays shut. */
function glottis(phase: number): number {
  const open = 0.4;
  const close = 0.16;
  if (phase < open) return 0.5 * (1 - Math.cos((Math.PI * phase) / open));
  if (phase < open + close) return Math.cos((Math.PI * (phase - open)) / (2 * close));
  return 0;
}

/**
 * The words as samples, -1 to 1 at the loudest. Settings move every 5 ms
 * towards the stretch in hand; loudness of each source eases over about 8 ms
 * so a stretch never starts with a click.
 */
export function speechSamples(input: SpeechInput, rate: number): Float32Array {
  const plan = planSpeech(input);
  const parts = stretches(plan);
  const n = Math.round((rate * Math.min(plan.total, 10_000)) / 1000);
  const out = new Float32Array(n);
  if (!n || !parts.length) return out;
  const anchors = parts.flatMap((p) => p.anchors).sort((a, b) => a[0] - b[0]);
  const neutral: [number, number, number] = [500 * plan.size, 1500 * plan.size, 2500 * plan.size];
  const formantsAt = (t: number): [number, number, number] => {
    if (!anchors.length) return neutral;
    if (t <= anchors[0]![0]) return anchors[0]![1];
    for (let i = 0; i < anchors.length - 1; i++) {
      const [ta, fa] = anchors[i]!;
      const [tb, fb] = anchors[i + 1]!;
      if (t <= tb) {
        const u = tb > ta ? (t - ta) / (tb - ta) : 1;
        return [fa[0] + (fb[0] - fa[0]) * u, fa[1] + (fb[1] - fa[1]) * u, fa[2] + (fb[2] - fa[2]) * u];
      }
    }
    return anchors[anchors.length - 1]![1];
  };
  const pitchAt = (t: number): number => {
    const p = plan.pitch;
    if (!p.length) return plan.base;
    if (t <= p[0]![0]) return p[0]![1];
    for (let i = 0; i < p.length - 1; i++) {
      if (t <= p[i + 1]![0]) {
        const [ta, ha] = p[i]!;
        const [tb, hb] = p[i + 1]!;
        return tb > ta ? ha * (hb / ha) ** ((t - ta) / (tb - ta)) : hb;
      }
    }
    return p[p.length - 1]![1];
  };

  // Four resonators in a row for the voice, as the throat and mouth are, and one beside them for a hiss.
  const nyquist = rate * 0.45;
  const res = [0, 1, 2, 3].map(() => ({ a: 1, b: 0, c: 0, y1: 0, y2: 0 }));
  const set = (r: { a: number; b: number; c: number }, f: number, bw: number) => {
    const q = Math.exp((-Math.PI * bw) / rate);
    r.c = -q * q;
    r.b = 2 * q * Math.cos((2 * Math.PI * Math.min(f, nyquist)) / rate);
    r.a = 1 - r.b - r.c;
  };
  const hissRes = { g: 0, b: 0, c: 0, x1: 0, x2: 0, y1: 0, y2: 0 };
  const setHiss = (f: number, bw: number) => {
    const q = Math.exp((-Math.PI * Math.min(bw, rate * 0.4)) / rate);
    hissRes.c = -q * q;
    hissRes.b = 2 * q * Math.cos((2 * Math.PI * Math.min(f, nyquist)) / rate);
    hissRes.g = (1 - q * q) / 2;
  };
  const rnd = noise(0x5eec4);
  const frame = Math.max(1, Math.round(rate * 0.005));
  const ease = 1 - Math.exp(-1 / (0.008 * rate));
  let voice = 0;
  let breath = 0;
  let hiss = 0;
  let target = parts[0]!;
  let k = 0;
  let phase = 0;
  let gPrev = 0;
  let f0 = plan.base;
  let nasal = 0;
  for (let i = 0; i < n; i++) {
    const t = (i * 1000) / rate;
    if (i % frame === 0) {
      while (k < parts.length - 1 && t >= parts[k]!.end) k++;
      target = parts[k]!;
      const f = formantsAt(t);
      nasal = target.nasal ? 1 : 0;
      set(res[0]!, nasal ? 280 * plan.size : f[0], nasal ? 160 : 70);
      set(res[1]!, f[1], 100);
      set(res[2]!, f[2], 160);
      set(res[3]!, 3500 * plan.size, 250);
      setHiss(target.hissAt[0], target.hissAt[1]);
      // A slight, slow wobble, as a held note in a real voice has.
      f0 = pitchAt(t) * (1 + 0.006 * Math.sin((2 * Math.PI * 5 * t) / 1000));
    }
    voice += (target.voice - voice) * ease;
    breath += (target.breath - breath) * ease;
    hiss += (target.hiss - hiss) * ease;
    phase += f0 / rate;
    if (phase >= 1) phase -= 1;
    const g = glottis(phase);
    // The pulse's slope, which is what the lips radiate, scaled so its size does not depend on the pitch.
    const source = (g - gPrev) * (rate / f0) * 0.12 * voice + rnd() * 0.05 * breath;
    gPrev = g;
    let x = source;
    for (const r of res) {
      const y = r.a * x + r.b * r.y1 + r.c * r.y2;
      r.y2 = r.y1;
      r.y1 = y;
      x = y;
    }
    const nz = rnd() * hiss;
    const h = hissRes.g * (nz - hissRes.x2) + hissRes.b * hissRes.y1 + hissRes.c * hissRes.y2;
    hissRes.x2 = hissRes.x1;
    hissRes.x1 = nz;
    hissRes.y2 = hissRes.y1;
    hissRes.y1 = h;
    out[i] = x * (nasal ? 0.6 : 1) + h * 0.9;
  }
  // As loud as it will go, and in and out over a few milliseconds.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const fade = Math.round(rate * 0.004);
  const gain = peak > 0 ? 0.95 / peak : 0;
  for (let i = 0; i < n; i++) out[i] = out[i]! * gain * Math.min(1, i / fade, (n - 1 - i) / fade);
  return out;
}
