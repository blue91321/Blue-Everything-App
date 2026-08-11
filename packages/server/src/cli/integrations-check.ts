/**
 * Prove the parts of the integrations module that have no network in them.
 *
 * `npm run integrations-check -w @everything/server`
 *
 * Deliberately covers only what can be checked without an account: the
 * categoriser, the duration parser, the Steam profile parser, and the
 * manifest's own consistency. Everything else in this feature is a conversation with somebody
 * else's server, and a test that mocks Spotify would only prove that the mock
 * matches the code — which is exactly the assumption that was wrong when the
 * `audio-features` endpoint started returning 403.
 *
 * Same shape as `voice-check` and `vault-check`: run it before trusting a
 * change to the logic it covers.
 */
import {
  FOLLOW_PROVIDERS,
  MUSIC_CATEGORIES,
  PRESENCE_PROVIDERS,
  PROVIDERS,
  PROVIDER_LIST,
  categoriseGenres,
  categoriseVideo,
  steamProfileInput,
  type MusicCategory,
} from '@everything/shared/integrations';
import { parseIsoDuration } from '../features/integrations/providers/youtube.js';

let failures = 0;

function check(what: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

function categorises(genres: string[], expected: MusicCategory): void {
  const result = categoriseGenres(genres);
  check(
    `${JSON.stringify(genres)} → ${expected}`,
    result.category === expected,
    `got ${result.category} (because "${result.because}")`
  );
}

/* ------------------------------------------------------------------ */

console.log('\nCategorising genres');

categorises(['melodic death metal'], 'metal');
categorises(['pop punk'], 'punk');
// "pop rock" lands in rock, and that is the intended answer rather than a near
// miss: this taxonomy is for finding things in your own library, and pop rock
// belongs next to rock there.
categorises(['pop rock', 'power pop'], 'rock');
categorises(['teen pop'], 'pop');
categorises(['jazz rap'], 'hiphop');
categorises(['deep house', 'progressive house'], 'dance');
categorises(['drum and bass'], 'electronic');
categorises(['classic soul', 'motown'], 'rnb');
categorises(['video game music'], 'soundtrack');
categorises(['lo-fi beats'], 'ambient');
categorises([], 'unknown');
categorises(['escape room'], 'unknown');

/*
 * The ordering property the keyword table depends on, stated as a test rather
 * than as a comment: every one of these contains an earlier family's keyword
 * *and* "pop", and must not come back as pop.
 */
console.log('\n  ordering — "pop" must not win over a narrower family');
for (const [genre, expected] of [
  ['pop punk', 'punk'],
  ['pop metal', 'metal'],
  ['k-pop', 'world'],
  ['psychedelic pop', 'rock'],
  ['synthpop', 'electronic'],
] as Array<[string, MusicCategory]>) {
  categorises([genre], expected);
}

console.log('\n  every category is reachable from some genre string');
{
  // `unknown` is reachable by construction — it is what an unmatched string
  // gives — so it is excluded rather than needing a keyword of its own.
  const reachable = new Set<MusicCategory>(['unknown']);
  const probes = [
    'rock', 'heavy metal', 'punk rock', 'pop', 'hip hop', 'soul', 'house music',
    'dubstep', 'jazz', 'classical', 'folk', 'country', 'latin', 'afrobeat',
    'soundtrack', 'ambient', 'spoken word',
  ];
  for (const probe of probes) reachable.add(categoriseGenres([probe]).category);

  const unreachable = MUSIC_CATEGORIES.filter((c) => !reachable.has(c));
  check('all 18 categories have at least one route in', unreachable.length === 0, `missed ${unreachable.join(', ')}`);
}

/* ------------------------------------------------------------------ */

console.log('\nCategorising YouTube videos');

check(
  'a Wikipedia topic beats the numeric category',
  categoriseVideo('10', ['https://en.wikipedia.org/wiki/Heavy_metal_music']).category === 'metal'
);
check(
  'category 20 (Gaming) with no topics falls back to soundtrack',
  categoriseVideo('20', []).category === 'soundtrack'
);
check(
  'a category-10 music video with no topics is a guess, and says so',
  categoriseVideo('10', []).because === null
);
check('an unmapped category with no topics is unknown', categoriseVideo('22', []).category === 'unknown');

/* ------------------------------------------------------------------ */

console.log('\nISO 8601 durations');

check('PT4M13S', parseIsoDuration('PT4M13S') === 253_000);
check('PT1H2M3S', parseIsoDuration('PT1H2M3S') === 3_723_000);
check('PT45S', parseIsoDuration('PT45S') === 45_000);
check('P1DT2H (a livestream)', parseIsoDuration('P1DT2H') === 93_600_000);
check('undefined is null, not zero', parseIsoDuration(undefined) === null);
// Zero and null are genuinely different here: a zero-length video is a broken
// row, an unknown length is a fact about the export.
check('nonsense is null', parseIsoDuration('four minutes') === null);

/* ------------------------------------------------------------------ */

console.log('\nWhat someone pasted into the Steam profile box');

{
  const ID = '76561198000000000';
  const cases: Array<[string, { steamId: string } | { vanity: string }]> = [
    // The three shapes that need no help from Steam.
    [ID, { steamId: ID }],
    [`https://steamcommunity.com/profiles/${ID}`, { steamId: ID }],
    [`https://steamcommunity.com/profiles/${ID}/`, { steamId: ID }],
    // The one that does.
    ['https://steamcommunity.com/id/gaben', { vanity: 'gaben' }],
    ['https://steamcommunity.com/id/gaben/', { vanity: 'gaben' }],
    ['steamcommunity.com/id/gaben', { vanity: 'gaben' }],
    ['gaben', { vanity: 'gaben' }],
    // Whitespace from a copy-paste must not become part of the name.
    ['  gaben  ', { vanity: 'gaben' }],
    // A profile URL with a trailing path, which is what "copy link" often gives.
    ['https://steamcommunity.com/id/gaben/games/?tab=all', { vanity: 'gaben' }],
  ];

  for (const [input, expected] of cases) {
    const got = steamProfileInput(input);
    check(
      `${JSON.stringify(input)} → ${JSON.stringify(expected)}`,
      JSON.stringify(got) === JSON.stringify(expected),
      JSON.stringify(got)
    );
  }

  // A 16- or 18-digit number is not an id, and must not be sent as one — it
  // goes to ResolveVanityURL, which fails with a message naming the profile.
  check('a 16-digit number is not treated as an ID', 'vanity' in steamProfileInput('7656119800000000'));
}

console.log('\nThe provider manifest');

for (const spec of PROVIDER_LIST) {
  // A capability with no explanation is the thing this whole design exists to
  // prevent, so it is checked rather than trusted.
  const unexplained = Object.entries(spec.capabilities).filter(([, c]) => !c.why || c.why.length < 20);
  check(`${spec.id}: every capability explains itself`, unexplained.length === 0, unexplained.map(([k]) => k).join(', '));

  // An OAuth provider with no client id configured can never connect, and the
  // screen's whole job is naming the variable — so it has to exist.
  if (spec.auth === 'oauth2') {
    check(`${spec.id}: declares a client id field`, spec.credentials.some((f) => f.key === 'clientId'));
    // Every field must still name an env var: that is the other way to supply
    // one, and the message shown when a field is empty says which.
    check(
      `${spec.id}: every field names its env var`,
      spec.credentials.every((f) => /^[A-Z][A-Z0-9_]+$/.test(f.envVar))
    );
    check(`${spec.id}: has an authorize and a token URL`, !!spec.oauth?.authorizeUrl && !!spec.oauth?.tokenUrl);
  }

  /*
   * Every setup link is an absolute https URL.
   *
   * A relative one would resolve against the app's own origin and open a 404
   * inside the PWA, which reads as a broken app rather than a bad link — and it
   * is exactly what a copy-paste from documentation produces.
   */
  for (const step of spec.setup) {
    if (!step.link) continue;
    check(
      `${spec.id}: "${step.link.label}" is an absolute https link`,
      /^https:\/\/\S+$/.test(step.link.url),
      step.link.url
    );
    check(`${spec.id}: "${step.link.label}" has something to click`, step.link.label.trim().length > 0);
  }

  // Same for a citation that claims to be a page rather than an endpoint name,
  // and for the steps that unlock a gated capability.
  for (const [name, capability] of Object.entries(spec.capabilities)) {
    if (capability?.sourceUrl) {
      check(
        `${spec.id}/${name}: sourceUrl is an absolute https link`,
        /^https:\/\/\S+$/.test(capability.sourceUrl),
        capability.sourceUrl
      );
    }

    for (const step of capability?.unlock ?? []) {
      if (!step.link) continue;
      check(
        `${spec.id}/${name}: unlock link "${step.link.label}" is absolute https`,
        /^https:\/\/\S+$/.test(step.link.url),
        step.link.url
      );
    }
  }

  /*
   * A gated capability has to say how to ungate it.
   *
   * `needs-approval` without steps is the same dead end `unavailable` was: a
   * row telling you something is off and leaving you to find the switch. It is
   * the exact complaint Discord's row drew.
   */
  for (const [name, capability] of Object.entries(spec.capabilities)) {
    if (capability?.status !== 'needs-approval') continue;
    check(`${spec.id}/${name}: says how to get the approval`, (capability.unlock?.length ?? 0) > 0);
  }

  // `client` providers have nothing to configure by definition, and a `needs`
  // entry on one would put an un-fixable "not configured" on the screen.
  if (spec.auth === 'client') {
    check(`${spec.id}: asks for no configuration`, spec.credentials.length === 0);
    check(`${spec.id}: is reached locally`, spec.reach === 'local');
  }
}

/* ------------------------------------------------------------------ */

console.log('\nCredentials can be typed in rather than exported');

/*
 * Every provider that needs configuring offers a box for it.
 *
 * The regression this guards against is a provider added later whose id lives
 * only in an environment variable — which is a provider you cannot set up
 * without a terminal, on a screen whose whole point is that you never need one.
 */
for (const spec of PROVIDER_LIST) {
  if (spec.auth !== 'oauth2') continue;
  check(`${spec.id}: has at least one field to fill in`, spec.credentials.length > 0);
  check(
    `${spec.id}: exactly one required client id`,
    spec.credentials.filter((f) => f.key === 'clientId' && f.required).length === 1
  );
}

// A secret field must be marked secret, or the box renders it in plain text.
for (const spec of PROVIDER_LIST) {
  for (const field of spec.credentials) {
    if (field.key !== 'clientSecret') continue;
    check(`${spec.id}: the secret field is masked`, field.secret === true);
  }
}

/*
 * Spotify is PKCE and asks for no secret at all — offering the box would invite
 * pasting one this app has no use for and would then store. Battle.net was the
 * one provider here that genuinely required a secret, and it has been removed.
 */
check(
  'spotify asks for no secret at all, being PKCE',
  !PROVIDERS.spotify.credentials.some((f) => f.key === 'clientSecret')
);

console.log('\nNothing here claims to be impossible');

/*
 * No shipped capability is `unavailable`, and that is a rule rather than a
 * coincidence.
 *
 * The status still exists and the screen still renders it, because a future
 * provider may have a genuine dead end worth stating next to things that work.
 * What is not acceptable is one sitting in the manifest: Battle.net and Epic
 * were rows whose entire content explained why they could do nothing, and
 * YouTube's history said "not possible" directly above the button that imported
 * it — history has since been removed altogether.
 */
for (const spec of PROVIDER_LIST) {
  for (const [name, capability] of Object.entries(spec.capabilities)) {
    check(
      `${spec.id}/${name}: is something that can actually happen`,
      capability?.status !== 'unavailable',
      capability?.why?.slice(0, 60)
    );
  }
}

// And no provider is present purely to apologise for itself.
for (const spec of PROVIDER_LIST) {
  check(
    `${spec.id}: has at least one capability that works`,
    Object.values(spec.capabilities).some((c) => c && c.status !== 'unavailable')
  );
}

console.log('\nFollowing is not friendship');

/*
 * The distinction the Following tab exists for, asserted rather than trusted.
 *
 * Spotify declaring a `friends` capability is precisely what put it on the
 * friends screen only to say it could not help, and it would do so again the
 * moment somebody adds the key back "for completeness".
 */
for (const id of ['spotify', 'youtube'] as const) {
  check(`${id} declares no friends capability`, PROVIDERS[id].capabilities.friends === undefined);
  check(`${id} declares follows instead`, PROVIDERS[id].capabilities.follows !== undefined);
  check(`${id} is not a presence provider`, !PRESENCE_PROVIDERS.includes(id));
  check(`${id} is a follow provider`, FOLLOW_PROVIDERS.includes(id));
}

// And the other way round: a presence provider must not claim a follow list it
// has no way to produce.
for (const id of ['steam', 'riot'] as const) {
  check(`${id} declares no follows capability`, PROVIDERS[id].capabilities.follows === undefined);
}

console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
