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
 * **A throwaway database is not the same as an account.** The coursework rules
 * at the bottom decide whether a task you deleted comes back, and there is no
 * way to assert that without somewhere to write rows — so this ends by
 * migrating a scratch file and driving `syncTasksFromService` against it, with
 * planner items made up here rather than fetched. What is being checked is this
 * app's rules, not Canvas's JSON.
 *
 * Same shape as `voice-check` and `vault-check`: run it before trusting a
 * change to the logic it covers.
 */
// Set before anything that reaches `db/client` is loaded, which is why the two
// server-side imports below are dynamic and the shared one is not.
process.env.DATABASE_URL = 'file:./data/integrations-check.db';
process.env.LOG_LEVEL = 'error';

// Removed here rather than beside the checks that use it: by then the client
// has the file open, and Windows will not unlink a file with a handle on it.
rmSync('./data/integrations-check.db', { force: true });
import { rmSync } from 'node:fs';
import {
  FOLLOW_PROVIDERS,
  LIVE_PROVIDERS,
  MUSIC_CATEGORIES,
  PRESENCE_PROVIDERS,
  PROVIDERS,
  PROVIDER_LIST,
  canvasHostInput,
  categoriseGenres,
  categoriseVideo,
  isHiddenByProviders,
  localPresenceSchema,
  resolveSetupLinks,
  steamProfileInput,
  type MusicCategory,
} from '@everything/shared/integrations';

// Dynamic, so the scratch database above is already chosen by the time this
// pulls in the store and the store pulls in the client.
const { parseIsoDuration } = await import('../features/integrations/providers/youtube.js');

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

console.log('\nSetup links point at your own application when they can');

{
  // The manifest ships a `{appId}` placeholder and the server fills it in. A
  // link reaching the screen still holding it would be a 404 in a new tab.
  const steps = PROVIDERS.discord.capabilities.friends!.unlock!;
  const withId = resolveSetupLinks(steps, '123456789');
  const withoutId = resolveSetupLinks(steps, null);

  check(
    'a known client id deep-links to that application',
    withId[0].link!.url === 'https://discord.com/developers/applications/123456789',
    withId[0].link!.url
  );
  check(
    'and without one it falls back to the applications list',
    withoutId[0].link!.url === 'https://discord.com/developers/applications',
    withoutId[0].link!.url
  );
  check(
    'no placeholder survives either way',
    ![...withId, ...withoutId].some((step) => step.link?.url.includes('{appId}'))
  );
  // A step with no placeholder must come back untouched, or resolving would
  // quietly rewrite the documentation links as well.
  check(
    'a plain link is left alone',
    withId[1].link!.url === 'https://discord.com/developers/docs/discord-social-sdk/getting-started'
  );
}

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

console.log('\nHiding a service');

/*
 * The asymmetry that makes the filter trustworthy, asserted because it is one
 * `some`/`every` away from being exactly wrong — and wrong in the direction
 * that silently removes people you know from two places.
 */
const riotOnly = [{ provider: 'riot' }];
const both = [{ provider: 'riot' }, { provider: 'discord' }];

check('hiding riot drops someone only on riot', isHiddenByProviders(riotOnly, ['riot']));
check('hiding riot keeps someone also on discord', !isHiddenByProviders(both, ['riot']));
check('hiding both drops them', isHiddenByProviders(both, ['riot', 'discord']));
check('hiding nothing drops nobody', !isHiddenByProviders(riotOnly, []));
// `every` on an empty array is true, which would have made an accountless row
// vanish for a reason nobody could have worked out from the screen.
check('a row with no accounts is not hidden', !isHiddenByProviders([], ['riot']));
check('an unknown slug hides nobody', !isHiddenByProviders(riotOnly, ['nintendo']));

console.log('\nWhat the agent is allowed to post');

/*
 * The shape of a local presence report, asserted because getting it wrong is
 * silent in the worst way.
 *
 * `friends` was `friendSchema`, which requires a `provider` on every row. The
 * agent sends it once on the envelope — correctly, since a snapshot cannot span
 * two providers — so every report carrying actual friends was rejected 400 and
 * only the empty ones got through. Both paths that send an empty list are
 * failure paths, so the screen showed a stale connection error while a live
 * list of 164 people never landed, and the only evidence was a wall of
 * identical zod issues in the agent log that nothing surfaced.
 *
 * A round trip through the real schema is the cheapest possible guard against
 * that, and it fails loudly the moment the two sides disagree again.
 */
