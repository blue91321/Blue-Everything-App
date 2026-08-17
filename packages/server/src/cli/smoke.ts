/**
 * End-to-end proof that the nudge engine holds and releases correctly.
 *
 * Drives the real API in-process against a throwaway database. The assertion
 * that matters is the middle one: a task due soon must stay silent while a
 * match is live, then arrive the moment it ends.
 *
 *   npm run smoke -w @everything/server
 */
process.env.DATABASE_URL = 'file:./data/smoke.db';
process.env.AUTH_REQUIRED = 'false';
process.env.LOG_LEVEL = 'error';

import { rmSync } from 'node:fs';
import type { AttentionReport } from '@everything/shared';

rmSync('./data/smoke.db', { force: true });

// Imported after the env is set, so config picks up the throwaway database.
const { runMigrations } = await import('../db/migrate.js');
const { buildApp } = await import('../app.js');

await runMigrations();
const app = await buildApp();

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// Several of these endpoints take no body; Fastify still wants one, so the
// default stands in rather than every call site writing `{}`.
const post = async (url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, payload: payload as object });

const report = (over: Partial<AttentionReport>): AttentionReport => ({
  state: 'free',
  reason: 'smoke test',
  idleMs: 0,
  liveGames: [],
  // Both are required on the report and were being left out, so the base object
  // was not actually an AttentionReport. Silent until the server was typechecked.
  audioPlaying: false,
  windowsDnd: false,
  ...over,
});

console.log('\nhealth');
const health = await app.inject({ method: 'GET', url: '/health' });
check('server boots and the database answers', health.statusCode === 200);

// Every check that isn't *about* going quiet has to switch it off first, or
// this suite passes or fails depending on what time of day it runs.
await app.inject({ method: 'PATCH', url: '/api/settings', payload: { quietHoursEnabled: false } });

console.log('\ntask -> nudge');
const created = await post('/api/tasks', {
  title: 'Take the bins out',
  priority: 1,
  dueAt: Date.now() + 30 * 60_000,
});
check('task created', created.statusCode === 201);

console.log('\nholding during a match');
const midGame = await post(
  '/api/attention',
  report({ state: 'in-game', reason: 'League of Legends.exe running', liveGames: ['league of legends.exe'] })
);
const midGameBody = midGame.json();
check('nothing delivered mid-game', midGameBody.deliver.length === 0, `moment=${midGameBody.moment}`);

const queued = await app.inject({ method: 'GET', url: '/api/nudges/queue' });
check('but a nudge is waiting in the queue', queued.json().length === 1);

console.log('\nreleasing at the stopping point');
const afterGame = await post(
  '/api/attention',
  report({ reason: 'match ended', stoppingPoint: { quality: 'prime', reason: 'League of Legends just ended' } })
);
const afterBody = afterGame.json();
const titles = (res: { json(): { deliver: { title: string; escalated: boolean }[] } }) =>
  res.json().deliver.map((n) => n.title);
check('nudge fires when the match ends', titles(afterGame).includes('Take the bins out'), titles(afterGame).join(', '));
check('and it was not an escalation', afterBody.deliver[0]?.escalated === false);

// Regression: the sweep used to re-queue a task the moment its nudge stopped
// being pending, which on a 2s agent poll meant a toast every 2 seconds.
console.log('\nback-off after delivery');
const immediately = await post('/api/attention', report({ reason: 'moments later' }));
check('an ignored task does not immediately nudge again', titles(immediately).length === 0, titles(immediately).join(', '));

console.log('\nquality gating');
await post('/api/nudges', { title: 'Only at a prime moment', minQuality: 'prime' });
const ordinary = await post('/api/attention', report({ reason: 'ordinary desktop use' }));
check('a prime-only nudge stays put during ordinary use', !titles(ordinary).includes('Only at a prime moment'));

const primeMoment = await post(
  '/api/attention',
  report({ reason: 'back at the desk', stoppingPoint: { quality: 'prime', reason: 'back from a break' } })
);
check('and fires at a prime moment', titles(primeMoment).includes('Only at a prime moment'), titles(primeMoment).join(', '));

console.log('\ndeadline escalation');
await post('/api/nudges', {
  title: 'This one is late',
  minQuality: 'prime',
  deadlineAt: Date.now() - 1000,
});
const escalated = await post(
  '/api/attention',
  report({ state: 'in-game', reason: 'still playing', liveGames: ['cs2.exe'] })
);
const escalatedBody = escalated.json();
check('a passed deadline breaks through mid-game', titles(escalated).includes('This one is late'));
check('and is marked as an escalation', escalatedBody.deliver[0]?.escalated === true);

console.log('\nnobody at the desk');
await post('/api/nudges', { title: 'Nobody is here', minQuality: 'any', deadlineAt: Date.now() - 1000 });
const away = await post('/api/attention', report({ state: 'away', reason: 'idle 12m', idleMs: 12 * 60_000 }));
check('nothing fires at an empty chair, even past deadline', titles(away).length === 0, titles(away).join(', '));

console.log('\nquiet hours');
const clockNow = new Date();
const minuteNow = clockNow.getHours() * 60 + clockNow.getMinutes();
const wrap = (m: number) => ((m % 1440) + 1440) % 1440;

// A window that definitely contains right now, including across midnight.
await app.inject({
  method: 'PATCH',
  url: '/api/settings',
  payload: {
    quietHoursEnabled: true,
    quietStartMinute: wrap(minuteNow - 30),
    quietEndMinute: wrap(minuteNow + 30),
  },
});
await post('/api/nudges', { title: 'Should stay silent', minQuality: 'any' });
const duringQuiet = await post('/api/attention', report({ reason: 'awake but it is quiet hours' }));
check('nothing fires during quiet hours', titles(duringQuiet).length === 0, titles(duringQuiet).join(', '));

await post('/api/nudges', { title: 'Late and quiet', minQuality: 'any', deadlineAt: Date.now() - 1000 });
const quietDeadline = await post('/api/attention', report({ reason: 'still quiet' }));
check('not even a passed deadline wakes you', titles(quietDeadline).length === 0, titles(quietDeadline).join(', '));

// Turning them off must not disturb the times — that was the bug.
const disabled = await app.inject({
  method: 'PATCH',
  url: '/api/settings',
  payload: { quietHoursEnabled: false },
});
const disabledBody = disabled.json();
check(
  'turning quiet hours off keeps the times',
  disabledBody.quietStartMinute === wrap(minuteNow - 30) && disabledBody.quietEndMinute === wrap(minuteNow + 30),
  `${disabledBody.quietStartMinute}-${disabledBody.quietEndMinute}`
);

const afterQuiet = await post('/api/attention', report({ reason: 'quiet hours over' }));
check('and they arrive once quiet hours end', titles(afterQuiet).includes('Should stay silent'), titles(afterQuiet).join(', '));

console.log('\nother ways to go quiet');
await app.inject({ method: 'PATCH', url: '/api/settings', payload: { followWindowsDnd: true } });
await post('/api/nudges', { title: 'Windows says not now', minQuality: 'any' });
const winDnd = await post('/api/attention', report({ reason: 'Windows DND is on', windowsDnd: true }));
check('Windows Do Not Disturb silences it', titles(winDnd).length === 0, titles(winDnd).join(', '));

const winOff = await post('/api/attention', report({ reason: 'Windows DND off', windowsDnd: false }));
check('and it resumes when Windows DND goes off', titles(winOff).includes('Windows says not now'), titles(winOff).join(', '));

await app.inject({ method: 'PATCH', url: '/api/settings', payload: { dndUntil: Date.now() + 60 * 60_000 } });
await post('/api/nudges', { title: 'Manually paused', minQuality: 'any' });
const paused = await post('/api/attention', report({ reason: 'paused by hand' }));
check('a manual pause silences it', titles(paused).length === 0, titles(paused).join(', '));

await app.inject({ method: 'PATCH', url: '/api/settings', payload: { dndUntil: null } });
const unpaused = await post('/api/attention', report({ reason: 'pause cleared' }));
check('and clearing the pause releases it', titles(unpaused).includes('Manually paused'), titles(unpaused).join(', '));

console.log('\nrecurring reminders expire instead of stacking');
await post('/api/nudges', {
  title: 'Drink water (stale)',
  minQuality: 'any',
  expiresAt: Date.now() - 1000,
});
const stale = await post('/api/attention', report({ reason: 'long after the reminder mattered' }));
check('an expired reminder never fires', !titles(stale).includes('Drink water (stale)'), titles(stale).join(', '));