const report = {
  provider: 'riot',
  clientRunning: true,
  friends: [
    {
      providerUserId: 'puuid-1',
      name: 'Someone#NA1',
      avatarUrl: 'https://raw.communitydragon.org/latest/x/1.jpg',
      state: 'in-game',
      game: 'Ranked Solo/Duo',
    },
  ],
};

const parsed = localPresenceSchema.safeParse(report);
check(
  'a friend without a provider is accepted',
  parsed.success,
  parsed.success ? '' : JSON.stringify(parsed.error.issues[0])
);
check('the envelope still names the provider', parsed.success && parsed.data.provider === 'riot');
/*
 * And an agent that sends it anyway is *tolerated*, not refused.
 *
 * Rejecting the extra key would recreate the original failure with the sides
 * swapped — a newer agent sending one more field would have its whole report
 * thrown out, and this feature's failure mode is that the screen looks fine
 * while nothing lands. Zod strips unknown keys by default, which is the right
 * behaviour here; this asserts it rather than leaving it to the default's
 * continued good manners.
 */
const tolerant = localPresenceSchema.safeParse({
  ...report,
  friends: [{ ...report.friends[0], provider: 'riot', somethingNewer: true }],
});
check('an unexpected field on a friend is ignored, not fatal', tolerant.success);
check(
  'and it does not survive into the stored row',
  tolerant.success && !('provider' in tolerant.data.friends[0])
);

/* ------------------------------------------------------------------ */

console.log('\nWhich Canvas do you mean');

/*
 * The box takes whatever is in the address bar, which is nearly always a full
 * URL with a course path on the end. A validator demanding a bare hostname would
 * reject the exact thing everybody pastes first.
 */
function canvasHost(raw: string, expected: string | null): void {
  const got = canvasHostInput(raw);
  check(`${JSON.stringify(raw)} -> ${expected ?? 'refused'}`, got === expected, `got ${String(got)}`);
}

canvasHost('canvas.myschool.edu', 'https://canvas.myschool.edu');
canvasHost('https://canvas.myschool.edu', 'https://canvas.myschool.edu');
canvasHost('https://canvas.myschool.edu/', 'https://canvas.myschool.edu');
canvasHost('https://myschool.instructure.com/courses/1234/assignments', 'https://myschool.instructure.com');
canvasHost('  myschool.instructure.com  ', 'https://myschool.instructure.com');
canvasHost('canvas.myschool.edu:8443', 'https://canvas.myschool.edu:8443');

/*
 * **http is refused rather than quietly upgraded.** A Canvas token is the whole
 * account — there is no read-only kind to ask for — so a scheme typed by mistake
 * would put it on the wire in the clear. Rewriting it to https would be the
 * friendlier behaviour and the wrong one: if somebody has genuinely typed http,
 * the thing to find out is why.
 */
canvasHost('http://canvas.myschool.edu', null);
canvasHost('localhost:3000', null);
canvasHost('not a url at all', null);
canvasHost('', null);

/* ------------------------------------------------------------------ */

console.log('\nCoursework is not a friends list');

/*
 * `assignments` is the first capability whose output lands in *core* rather than
 * on one of this feature's own screens, and the tempting mistake is the one
 * `follows` and `friends` already suffered: filing it under something that
 * already exists. A Canvas deadline is not a playlist and not a person, and a
 * provider appearing in `PRESENCE_PROVIDERS` would put "Canvas" on a screen
 * about who is online.
 */
check('canvas declares assignments', PROVIDERS.canvas.capabilities.assignments !== undefined);
check('canvas declares no friends capability', PROVIDERS.canvas.capabilities.friends === undefined);
check('canvas declares no follows capability', PROVIDERS.canvas.capabilities.follows === undefined);
check('canvas is not a presence provider', !PRESENCE_PROVIDERS.includes('canvas'));
check('canvas is not a follow provider', !FOLLOW_PROVIDERS.includes('canvas'));
/*
 * And nothing else may claim it. `assignments` writes tasks, so a provider
 * declaring it with no code behind it would render a Sync button that silently
 * does nothing at all.
 */