console.log('\nlocal trust cannot be reached through a proxy');
{
  // `tailscale serve` terminates TLS and forwards to 127.0.0.1, so every
  // tailnet caller arrives on a loopback socket. Trusting the socket alone
  // handed the whole tailnet unauthenticated access; these pin the fix.
  const { isTrustedLocal } = await import('../auth.js');
  const fake = (over: Record<string, unknown> = {}) =>
    ({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:8787' },
      ...over,
    }) as never;

  check('a browser on this PC is trusted', isTrustedLocal(fake()));
  check(
    'but a request proxied in from the tailnet is not',
    !isTrustedLocal(fake({ headers: { host: 'desktop-abc.tail1234.ts.net' } }))
  );
  check(
    'nor one carrying a forwarding header',
    !isTrustedLocal(fake({ headers: { host: '127.0.0.1:8787', 'x-forwarded-for': '100.64.0.9' } }))
  );
  check(
    'nor one from a real remote socket',
    !isTrustedLocal(fake({ socket: { remoteAddress: '192.168.0.5' }, headers: { host: '192.168.0.19:8787' } }))
  );

  /*
   * The one that caught a real bug, which is why it is pinned here.
   *
   * A browser arriving from accounts.google.com sends `Sec-Fetch-Site:
   * cross-site`, and `isTrustedLocal` refuses it — correctly, since that check
   * is what stops a page you are reading from talking to 127.0.0.1 behind your
   * back. The OAuth callback was put under `/api/` on the reasoning that a
   * loopback socket and a loopback Host would be enough, and it answered
   * `missing bearer token` on the first real connection attempt.
   *
   * Neither `app.inject()` nor curl sends that header, which is exactly why it
   * survived testing.
   */
  check(
    'a cross-site navigation is not trusted, even from loopback',
    !isTrustedLocal(fake({ headers: { host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' } }))
  );
}

console.log('\nthe OAuth callback survives being a cross-site redirect');
{
  // It has to answer without a token: a redirect from Google carries none and
  // never will. A 401 here is the bug that shipped. A 4xx *from the route* is
  // correct — the code and state below are invented.
  const response = await app.inject({
    method: 'GET',
    url: '/oauth/callback/youtube?code=made-up&state=made-up',
    headers: { host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  });

  check('it is not refused for want of a bearer token', response.statusCode !== 401, `got ${response.statusCode}`);
  check('it renders a page rather than JSON', (response.headers['content-type'] ?? '').toString().includes('text/html'));
  check(
    'and an unknown state is still rejected',
    /expired|not started/.test(response.body),
    response.body.slice(0, 140)
  );
}

console.log('\naway from the PC (phone push gating)');
const { isAwayFromPc, AWAY_FROM_PC_IDLE_MS } = await import('@everything/shared');
const longIdle = AWAY_FROM_PC_IDLE_MS + 60_000;

// Pure rule checks — no phone needed, and these are the ones that must not be
// wrong: a false positive buzzes your pocket while you're sat watching something.
check('idle + silent counts as away', isAwayFromPc({ idleMs: longIdle, audioPlaying: false }));
check('idle but audio playing does NOT', !isAwayFromPc({ idleMs: longIdle, audioPlaying: true }));
check('silent but recently active does NOT', !isAwayFromPc({ idleMs: 60_000, audioPlaying: false }));
check(
  'a two-hour film does not count as away',
  !isAwayFromPc({ idleMs: 2 * 60 * 60_000, audioPlaying: true })
);

// With no phone subscribed, an away nudge must stay queued rather than being
// quietly consumed.
await post('/api/nudges', { title: 'Waiting for the phone', minQuality: 'any' });
const awayNoPhone = await post(
  '/api/attention',
  report({ state: 'away', reason: 'out of the room', idleMs: longIdle, audioPlaying: false })
);
const awayBody = awayNoPhone.json();
check('nothing toasts at an empty desk', awayBody.deliver.length === 0);
check('the server agrees you are away', awayBody.awayFromPc === true);
check('and with no phone subscribed nothing is pushed', awayBody.pushed === 0);

// A `prime`-only nudge must still be able to reach the phone: minQuality asks
// about breaks on the PC, and there is no PC activity to break into.
await post('/api/nudges', { title: 'Prime-only, but you have left', minQuality: 'prime' });
const primeWhileAway = await post(
  '/api/attention',
  report({ state: 'away', reason: 'still out', idleMs: longIdle, audioPlaying: false })
);
check(
  'a prime-only nudge is eligible for the phone',
  primeWhileAway.json().awayFromPc === true && primeWhileAway.json().deliver.length === 0
);

const stillQueued = await app.inject({ method: 'GET', url: '/api/nudges/queue' });
check(
  'so it stays queued rather than vanishing',
  stillQueued.json().some((n: { title: string }) => n.title === 'Waiting for the phone')
);

// Back at the desk it should arrive as a toast, proving nothing was lost.
const backAtDesk = await post('/api/attention', report({ reason: 'back at the keyboard', idleMs: 0 }));
check('and arrives as a toast once you return', titles(backAtDesk).includes('Waiting for the phone'), titles(backAtDesk).join(', '));

console.log('\nticking a habit restarts its reminder clock');
{
  const { sweepHabitReminders, reminderWindowOpen } = await import('../nudge-engine.js');
  const habit = (await post('/api/habits', { name: 'Drink water', cadence: 'daily', targetPerPeriod: 8 })).json();
  await app.inject({
    method: 'PATCH',
    url: `/api/habits/${habit.id}`,
    payload: { reminderEveryMinutes: 60 },
  });

  const { db } = await import('../db/client.js');
  const { nudges: nudgeTable } = await import('../db/schema.js');
  const { eq: whereEq } = await import('drizzle-orm');

  const t0 = Date.now();
  check('raises the first reminder', (await sweepHabitReminders(t0)) === 1);
  check('and not a second straight away', (await sweepHabitReminders(t0 + 60_000)) === 0);

  /**
   * Both the nudge and a tick get real timestamps, so the only way to put real
   * distance between them is to age the nudge. Ninety minutes back, and spent,
   * means the habit is unambiguously due another reminder — unless something
   * else reset the clock.
   */
  const ageOutTheReminder = async () => {
    await db
      .update(nudgeTable)
      .set({ createdAt: Date.now() - 90 * 60_000, state: 'expired' })
      .where(whereEq(nudgeTable.habitId, habit.id));
  };

  await ageOutTheReminder();
  check('a stale reminder means another is due', (await sweepHabitReminders(Date.now())) === 1, '90 minutes on');

  // Now the same situation, except you have just drunk a glass.
  await ageOutTheReminder();
  await post(`/api/habits/${habit.id}/check`);
  check(
    'but ticking it off buys the full interval again',
    (await sweepHabitReminders(Date.now())) === 0,
    'the tick reset the clock'
  );
  check(
    'and the next one lands an interval after the tick',
    (await sweepHabitReminders(Date.now() + 61 * 60_000)) === 1
  );

  console.log('\nreminder start time');
  check('9:00 is not yet open for a 14:00 start', !reminderWindowOpen(14 * 60, new Date(2026, 7, 6, 9, 0)));
  check('14:00 is open', reminderWindowOpen(14 * 60, new Date(2026, 7, 6, 14, 0)));
  check('20:00 is still open', reminderWindowOpen(14 * 60, new Date(2026, 7, 6, 20, 0)));

  const walk = (await post('/api/habits', { name: 'Take a walk', cadence: 'daily' })).json();
  await app.inject({
    method: 'PATCH',
    url: `/api/habits/${walk.id}`,
    // 23:59 so the window is shut whenever this suite happens to run.
    payload: { reminderEveryMinutes: 30, reminderStartMinute: 23 * 60 + 59 },
  });
  const before = (await app.inject({ method: 'GET', url: '/api/nudges/queue' })).json().length;
  await sweepHabitReminders(new Date(2026, 7, 6, 9, 0).getTime());
  const after = (await app.inject({ method: 'GET', url: '/api/nudges/queue' })).json().length;
  check('a habit whose time has not come raises nothing', after === before);
}

console.log('\nall-day tasks');
{
  const { sweepDueTasks } = await import('../nudge-engine.js');
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const allDay = (await post('/api/tasks', { title: 'Bins out', dueAt: midnight.getTime(), dueIsAllDay: true })).json();
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  check('a bare date is stored as end of that day', allDay.dueAt === endOfDay.getTime(), new Date(allDay.dueAt).toTimeString().slice(0, 8));
  check('and is flagged all-day', allDay.dueIsAllDay === 1);

  // The point of the flag: eligible from the morning, not at 22:59.
  await sweepDueTasks(Date.now());
  const queued = (await app.inject({ method: 'GET', url: '/api/nudges/queue' })).json();
  const mine = queued.find((n: { taskId: string }) => n.taskId === allDay.id);
  check('it queues straight away rather than an hour before midnight', Boolean(mine));
  check('and is eligible now', mine && mine.earliestAt <= Date.now());

  const timed = (await post('/api/tasks', { title: 'Call the dentist', dueAt: Date.now() + 3 * 60 * 60_000 })).json();
  check('a task with a time keeps that exact time', timed.dueAt > Date.now() + 2 * 60 * 60_000);
  check('and is not flagged all-day', timed.dueIsAllDay === 0);
}

console.log('\nsnooze');
const snoozeTarget = await post('/api/nudges', { title: 'Snooze me', minQuality: 'any' });
await post(`/api/nudges/${snoozeTarget.json().id}/snooze`, { minutes: 30 });
const afterSnooze = await post('/api/attention', report({ reason: 'right after snoozing' }));
const snoozedFired = afterSnooze.json().deliver.some((n: { title: string }) => n.title === 'Snooze me');
check('a snoozed nudge stays quiet', !snoozedFired);

/*
 * Per-item phone push.
 *
 * Last, because it installs a fake phone that reports every send as a success —
 * which drains whatever is still queued from the sections above. Nothing after
 * this could assume a queue it had left full.
 */
/*
 * A held nudge must still be true when it finally lands.
 *
 * The queue exists to wait for a good moment, so a nudge routinely sits for an
 * hour — and in that hour the thing it is about can be done. Delivering a stale
 * count afterwards is worse than delivering nothing: it is confidently wrong,
 * and the whole point of waiting was spent saying something untrue.
 */
console.log('\na nudge held through a game is re-checked before it lands');
{
  const { sweepHabitReminders } = await import('../nudge-engine.js');
  const { db } = await import('../db/client.js');
  const { nudges: nudgeTable } = await import('../db/schema.js');
  const { eq: whereEq } = await import('drizzle-orm');

  const habit = (await post('/api/habits', { name: 'Stretch', cadence: 'daily', targetPerPeriod: 4 })).json();
  await app.inject({ method: 'PATCH', url: `/api/habits/${habit.id}`, payload: { reminderEveryMinutes: 30 } });

  await sweepHabitReminders(Date.now());
  const raised = (await app.inject({ method: 'GET', url: '/api/nudges/queue' })).json();
  const mine = raised.find((n: { habitId: string }) => n.habitId === habit.id);
  check('the reminder is raised with the count at the time', mine?.body === '0 of 4 so far today', mine?.body);

  // Two of them done while the nudge waits — exactly what a match is long
  // enough for.
  await post(`/api/habits/${habit.id}/check`);
  await post(`/api/habits/${habit.id}/check`);

  const landed = await post('/api/attention', report({ reason: 'match over', idleMs: 0 }));
  const shown = landed.json().deliver.find((n: { habitId: string }) => n.habitId === habit.id);
  check('it arrives with the count as it is *now*', shown?.body === '2 of 4 so far today', shown?.body);

  // And the interval runs from when it was said, not from when it was written
  // down — otherwise a long session is rewarded with two reminders in a minute.
  check('another is not due straight after', (await sweepHabitReminders(Date.now())) === 0);
  const [row] = await db.select().from(nudgeTable).where(whereEq(nudgeTable.habitId, habit.id));
  check('and it was stamped with a delivery time to count from', typeof row.deliveredAt === 'number');
}

console.log('\n…and one whose reason has gone is dropped, not shown');
{
  const { sweepHabitReminders, sweepDueTasks } = await import('../nudge-engine.js');

  // Finished entirely while the nudge waited.
  const done = (await post('/api/habits', { name: 'Vitamins', cadence: 'daily', targetPerPeriod: 1 })).json();
  await app.inject({ method: 'PATCH', url: `/api/habits/${done.id}`, payload: { reminderEveryMinutes: 30 } });
  await sweepHabitReminders(Date.now());
  await post(`/api/habits/${done.id}/check`);

  const afterHabit = await post('/api/attention', report({ reason: 'back at the desk', idleMs: 0 }));
  check(
    'a habit finished while it waited is not nagged about',
    !afterHabit.json().deliver.some((n: { habitId: string }) => n.habitId === done.id)
  );

  // Same shape for a task: nothing clears its nudge when it is completed.
  const task = (await post('/api/tasks', { title: 'Post the letter', dueAt: Date.now() + 20 * 60_000, priority: 3 })).json();
  await sweepDueTasks(Date.now());
  await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { status: 'done' } });

  const afterTask = await post(
    '/api/attention',
    report({ reason: 'a good break', idleMs: 0, stoppingPoint: { quality: 'prime', reason: 'match ended' } })
  );
  check(
    'a task completed while it waited is not nagged about',
    !afterTask.json().deliver.some((n: { taskId: string }) => n.taskId === task.id),
    titles(afterTask).join(', ')
  );
}

console.log('\nper-item phone push');
{
  const { resolvePush } = await import('@everything/shared');
  const { providePush, resetPushPort } = await import('../push-port.js');
  const { sweepDueTasks } = await import('../nudge-engine.js');
  const { db } = await import('../db/client.js');
  const { nudges: nudgeTable } = await import('../db/schema.js');
  const { eq: whereEq } = await import('drizzle-orm');

  // The three-state rule on its own. The null is the whole point of the design:
  // it has to keep tracking the default rather than freezing today's answer.
  check('an unset item follows the default', resolvePush(null, true) === true);
  check('…and follows it downwards too', resolvePush(null, false) === false);
  check('an explicit no beats a yes default', resolvePush(0, true) === false);
  check('an explicit yes beats a no default', resolvePush(1, false) === true);

  const soon = Date.now() + 30 * 60_000;
  const deskOnly = (await post('/api/tasks', { title: 'Desk only', dueAt: soon, pushToPhone: false })).json();
  const anywhere = (await post('/api/tasks', { title: 'Anywhere', dueAt: soon, pushToPhone: true })).json();
  check('a task can refuse the phone', deskOnly.pushToPhone === 0);
  check('…and another can insist on it', anywhere.pushToPhone === 1);

  // The answer is resolved when the nudge is raised, not when it is delivered,
  // so this is where it has to be right.
  await sweepDueTasks(Date.now());
  const stamped = async (taskId: string): Promise<number | undefined> =>
    (await db.select().from(nudgeTable).where(whereEq(nudgeTable.taskId, taskId)))[0]?.pushToPhone;
  check('the refusal is stamped onto its nudge', (await stamped(deskOnly.id)) === 0);
  check('and so is the acceptance', (await stamped(anywhere.id)) === 1);

  /*
   * A phone that always answers. Without one, "nothing was pushed" is the
   * answer for every nudge whether or not the filter works, so this suite would
   * pass with the feature removed entirely.
   */
  const buzzed: string[] = [];
  providePush({
    isOnCooldown: () => false,
    sendToPhones: async (list) => {
      buzzed.push(...list.map((n) => n.title));
      return { sent: list.length, failed: 0, removed: 0 };
    },
    vapidPublicKey: async () => 'test',
    resetCooldown: () => {},
  });

  await post(
    '/api/attention',
    report({ state: 'away', reason: 'out of the room', idleMs: longIdle, audioPlaying: false })
  );
  check('the one that opted in reaches the phone', buzzed.includes('Anywhere'), buzzed.join(', '));
  check('the one that opted out does not', !buzzed.includes('Desk only'));

  /*
   * And it was skipped, not consumed. The distinction the whole setting rests
   * on is "not worth a phone", never "not worth telling me".
   *
   * Sitting back down is not enough by itself and should not be: this came from
   * an ordinary task, so its nudge asks for a `prime` moment and simply being
   * at the keyboard is only an `any`. So the queue is checked first — that is
   * the claim — and then a real stopping point is offered to prove it comes out.
   */
  const waiting = (await app.inject({ method: 'GET', url: '/api/nudges/queue' })).json();
  check(
    'it is still queued rather than consumed',
    waiting.some((n: { title: string }) => n.title === 'Desk only')
  );

  const back = await post(
    '/api/attention',
    report({
      reason: 'match over, back at the keyboard',
      idleMs: 0,
      stoppingPoint: { quality: 'prime', reason: 'a match just ended' },
    })
  );
  check('and toasts at the next good break', titles(back).includes('Desk only'), titles(back).join(', '));

  resetPushPort();
}

/* ------------------------------------------------------------------ */

console.log('\nhabit modes: a gap after doing it, and a gauge that drains');

{
  const { gaugeAfterFill, gaugeAfterUndo, gaugeLevelAt, habitWantsDoing } = await import(
    '@everything/shared'
  );
  const { db } = await import('../db/client.js');
  const { habits: habitTable } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const DAY = 86_400_000;
  const t0 = Date.parse('2026-08-16T09:00:00Z');

  /* ---- the maths, before anything touches a database ---- */

  const half = { gaugeLevel: 100, gaugeLevelAt: t0, gaugeDrainPerDay: 50, gaugeFillPercent: 25 };
  check('a gauge starts where it was stored', gaugeLevelAt(half, t0) === 100);
  check('and drains at its own rate', gaugeLevelAt(half, t0 + DAY) === 50, String(gaugeLevelAt(half, t0 + DAY)));
  check('never below empty', gaugeLevelAt(half, t0 + 10 * DAY) === 0);

  /*
   * **The reason the level is stored rather than derived.** Two ticks an hour
   * apart must leave it fuller than one — which a "time since the last tick"
   * gauge cannot express, because both have the same last tick.
   */
  const once = gaugeAfterFill(half, t0 + DAY);
  const twice = gaugeAfterFill({ ...half, ...once }, t0 + DAY);
  check('one top-up adds the fill amount', once.gaugeLevel === 75, String(once.gaugeLevel));
  check('and a second one stacks on it', twice.gaugeLevel === 100, String(twice.gaugeLevel));

  check(
    'a full gauge does not overflow',
    gaugeAfterFill({ ...half, gaugeLevel: 100, gaugeFillPercent: 60 }, t0).gaugeLevel === 100
  );
  check('undoing takes the fill back off', gaugeAfterUndo({ ...half, ...once }, t0 + DAY).gaugeLevel === 50);

  /*
   * A clock that goes backwards — a resumed laptop, a corrected timezone —
   * must not *fill* the gauge by draining a negative number of days.
   */
  check('a backwards clock does not refill it', gaugeLevelAt(half, t0 - DAY) === 100);

  /* ---- which mode wants doing when ---- */

  const base = { targetPerPeriod: 3, intervalMinutes: null, gaugeLevel: 0, gaugeLevelAt: t0, gaugeDrainPerDay: 100 };
  check(
    'a target habit wants doing until the target is met',
    habitWantsDoing({ ...base, mode: 'target' }, { doneThisPeriod: 2, lastDoneAt: t0 }, t0) &&
      !habitWantsDoing({ ...base, mode: 'target' }, { doneThisPeriod: 3, lastDoneAt: t0 }, t0)
  );
  check(
    'an interval habit waits out its interval',
    !habitWantsDoing(
      { ...base, mode: 'interval', intervalMinutes: 60 },
      { doneThisPeriod: 0, lastDoneAt: t0 },
      t0 + 30 * 60_000
    ) &&
      habitWantsDoing(
        { ...base, mode: 'interval', intervalMinutes: 60 },
        { doneThisPeriod: 0, lastDoneAt: t0 },
        t0 + 61 * 60_000
      )
  );
  check(
    'one never done is due immediately',
    habitWantsDoing({ ...base, mode: 'interval', intervalMinutes: 60 }, { doneThisPeriod: 0, lastDoneAt: null }, t0)
  );
  /*
   * A half-configured habit is not an always-due one. Reading a missing
   * interval as "due now" would nag forever about something nobody finished
   * setting up.
   */
  check(
    'and one with no interval set never is',
    !habitWantsDoing({ ...base, mode: 'interval' }, { doneThisPeriod: 0, lastDoneAt: null }, t0)
  );
  check(
    'a gauge wants doing only when it is empty',
    habitWantsDoing({ ...base, mode: 'gauge', gaugeLevel: 0 }, { doneThisPeriod: 0, lastDoneAt: null }, t0) &&
      !habitWantsDoing({ ...base, mode: 'gauge', gaugeLevel: 100 }, { doneThisPeriod: 0, lastDoneAt: null }, t0)
  );

  /* ---- and now through the real API ---- */

  const madeGauge = await post('/api/habits', { name: 'Water the plant', mode: 'gauge' });
  check('a gauge habit is created', madeGauge.statusCode === 201);
  const gaugeId = madeGauge.json().id;

  await app.inject({
    method: 'PATCH',
    url: `/api/habits/${gaugeId}`,
    payload: { gaugeDrainPerDay: 50, gaugeFillPercent: 25 },
  });

  const listOf = async (id: string) =>
    (await app.inject({ method: 'GET', url: '/api/habits' })).json().find((h: { id: string }) => h.id === id);

  check('it starts full', (await listOf(gaugeId)).gaugeNow === 100);

  // Wind the anchor back a day and a half rather than waiting for one. The read
  // path is what is under test, and it is the arithmetic that has to be right.
  await db
    .update(habitTable)
    .set({ gaugeLevelAt: Date.now() - 1.5 * DAY })
    .where(eq(habitTable.id, gaugeId));

  const drained = await listOf(gaugeId);
  check('and drains as time passes', drained.gaugeNow === 25, `got ${drained.gaugeNow}`);
  check('and says when it will be empty', Math.round(drained.gaugeEmptyInMs / 3_600_000) === 12, String(drained.gaugeEmptyInMs));
  /*
   * **A gauge is never finished, however full it is.** It was reported from the
   * Dashboard: a water gauge at 20% sitting under *Finished today*, which is a
   * heading claiming you are done with something that is visibly draining. The
   * cause was one field answering two questions — see `habitIsFinished`.
   */
  check('a gauge is never finished, even part full', drained.met === false, `met=${drained.met}`);
  check('but it does not want doing yet either', drained.wantsDoing === false);

  await post(`/api/habits/${gaugeId}/check`);
  const topped = await listOf(gaugeId);
  check('ticking it off tops it up rather than jumping to full', topped.gaugeNow === 50, `got ${topped.gaugeNow}`);

  await post(`/api/habits/${gaugeId}/check`);
  check('and a second tick stacks', (await listOf(gaugeId)).gaugeNow === 75);

  await post(`/api/habits/${gaugeId}/uncheck`);
  check('undoing one takes it back off', (await listOf(gaugeId)).gaugeNow === 50);

  /*
   * **And it keeps working once the period's entries are used up.** Undo
   * originally returned early on "no entry today", which is a true statement
   * about a counted habit and a wrong one about a gauge — the level is the
   * state and it was very likely last filled yesterday. The symptom was a −
   * button that worked exactly once and then silently did nothing, found by
   * pressing it three times and watching the level stop.
   */
  await post(`/api/habits/${gaugeId}/uncheck`);
  await post(`/api/habits/${gaugeId}/uncheck`);
  check(
    'and keeps working with no entry left in this period',
    (await listOf(gaugeId)).gaugeNow === 0,
    `got ${(await listOf(gaugeId)).gaugeNow}`
  );
  check('an empty gauge wants doing', (await listOf(gaugeId)).wantsDoing === true);
  check('and is still not "finished"', (await listOf(gaugeId)).met === false);

  await post(`/api/habits/${gaugeId}/check`);
  check('and topping it up does not finish it either', (await listOf(gaugeId)).met === false);

  /* ---- an interval habit reaches the queue, and only when it is due ---- */

  const madeInterval = await post('/api/habits', { name: 'Change the filter', mode: 'interval' });
  const intervalId = madeInterval.json().id;
  await app.inject({
    method: 'PATCH',
    url: `/api/habits/${intervalId}`,
    // No `reminderEveryMinutes`: the whole point is that "every 6 hours" is one
    // number, not two. `habitNagMinutes` falls back to the interval.
    payload: { intervalMinutes: 6 * 60 },
  });

  /*
   * An interval habit is finished only if it was done *today* and is not due
   * again. Both halves matter: without the first, one done last Tuesday would
   * sit under "Finished today" every day for a week; without the second, a
   * four-hour habit done at nine would still read as finished at two.
   */
  const intervalNow = await listOf(intervalId);
  check('a never-done interval habit is not finished', intervalNow.met === false);
  check('and it wants doing', intervalNow.wantsDoing === true);

  await post(`/api/habits/${intervalId}/check`);
  const justDone = await listOf(intervalId);
  check('doing it finishes it for today', justDone.met === true);
  check('and it stops wanting doing', justDone.wantsDoing === false);

  // Wind the tick back a week: no longer today, and due again.
  const { habitEntries: entryTable } = await import('../db/schema.js');
  await db
    .update(entryTable)
    .set({ doneAt: Date.now() - 8 * DAY })
    .where(eq(entryTable.habitId, intervalId));
  const staleInterval = await listOf(intervalId);
  check('one done last week is not "finished today"', staleInterval.met === false);
  check('and wants doing again', staleInterval.wantsDoing === true);

  const { sweepHabitReminders } = await import('../nudge-engine.js');
  await sweepHabitReminders(Date.now());

  const queuedNow = (await app.inject({ method: 'GET', url: '/api/nudges/queue' })).json();
  check(
    'a never-done interval habit reaches the queue',
    queuedNow.some((n: { title: string }) => n.title === 'Change the filter'),
    queuedNow.map((n: { title: string }) => n.title).join(', ')
  );
  /*
   * The line reports the *gap*, not a count against a target it does not have.
   * By this point the habit has been ticked and the entry wound back a week, so
   * the honest sentence is how long ago — "0 of 1 so far today" would be a
   * statement about a kind of habit this is not.
   */
  const intervalBody = queuedNow.find((n: { title: string }) => n.title === 'Change the filter')?.body;
  check('and its line reports the gap, not a target', intervalBody === 'last done 8 days ago', intervalBody);

  /* ---- and the voice path is the same path ---- */

  /*
   * **The bug this exists for.** The voice feature inserted a habit entry
   * itself, which was identical to the HTTP route right up until gauge mode
   * arrived — the fill went into the route, so saying "I drank water" logged an
   * entry and left the gauge exactly where it was. Reported as the voice command
   * not updating it, which is precisely what half a write looks like.
   *
   * Driven over HTTP rather than by importing the feature, because `smoke` is
   * core and must not reach into a folder that can be deleted.
   */
  const madeVoiceGauge = await post('/api/habits', { name: 'Sip water', mode: 'gauge' });
  const voiceGaugeId = madeVoiceGauge.json().id;
  await app.inject({
    method: 'PATCH',
    url: `/api/habits/${voiceGaugeId}`,
    payload: { gaugeDrainPerDay: 100, gaugeFillPercent: 20 },
  });
  // Empty it, so a fill is visible rather than clamped at full.
  for (let i = 0; i < 6; i++) await post(`/api/habits/${voiceGaugeId}/uncheck`);
  check('the voice gauge starts empty', (await listOf(voiceGaugeId)).gaugeNow === 0);

  /*
   * Voice is off by default — it is the only feature that opens a microphone, so
   * it is something you switched on rather than something you find running. The
   * command endpoint answers `disabled` until it is, which is correct and is not
   * what is being tested here.
   */
  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { voiceEnabled: true } });
  await post('/api/voice/commands', { kind: 'habit', target: voiceGaugeId, phrases: ['sip water'] });

  const spoken = await post('/api/voice/command', { text: 'hey everything i sipped water', speakerScore: null });
  const outcome = spoken.json();
  check('a spoken phrase reaches the habit', outcome.outcome === 'habit-checked', JSON.stringify(outcome));
  check(
    'and it actually moves the gauge',
    (await listOf(voiceGaugeId)).gaugeNow === 20,
    `gauge is ${(await listOf(voiceGaugeId)).gaugeNow}%`
  );
  /*
   * And says something true about it. The reply was hard-coded to "N of
   * target", which for a gauge is a sentence about a target it does not have.
   */
  check('and says the level rather than a target', outcome.say === 'Sip water — 20% full', outcome.say);

  // "two waters" is two fills, not one — the count has to survive the trip.
  const twoSips = await post('/api/voice/command', { text: 'hey everything i sipped two waters', speakerScore: null });
  check(
    'a spoken count fills that many times',
    (await listOf(voiceGaugeId)).gaugeNow === 60,
    `gauge is ${(await listOf(voiceGaugeId)).gaugeNow}% after "${twoSips.json().text}"`
  );

  /*
   * A gauge with no reminder interval is purely something to look at. Nagging
   * about one nobody asked to be nagged about would make the mode unusable as
   * decoration, which is a legitimate way to use it.
   */
  check(
    'a gauge with no reminder set stays out of the queue',
    !queuedNow.some((n: { title: string }) => n.title === 'Water the plant'),
    queuedNow.map((n: { title: string }) => n.title).join(', ')
  );
}

await app.close();
console.log(failures === 0 ? '\n\x1b[32mAll checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