check(
  'nothing else claims assignments',
  PROVIDER_LIST.filter((p) => p.capabilities.assignments).length === 1
);

/* ------------------------------------------------------------------ */

console.log('\nReading the planner');

const { nextPage, toTask } = await import('../features/integrations/providers/canvas.js');

const BASE = 'https://canvas.example.edu';

/*
 * Canvas paginates by `Link` header rather than by a cursor in the body, so
 * there is nothing in the JSON to follow. Getting this wrong does not throw —
 * it silently stops at the first page, which presents as "Canvas only has fifty
 * things in it" and sends you looking at Canvas.
 */
const LINK =
  `<${BASE}/api/v1/planner/items?page=1>; rel="current",` +
  `<${BASE}/api/v1/planner/items?page=2>; rel="next",` +
  `<${BASE}/api/v1/planner/items?page=1>; rel="first"`;
check('the next page comes out of the Link header', nextPage(LINK, BASE) === `${BASE}/api/v1/planner/items?page=2`);
check('the last page has no next', nextPage(`<${BASE}/api/v1/planner/items?page=1>; rel="current"`, BASE) === null);
check('no header at all is the end of the list', nextPage(null, BASE) === null);
/*
 * **A next link on another host is not followed.** This is a URL out of a
 * response header, and following it means handing over a bearer token that is
 * the whole Canvas account — there is no read-only kind to ask for.
 */
check(
  'a next page on another host is refused',
  nextPage('<https://elsewhere.example/api/v1/planner/items?page=2>; rel="next"', BASE) === null
);

/*
 * The mapping. Written out by hand rather than fetched: what is being checked
 * is this app's rules about a documented shape, not that a mock of Canvas
 * matches the code that reads it.
 */
const plannerItem = (over: Record<string, unknown> = {}) => ({
  plannable_type: 'assignment',
  plannable_id: 91,
  context_name: 'HIST 210',
  html_url: '/courses/12/assignments/91',
  plannable: { title: 'Essay on Rome', due_at: '2026-09-01T23:59:00Z' },
  submissions: { submitted: false },
  ...over,
});

const mapped = toTask(plannerItem(), BASE);
check('an assignment maps to a task', mapped?.title === 'Essay on Rome', JSON.stringify(mapped));
check('with the course name', mapped?.context === 'HIST 210');
check('with the deadline parsed', mapped?.dueAt === Date.parse('2026-09-01T23:59:00Z'));
/*
 * `html_url` is a path. Storing it as one gives a link that resolves against
 * this app's own origin and opens a 404 inside the PWA — which reads as the app
 * being broken rather than the link being wrong.
 */
check('and an absolute link', mapped?.url === `${BASE}/courses/12/assignments/91`, String(mapped?.url));

/* The id has to carry the kind: assignment 91 and quiz 91 are two things. */
check('the id names the kind', mapped?.externalId === 'assignment:91');
check('so a quiz with the same number differs', toTask(plannerItem({ plannable_type: 'quiz' }), BASE)?.externalId === 'quiz:91');

check('submitted work is marked done', toTask(plannerItem({ submissions: { submitted: true } }), BASE)?.done === true);
check('excused work counts as done', toTask(plannerItem({ submissions: { excused: true } }), BASE)?.done === true);
check(
  'and so does ticking it off in Canvas itself',
  toTask(plannerItem({ planner_override: { marked_complete: true } }), BASE)?.done === true
);
/*
 * `submissions: false` is what Canvas sends when there is nothing to hand in —
 * an ungraded discussion, say — rather than an object with everything unset.
 * Reading it as an object would throw; reading it as truthy would mark
 * everything done.
 */
check('nothing to hand in is not the same as handed in', toTask(plannerItem({ submissions: false }), BASE)?.done === false);

/* Dismissed in Canvas is the same request, made of a different screen. */
check('dismissed in Canvas is left alone', toTask(plannerItem({ planner_override: { dismissed: true } }), BASE) === null);

/*
 * A note you wrote in Canvas is not coursework — importing those would have two
 * apps quietly competing over one list. A lecture in the calendar is a fact
 * about your timetable, not something with an outcome.
 */
check('a planner note is not coursework', toTask(plannerItem({ plannable_type: 'planner_note' }), BASE) === null);
check('nor is a calendar event', toTask(plannerItem({ plannable_type: 'calendar_event' }), BASE) === null);

/*
 * Undated coursework is real work and is not a deadline, and something with no
 * date is not something the nudge engine can hold for a good moment.
 */
check(
  'undated coursework is skipped',
  toTask(plannerItem({ plannable: { title: 'Read chapter 4' }, plannable_date: undefined }), BASE) === null
);
/* ...but `plannable_date` stands in when the assignment itself carries no due date. */
check(
  'the planner date stands in for a missing due date',
  toTask(plannerItem({ plannable: { title: 'Read chapter 4' }, plannable_date: '2026-09-05T00:00:00Z' }), BASE)
    ?.dueAt === Date.parse('2026-09-05T00:00:00Z')
);


/* ------------------------------------------------------------------ */

console.log('\nCoursework, and what happens to a task you deleted');

/*
 * The only part of this file that needs a database, and the part most worth
 * having one for. Every rule below is here because the obvious implementation
 * gets it wrong in a way you would not notice for weeks.
 */
const { runMigrations } = await import('../db/migrate.js');
await runMigrations();

const { db } = await import('../db/client.js');
const { tasks: taskTable } = await import('../db/schema.js');
const { eq } = await import('drizzle-orm');
const { syncTasksFromService } = await import('../features/integrations/store.js');

const DUE = Date.parse('2026-09-01T23:59:00Z');
const essay = { externalId: 'assignment:1', title: 'Essay on Rome', context: 'HIST 210', dueAt: DUE, done: false };

const first = await syncTasksFromService('canvas', [essay]);
check('a new assignment becomes a task', first.created === 1, JSON.stringify(first));

const [row] = await db.select().from(taskTable).where(eq(taskTable.source, 'canvas'));
check('with its deadline', row?.dueAt === DUE, String(row?.dueAt));
check('and the course in the notes', row?.notes === 'HIST 210', String(row?.notes));
check('and a real time of day, not an all-day date', row?.dueIsAllDay === 0);

const again = await syncTasksFromService('canvas', [essay]);
check('syncing again does not make a second one', again.created === 0 && again.untouched === 1);

/*
 * A deadline extension is weekly and a stale `dueAt` makes the nudge engine
 * wrong, which is the one thing this feature exists to get right.
 */
const moved = DUE + 7 * 24 * 60 * 60_000;
const extended = await syncTasksFromService('canvas', [{ ...essay, dueAt: moved }]);
check('an extension is carried across', extended.rescheduled === 1, JSON.stringify(extended));
const [afterMove] = await db.select().from(taskTable).where(eq(taskTable.id, row.id));
check('and the task really moved', afterMove?.dueAt === moved);

/*
 * A title renamed here is *yours*. There is no signal that could tell "you
 * renamed it" apart from "they renamed it", so the service is not allowed to
 * win — only the deadline is carried across afterwards.
 */
await db.update(taskTable).set({ title: 'Rome essay — the one about roads' }).where(eq(taskTable.id, row.id));
await syncTasksFromService('canvas', [{ ...essay, dueAt: moved, title: 'Essay on Rome' }]);
const [afterRename] = await db.select().from(taskTable).where(eq(taskTable.id, row.id));
check('a title you changed is not overwritten', afterRename?.title === 'Rome essay — the one about roads');

/* Handing it in at the service closes the task. */
const handed = await syncTasksFromService('canvas', [{ ...essay, dueAt: moved, done: true }]);
check('handing it in ticks the task off', handed.completed === 1, JSON.stringify(handed));
const [afterDone] = await db.select().from(taskTable).where(eq(taskTable.id, row.id));
check('and the task is done', afterDone?.status === 'done');

/*
 * ...and never the other way. Submissions get retracted and windows reopened,
 * and a task coming back to life is the app arguing with you about something
 * you had finished.
 */
const unsubmitted = await syncTasksFromService('canvas', [{ ...essay, dueAt: moved, done: false }]);
check('but a task you finished is never reopened', unsubmitted.created === 0 && unsubmitted.rescheduled === 0);
const [stillDone] = await db.select().from(taskTable).where(eq(taskTable.id, row.id));
check('and it stays done', stillDone?.status === 'done');

/*
 * **The one this table exists for.** Deduplicating by looking for the task
 * itself — which a `(source, source_id)` unique index on `tasks` would give you
 * — recreates one you deliberately threw away, on the very next sync, with
 * nothing on screen to explain it.
 */
await db.delete(taskTable).where(eq(taskTable.id, row.id));
const afterDelete = await syncTasksFromService('canvas', [{ ...essay, dueAt: moved }]);
check('a task you deleted does not come back', afterDelete.created === 0, JSON.stringify(afterDelete));
const left = await db.select().from(taskTable).where(eq(taskTable.source, 'canvas'));
check('and nothing was recreated behind it', left.length === 0, `${left.length} rows`);

/*
 * A term's worth of finished work must not arrive as a hundred tasks the first
 * time you connect. Already-submitted items are recorded and never made.
 */
const old = await syncTasksFromService('canvas', [
  { externalId: 'assignment:2', title: 'Long-finished problem set', dueAt: DUE, done: true },
]);
check('work already handed in never becomes a task', old.created === 0 && old.untouched === 1);

/* Two things with the same numeric id, on different kinds, are two things. */
const clash = await syncTasksFromService('canvas', [
  { externalId: 'assignment:9', title: 'Assignment nine', dueAt: DUE, done: false },
  { externalId: 'quiz:9', title: 'Quiz nine', dueAt: DUE, done: false },
]);
check('assignment 9 and quiz 9 are not the same row', clash.created === 2, JSON.stringify(clash));


/* ------------------------------------------------------------------ */

console.log('\nWho is on air');

/*
 * `live` is not a flavour of `follows`, and the tempting mistake is the one
 * `friends` and `follows` already suffered: following somebody is a standing
 * fact about you, while being live is a fact about them that is true for three
 * hours on a Tuesday. One list you curate, one empties itself.
 */
check('twitch declares live', PROVIDERS.twitch.capabilities.live !== undefined);
check('…and follows, which is a different list', PROVIDERS.twitch.capabilities.follows !== undefined);
check('twitch is a live provider', LIVE_PROVIDERS.includes('twitch'));
check('twitch is a follow provider', FOLLOW_PROVIDERS.includes('twitch'));
check('twitch is not a presence provider', !PRESENCE_PROVIDERS.includes('twitch'));

/*
 * **YouTube must not declare `live`, and that is a number rather than a
 * preference.** There is no "which of my subscriptions are live" endpoint; the
 * only route is `search.list` per channel at 100 quota units against a
 * 10,000/day default, so a few hundred subscriptions cost several times the
 * whole day's allowance for one refresh — and would take the playlist and
 * Following syncs down with it. The assertion exists because "add it for
 * completeness" is exactly the change somebody would make.
 */
check('youtube does not claim live', PROVIDERS.youtube.capabilities.live === undefined);
check('so only one provider answers it', LIVE_PROVIDERS.length === 1, LIVE_PROVIDERS.join(', '));

/*
 * Twitch is the first provider here that genuinely needs a client secret —
 * PKCE has never shipped for their authorization code flow. Declaring `pkce:
 * true` would send a code verifier and no secret, and the token endpoint would
 * refuse every login with nothing on screen but "400".
 */
check('twitch does not claim PKCE', PROVIDERS.twitch.oauth?.pkce === false);
check(
  '…and therefore offers a secret field',
  PROVIDERS.twitch.credentials.some((field) => field.key === 'clientSecret' && field.required)
);
check(
  'a PKCE provider still offers no secret',
  !PROVIDERS.spotify.credentials.some((field) => field.key === 'clientSecret')
);

/* The live scope is the same one the followed-channels list needs. */
check('twitch asks for the follows scope', PROVIDERS.twitch.oauth?.scopes.includes('user:read:follows') === true);

/*
 * The glyph is how a provider row is picked out of seven at a glance, so two
 * sharing one costs exactly the thing it is there for. Twitch shipped wearing
 * YouTube's television for about ten minutes.
 */
const glyphs = PROVIDER_LIST.map((p) => p.glyph);
check('every provider has its own glyph', new Set(glyphs).size === glyphs.length, glyphs.join(' '));


console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
