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
  // Likewise: required on the report, so leaving it out makes this helper's
  // return type a claim it does not meet.
  gamePaths: {},
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
  const { gaugeAfterFill, gaugeAfterUndo, gaugeLevelAt, gaugeReachesInMs, habitIsFinished, habitWantsDoing } =
    await import('@everything/shared');
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

  /*
   * ...unless a threshold moves that line up. Empty-only is the wrong moment for
   * anything that takes a while to act on — a plant would ask once it was
   * already dead — and 0 keeps the original behaviour exactly.
   */
  const warned = { ...base, mode: 'gauge' as const, gaugeRemindAt: 30 };
  check(
    'a threshold brings the asking forward',
    habitWantsDoing({ ...warned, gaugeLevel: 25 }, { doneThisPeriod: 0, lastDoneAt: null }, t0),
    'at 25% with a 30% threshold'
  );
  check(
    'and it is quiet above the line',
    !habitWantsDoing({ ...warned, gaugeLevel: 35 }, { doneThisPeriod: 0, lastDoneAt: null }, t0)
  );
  check(
    'exactly on the line counts as due',
    habitWantsDoing({ ...warned, gaugeLevel: 30 }, { doneThisPeriod: 0, lastDoneAt: null }, t0)
  );
  /* Still never *finished*, however that line is drawn. */
  check(
    'a threshold does not make it finishable',
    !habitIsFinished({ ...warned, gaugeLevel: 100 }, { doneThisPeriod: 0, lastDoneAt: null, startOfToday: t0 }, t0)
  );

  /* ---- the two countdowns ---- */

  const counting = { gaugeLevel: 100, gaugeLevelAt: t0, gaugeDrainPerDay: 50 };
  check('empty is a full two days away at 50% a day', gaugeReachesInMs(counting, 0, t0) === 2 * DAY);
  const toThirty = gaugeReachesInMs(counting, 30, t0);
  check('and the 30% line is a day and a half', toThirty === 1.4 * DAY, `${(toThirty ?? 0) / DAY} days`);
  check('already past the line is now, not a negative', gaugeReachesInMs(counting, 100, t0) === 0);
  // A gauge that does not drain never reaches anything, and saying "in 0" would
  // be a countdown to a moment that is not coming.
  check('one that never drains never gets there', gaugeReachesInMs({ ...counting, gaugeDrainPerDay: 0 }, 0, t0) === null);

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

  /*
   * The threshold over HTTP, and the countdown the Dashboard shows beside the
   * empty one. The gauge is at 75% here, draining 50% a day: the 25% line is a
   * day off and empty is a day and a half, and the two are deliberately
   * different numbers so a swapped pair would show up.
   */
  await app.inject({ method: 'PATCH', url: `/api/habits/${gaugeId}`, payload: { gaugeRemindAt: 25 } });
  const withLine = await listOf(gaugeId);
  check('it counts down to the threshold', Math.round(withLine.gaugeRemindInMs / 3_600_000) === 24, String(withLine.gaugeRemindInMs));
  check('and separately to empty', Math.round(withLine.gaugeEmptyInMs / 3_600_000) === 36, String(withLine.gaugeEmptyInMs));
  check('and is not asking yet, well above the line', withLine.wantsDoing === false);
  await app.inject({ method: 'PATCH', url: `/api/habits/${gaugeId}`, payload: { gaugeRemindAt: 80 } });
  check('raising the line past the level starts it asking', (await listOf(gaugeId)).wantsDoing === true);
  check('and it is still never finished', (await listOf(gaugeId)).met === false);
  await app.inject({ method: 'PATCH', url: `/api/habits/${gaugeId}`, payload: { gaugeRemindAt: 0 } });

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

  /* ---- a picture of your own ---- */

  /*
   * A 1x1 PNG is enough: what is under test is the round trip and the guards,
   * not the decoding — nothing here decodes it, the browser does.
   */
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  check('no picture to begin with', (await listOf(gaugeId)).hasImage === false);
  /*
   * The same guard the app logo has: `image` with nothing uploaded draws the
   * fallback, which looks exactly like the upload having failed.
   */
  const tooEarly = await app.inject({
    method: 'PATCH',
    url: `/api/habits/${gaugeId}`,
    payload: { gaugeShape: 'image' },
  });
  check('and it refuses to point at one that is not there', tooEarly.statusCode === 400, String(tooEarly.statusCode));

  const uploaded = await app.inject({
    method: 'PUT',
    url: `/api/habits/${gaugeId}/image`,
    payload: { data: PNG, type: 'image/png' },
  });
  check('a picture uploads', uploaded.statusCode === 200, uploaded.body);
  const afterUpload = await listOf(gaugeId);
  check('and the habit knows it has one', afterUpload.hasImage === true);
  // Uploading points the gauge at it — the reason you uploaded it.
  check('and the gauge is pointed at it', afterUpload.gaugeShape === 'image');

  const served = await app.inject({ method: 'GET', url: `/api/habits/${gaugeId}/image` });
  check('it reads back as an image', served.statusCode === 200 && served.headers['content-type'] === 'image/png');
  check('with the bytes that went in', served.rawPayload.equals(Buffer.from(PNG, 'base64')));

  /*
   * Switching to a shape must not delete the file. Somebody who uploads a photo,
   * tries a triangle and comes back should find the photo still there — the same
   * rule the app logo follows.
   */
  await app.inject({ method: 'PATCH', url: `/api/habits/${gaugeId}`, payload: { gaugeShape: 'triangle' } });
  check('changing shape keeps the picture', (await listOf(gaugeId)).hasImage === true);

  await app.inject({ method: 'DELETE', url: `/api/habits/${gaugeId}/image` });
  check('removing it takes the file', (await listOf(gaugeId)).hasImage === false);
  check(
    'and leaves a shape that was not pointing at it alone',
    (await listOf(gaugeId)).gaugeShape === 'triangle'
  );
  check(
    'and it is gone from the read route too',
    (await app.inject({ method: 'GET', url: `/api/habits/${gaugeId}/image` })).statusCode === 404
  );

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
   * And "to max" fills it the rest of the way, whatever that is — the whole
   * point being that at 60% with a 20% fill you would otherwise have to notice
   * it needed exactly two more.
   */
  const maxed = await post('/api/voice/command', { text: 'hey everything i sipped water to max', speakerScore: null });
  check('"to max" fills it the rest of the way', (await listOf(voiceGaugeId)).gaugeNow === 100, `gauge is ${(await listOf(voiceGaugeId)).gaugeNow}%`);
  check('and says so', maxed.json().say === 'Sip water — 100% full', maxed.json().say);
  // Saying it must always record something, or a full gauge answers "done"
  // having done nothing at all.
  const again = await post('/api/voice/command', { text: 'hey everything i sipped water to max', speakerScore: null });
  check('saying it again on a full gauge is still an answer', again.json().outcome === 'habit-checked');
  check('and leaves it full rather than overflowing', (await listOf(voiceGaugeId)).gaugeNow === 100);

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

/* ------------------------------------------------------------------ */

console.log('\nstarred live channels, and narrowing the panel to them');

{
  const { db } = await import('../db/client.js');
  const { follows: followsTable, liveStreams } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  /*
   * Seeded rather than fetched. What is under test is the join, the star and the
   * narrowing — all of which are this app's own rules — and a test that stood up
   * a fake Twitch would only prove the fake matched the code.
   */
  const channel = (id: string, name: string, viewers: number) => ({
    provider: 'twitch',
    providerAccountId: id,
    streamId: `s-${id}`,
    channelName: name,
    title: `${name} streaming`,
    category: 'Just Chatting',
    viewers,
    startedAt: Date.now() - 3_600_000,
    thumbnailUrl: null,
    url: `https://twitch.tv/${name}`,
    seenAt: Date.now(),
  });

  await db.insert(liveStreams).values([channel('1', 'alfa', 900), channel('2', 'bravo', 300)]);
  // Only one of the two is in the followed list, on purpose — see below.
  await db.insert(followsTable).values({
    provider: 'twitch',
    providerAccountId: '1',
    kind: 'channel',
    name: 'alfa',
    seenAt: Date.now(),
  });

  const live = async () => (await app.inject({ method: 'GET', url: '/api/integrations/live' })).json();

  const first = await live();
  check('both live channels are listed', first.streams.length === 2, `${first.streams.length}`);
  /*
   * **A left join, and this is why.** `bravo` is live but not in the followed
   * list — the ordinary case before that list has synced — and an inner join
   * would have dropped it off the screen entirely rather than merely showing it
   * unstarred.
   */
  check('one not in the followed list still appears', first.streams.some((s: { channelName: string }) => s.channelName === 'bravo'));
  check('and busiest is first', first.streams[0].channelName === 'alfa');
  check('nothing is starred to begin with', first.streams.every((s: { favourite: boolean }) => !s.favourite));

  const starred = await post('/api/integrations/follows/favourite', {
    provider: 'twitch',
    providerAccountId: '1',
    favourite: true,
  });
  check('a followed channel can be starred', starred.statusCode === 200, starred.body);
  const after = await live();
  check('and the star comes back on the row', after.streams.find((s: { channelName: string }) => s.channelName === 'alfa').favourite === true);
  check('without starring anybody else', after.streams.find((s: { channelName: string }) => s.channelName === 'bravo').favourite === false);

  /*
   * A live channel with no followed row has nothing to flag. A silent 200 would
   * spring the star back on the next reload with nothing said, so it refuses.
   */
  const cannot = await post('/api/integrations/follows/favourite', {
    provider: 'twitch',
    providerAccountId: '2',
    favourite: true,
  });
  check('one that is not followed yet is refused, not silently dropped', cannot.statusCode === 409, `${cannot.statusCode}`);

  /* The scope rides on the live response so the panel needs no second request. */
  check('the scope defaults to everyone', (await live()).scope === 'all');
  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { livePanelScope: 'favourites' } });
  check('and follows the setting', (await live()).scope === 'favourites');
  /*
   * The endpoint keeps returning everything either way — the *panel* narrows.
   * Filtering here would have meant a second endpoint or a query parameter to
   * tell the tab and the panel apart.
   */
  check('while the endpoint still returns them all', (await live()).streams.length === 2);

  /* A star survives a sync, because `replaceFollows` names the columns it writes. */
  const { replaceFollows } = await import('../../../modules/integrations/server/store.js');
  await replaceFollows('twitch', [
    { provider: 'twitch', providerAccountId: '1', kind: 'channel', name: 'alfa renamed' },
    { provider: 'twitch', providerAccountId: '2', kind: 'channel', name: 'bravo' },
  ]);
  const synced = await live();
  check(
    'a star survives the followed list syncing',
    synced.streams.find((s: { providerAccountId: string }) => s.providerAccountId === '1').favourite === true
  );
  check('and the sync did land', (await db.select().from(followsTable).where(eq(followsTable.providerAccountId, '1')))[0].name === 'alfa renamed');
}

/* ------------------------------------------------------------------ */

console.log('\nthe side column holds a list, in order');

{
  const settingsNow = async () => (await app.inject({ method: 'GET', url: '/api/settings' })).json();
  const setPanels = async (dashboardPanels: string[]) =>
    app.inject({ method: 'PATCH', url: '/api/settings', payload: { dashboardPanels } });

  await setPanels(['notes:recent', 'integrations:live']);
  const two = await settingsNow();
  check('a list is stored in the order given', two.dashboardPanels.join(',') === 'notes:recent,integrations:live', two.dashboardPanels.join(','));

  /*
   * The single field is kept in step with the first entry. A PWA older than the
   * list column reads only that, and would otherwise draw an empty side column
   * with nothing saying why.
   */
  check('the legacy single field follows the first', two.dashboardPanel === 'notes:recent', two.dashboardPanel);

  await setPanels(['integrations:live', 'notes:recent']);
  const swapped = await settingsNow();
  check('reordering is stored', swapped.dashboardPanels.join(',') === 'integrations:live,notes:recent');
  check('and the legacy field follows it', swapped.dashboardPanel === 'integrations:live');

  /*
   * The same panel twice would draw twice and hand React two children with one
   * key, and there is no reading of "who is online, then who is online" worth
   * supporting.
   */
  await setPanels(['notes:recent', 'notes:recent', 'integrations:friends']);
  const deduped = await settingsNow();
  check('duplicates are dropped', deduped.dashboardPanels.join(',') === 'notes:recent,integrations:friends', deduped.dashboardPanels.join(','));

  await setPanels([]);
  const empty = await settingsNow();
  check('an empty list is a real choice', empty.dashboardPanels.length === 0);
  check('and empties the legacy field with it', empty.dashboardPanel === '');

  /* Opaque, like every other panel id — core never validates the values. */
  await setPanels(['something:nobody-has']);
  check('an unknown id is stored rather than refused', (await settingsNow()).dashboardPanels[0] === 'something:nobody-has');

  await setPanels(['integrations:friends']);
}

/* ------------------------------------------------------------------ */

console.log('\nthings that must stay shut');

{
  /*
   * **Reflected XSS on the OAuth callback.** `error` and `error_description`
   * were interpolated straight into hand-built HTML on an unauthenticated
   * route — same origin as the device bearer token in `localStorage`. Confirmed
   * against the running server before the fix: 200, text/html, script intact.
   */
  const reflected = await app.inject({
    method: 'GET',
    url: '/oauth/callback/spotify?error=%3Cscript%3EPWNED%3C/script%3E&error_description=%22%3E%3Cimg%20onerror%3Dx%3E',
  });
  check('the callback still answers', reflected.statusCode === 200);
  check('but no tag survives it', !reflected.body.includes('<script>'), reflected.body.slice(0, 160));
  check('nor an attribute break', !reflected.body.includes('"><img'), reflected.body.slice(0, 160));
  check('and the text is still readable', reflected.body.includes('&lt;script&gt;PWNED'));

  /*
   * **Path traversal on the habit picture.** The id goes straight into
   * `habit-${id}.png`, and the `habit-` prefix is its own path segment — so the
   * `..` after it pops that segment and every further `..` climbs out. It read
   * `data/avatar.png`, then a file outside `data/` entirely. The fixed
   * extension list was the only thing keeping the database out of reach, which
   * bounded it rather than excusing it.
   */
  for (const nasty of [
    '..%2F..%2Favatar',
    '..%2F..%2F..%2F..%2Fweb%2Fpublic%2Ficon-192',
    '..%5C..%5Cavatar',
    'a%2F..%2F..%2F..%2Favatar',
  ]) {
    const escaped = await app.inject({ method: 'GET', url: `/api/habits/${nasty}/image` });
    check(`a crafted id reads nothing (${decodeURIComponent(nasty)})`, escaped.statusCode === 404, `${escaped.statusCode}`);
  }

  /* And a real habit's picture still works, so the guard is not simply "no". */
  const made = await post('/api/habits', { name: 'Picture guard', mode: 'gauge' });
  const guardId = made.json().id;
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await app.inject({ method: 'PUT', url: `/api/habits/${guardId}/image`, payload: { data: PNG, type: 'image/png' } });
  const ok = await app.inject({ method: 'GET', url: `/api/habits/${guardId}/image` });
  check('an ordinary id still reads its own picture', ok.statusCode === 200 && ok.headers['content-type'] === 'image/png');
  await app.inject({ method: 'DELETE', url: `/api/habits/${guardId}` });
}

console.log('');
console.log('games, and what may interrupt one');
{
  const report = (over: Partial<AttentionReport>) =>
    post('/api/attention', { state: 'free', reason: 'games probe', idleMs: 0, liveGames: [], audioPlaying: false, windowsDnd: false, ...over });

  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { quietHoursEnabled: false, gameDetectionEnabled: true, interruptDuringGames: false } });

  /* Discovery: the agent reports what ran, and the list grows by itself. */
  await report({ state: 'in-game', liveGames: ['cs2.exe'] });
  const listed = async () => (await app.inject({ method: 'GET', url: '/api/games' })).json() as Array<{ exe: string; isGame: number; source: string; allowInterruptions: number | null }>;
  const cs2 = (await listed()).find((g) => g.exe === 'cs2.exe');
  check('a running game puts itself on the list', cs2 !== undefined);
  check('  ...marked as a game', cs2?.isGame === 1);

  /*
   * An app covering the screen is recorded but NOT assumed to be a game. Films
   * and browsers cover the screen too, and guessing wrong means silently holding
   * nudges back for something nobody would think to blame this list for.
   */
  const B = String.fromCharCode(92);
  await report({
    state: 'in-game',
    liveGames: [],
    fullscreenApp: 'vlc.exe',
    gamePaths: { 'vlc.exe': `C:${B}Program Files${B}VideoLAN${B}VLC${B}vlc.exe` },
  });
  const vlc = (await listed()).find((g) => g.exe === 'vlc.exe');
  check('an app covering the screen is listed', vlc !== undefined, vlc?.source);
  check('  ...but not called a game', vlc?.isGame === 0);

  /*
   * Unless it lives where only games live. This is the signal that actually
   * matters for a borderless window: nothing about the window shape says
   * "game", and the install path says it plainly whatever shape it is.
   */
  await report({
    state: 'in-game',
    liveGames: [],
    fullscreenApp: 'fsd.exe',
    gamePaths: { 'fsd.exe': `D:${B}SteamLibrary${B}steamapps${B}common${B}Deep Rock Galactic${B}FSD.exe` },
  });
  const drg = (await listed()).find((g) => g.exe === 'fsd.exe');
  check('one in a game library is switched on for you', drg?.isGame === 1, `isGame=${drg?.isGame}`);
  check('  ...and the agent is told to watch it', ((await app.inject({ method: 'GET', url: '/api/games/watching' })).json().exes as string[]).includes('fsd.exe'));
  await app.inject({ method: 'DELETE', url: '/api/games/fsd.exe' });

  /*
   * The shell is never a candidate, however plainly it covers the screen.
   * `explorer.exe` was listed on the real machine within a day of this shipping:
   * the desktop *is* a window filling its monitor, and it is the foreground
   * window every time you alt-tab out of a game. The geometry check was right
   * and the conclusion was absurd.
   */
  await report({
    state: 'free',
    liveGames: [],
    fullscreenApp: 'explorer.exe',
    gamePaths: { 'explorer.exe': `C:${B}Windows${B}explorer.exe` },
  });
  check('the desktop is not listed as having filled the screen',
    (await listed()).find((g) => g.exe === 'explorer.exe') === undefined);

  /* The interruption rule. */
  await post('/api/nudges', { title: 'Mid-match', minQuality: 'any' });
  const midMatch = await report({ state: 'in-game', liveGames: ['cs2.exe'] });
  check('nothing interrupts a game by default', midMatch.json().deliver.length === 0, `${midMatch.json().deliver.length}`);

  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { interruptDuringGames: true } });
  const allowed = await report({ state: 'in-game', liveGames: ['cs2.exe'] });
  check('unless you say it may', allowed.json().deliver.some((n: { title: string }) => n.title === 'Mid-match'), JSON.stringify(allowed.json().deliver.map((n: {title:string}) => n.title)));

  /* One game saying no outranks the global yes — the conservative direction. */
  await app.inject({ method: 'PATCH', url: '/api/games/cs2.exe', payload: { allowInterruptions: false } });
  await post('/api/nudges', { title: 'Held back', minQuality: 'any' });
  const refused = await report({ state: 'in-game', liveGames: ['cs2.exe'] });
  check('a game may still refuse on its own', !refused.json().deliver.some((n: {title:string}) => n.title === 'Held back'));

  /* Detection off makes a match read as ordinary use. */
  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { gameDetectionEnabled: false } });
  const undetected = await report({ state: 'in-game', liveGames: ['cs2.exe'] });
  check('detection off lets everything through', undetected.json().deliver.some((n: {title:string}) => n.title === 'Held back'));

  /* Not a game any more: unticking it removes it from the decision entirely. */
  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { gameDetectionEnabled: true, interruptDuringGames: false } });
  await app.inject({ method: 'PATCH', url: '/api/games/cs2.exe', payload: { isGame: false, allowInterruptions: null } });
  const watching = (await app.inject({ method: 'GET', url: '/api/games/watching' })).json();
  check('unticking takes it out of what the agent watches', !(watching.exes as string[]).includes('cs2.exe'), (watching.exes as string[]).join(','));

  /*
   * Nothing is shipped onto the list. A fresh table is empty, and the agent
   * still knows the built-in names — the server only ever overrides, which is
   * what stops "watch exactly these" deadlocking an empty table.
   */
  const watchingNow = (await app.inject({ method: 'GET', url: '/api/games/watching' })).json();
  check('unticking sends it as switched off', (watchingNow.off as string[]).includes('cs2.exe'), (watchingNow.off as string[]).join(','));

  const before = (await app.inject({ method: 'GET', url: '/api/games/watching' })).json().version;
  await app.inject({ method: 'PATCH', url: '/api/games/cs2.exe', payload: { isGame: true } });
  const after = (await app.inject({ method: 'GET', url: '/api/games/watching' })).json().version;
  check('the version moves when the list does', before !== after);

  /* Launching can only ever use the row's own path, never one from the caller. */
  const noPath = await app.inject({ method: 'POST', url: '/api/games/cs2.exe/launch', payload: {} });
  check('a game with no known path refuses to launch', noPath.statusCode === 409, `${noPath.statusCode}`);
  const missing = await app.inject({ method: 'POST', url: '/api/games/nope.exe/launch', payload: {} });
  check('and an unknown one is a 404', missing.statusCode === 404, `${missing.statusCode}`);

  /* A path the agent reported is remembered, and only the first one. */
  await report({ state: 'in-game', liveGames: ['cs2.exe'], gamePaths: { 'cs2.exe': 'C:\Games\cs2.exe' } });
  const withPath = (await listed()).find((g) => g.exe === 'cs2.exe') as { launchPath?: string } | undefined;
  check('a reported path is stored', withPath?.launchPath === 'C:\Games\cs2.exe', withPath?.launchPath);

  await app.inject({ method: 'DELETE', url: '/api/games/cs2.exe' });
  await app.inject({ method: 'DELETE', url: '/api/games/vlc.exe' });
}

console.log('');
console.log('one timer instead of two');
{
  const agentSees = async () =>
    (await app.inject({ method: 'POST', url: '/api/voice/agent', payload: { listening: false } })).json();
  const screenSees = async () => (await app.inject({ method: 'GET', url: '/api/voice/status' })).json();

  await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { voiceFollowUpSeconds: 6, voiceRetrySeconds: 12, voiceRetryMatchesFollowUp: false },
  });
  check('unticked, the agent gets both numbers', (await agentSees()).retryMs === 12_000, `${(await agentSees()).retryMs}`);

  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { voiceRetryMatchesFollowUp: true } });
  const linked = await agentSees();
  check('ticked, a miss uses the answer time', linked.retryMs === 6_000, `${linked.retryMs}`);

  /*
   * The stored value is untouched. This is the whole reason it is resolved on
   * read: unticking has to give back the number you chose, not whatever the
   * follow-up happened to be — the same rule quiet hours follows for its times.
   */
  check('  ...and the stored one is left alone', (await screenSees()).retrySeconds === 12, `${(await screenSees()).retrySeconds}`);
  check('  ...and the screen knows the box is ticked', (await screenSees()).retryMatchesFollowUp === true);

  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { voiceFollowUpSeconds: 9 } });
  check('moving the answer time moves the miss with it', (await agentSees()).retryMs === 9_000, `${(await agentSees()).retryMs}`);

  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { voiceRetryMatchesFollowUp: false } });
  check('unticking restores the number you had', (await agentSees()).retryMs === 12_000, `${(await agentSees()).retryMs}`);

  /* Zero still means off, and linking it must not turn it back on. */
  await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { voiceFollowUpSeconds: 0, voiceRetryMatchesFollowUp: true },
  });
  check('zero stays off through the link', (await agentSees()).retryMs === 0, `${(await agentSees()).retryMs}`);

  await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { voiceFollowUpSeconds: 6, voiceRetrySeconds: 8, voiceRetryMatchesFollowUp: false },
  });
}

console.log('');
console.log('words that are not the wake word');
{
  const { parseWakeDecoys, MAX_WAKE_DECOYS } = await import('@everything/shared');

  check('a plain list parses', parseWakeDecoys('harley, charlie').join('|') === 'harley|charlie');
  check('spacing and case do not matter', parseWakeDecoys('  HARLEY ,charlie  ').join('|') === 'harley|charlie');
  check('a two-word entry survives', parseWakeDecoys('harvest festival').join('|') === 'harvest festival');
  check('punctuation is dropped rather than refused', parseWakeDecoys("harley's, char-lie").join('|') === 'harley s|char lie');
  check('duplicates collapse', parseWakeDecoys('harley, harley').length === 1);
  check('empty entries are ignored', parseWakeDecoys('harley,,, ,charlie').length === 2);

  /*
   * The wake word itself must never end up in the list: it would be asking the
   * grammar to compete with itself, and the likeliest way for it to get there
   * is somebody pasting the whole thing in to "block" it.
   */
  check('the wake word is removed', parseWakeDecoys('harley, hey jarvis', 'hey jarvis').join('|') === 'harley');
  check('  ...whatever its case', parseWakeDecoys('HEY JARVIS', 'hey jarvis').length === 0);

  /* Letters only — the parser strips digits, so `word1` and `word2` would both
     collapse to `word` and the cap would look broken when the fixture was. */
  const many = Array.from({ length: 40 }, (_, i) => `w${'a'.repeat(i + 1)}`).join(',');
  check('the list is capped', parseWakeDecoys(many).length === MAX_WAKE_DECOYS, `${parseWakeDecoys(many).length}`);

  /* It reaches the agent, and moves the version so the grammar is rebuilt. */
  const before = (await app.inject({ method: 'GET', url: '/api/voice/config' })).json();
  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { wakeDecoys: 'harley, harvest festival' } });
  const after = (await app.inject({ method: 'GET', url: '/api/voice/config' })).json();

  check('the decoys reach /api/voice/config', (after.wakeDecoys as string[]).join('|') === 'harley|harvest festival', JSON.stringify(after.wakeDecoys));
  check('  ...and the version moves, so the grammar is rebuilt', after.version !== before.version);
  check('  ...and they are dictionary-checked like a phrase', (after.checkWords as string[]).includes('harvest'));

  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { wakeDecoys: '' } });
  const cleared = (await app.inject({ method: 'GET', url: '/api/voice/config' })).json();
  check('clearing them empties the list', (cleared.wakeDecoys as string[]).length === 0);
}

console.log('');
console.log('setting a habit value by hand');
{
  /*
   * Tapping the number on the Habits screen puts the tally at a value rather
   * than nudging it. The interesting half is going *down*: entries can carry a
   * count greater than one — "I drank three waters" is a single row — so the
   * newest are removed until the sum fits and the remainder is re-inserted.
   */
  const made = await post('/api/habits', { name: 'Value probe', mode: 'target', targetPerPeriod: 20, cadence: 'daily' });
  const id = made.json().id;

  const setTo = async (value: number) =>
    (await app.inject({ method: 'PUT', url: `/api/habits/${id}/value`, payload: { value } })).json();

  check('it goes up from nothing', (await setTo(9)).doneThisPeriod === 9);
  check('it comes back down', (await setTo(3)).doneThisPeriod === 3);
  check('it reaches the target', (await setTo(20)).met === true);
  check('and it reaches zero', (await setTo(0)).doneThisPeriod === 0);

  /* One entry of five, then two of one — the shape the loop has to unpick. */
  await setTo(5);
  await post(`/api/habits/${id}/check`);
  await post(`/api/habits/${id}/check`);
  const seven = await app.inject({ method: 'GET', url: '/api/habits' });
  check('five plus two ones is seven', (seven.json() as { id: string; doneThisPeriod: number }[]).find((h) => h.id === id)?.doneThisPeriod === 7);
  check('dropping to six removes one of the ones', (await setTo(6)).doneThisPeriod === 6);
  check('dropping to two must split the five', (await setTo(2)).doneThisPeriod === 2);

  /* A PUT, so sending it twice is the same as sending it once — which is what
     makes it safe for Enter and the blur that follows to both fire. */
  check('setting the same value twice changes nothing', (await setTo(2)).doneThisPeriod === 2);

  for (const bad of [-1, 1000, 2.5]) {
    const refused = await app.inject({ method: 'PUT', url: `/api/habits/${id}/value`, payload: { value: bad } });
    check(`${bad} is refused`, refused.statusCode === 400, `${refused.statusCode}`);
  }
  const missing = await app.inject({ method: 'PUT', url: '/api/habits/nope/value', payload: { value: 1 } });
  check('an unknown habit is a 404', missing.statusCode === 404, `${missing.statusCode}`);

  /* A gauge means the level, not a count of entries — and setting it records
     no entry, because a correction is not a completion. */
  const gaugeMade = await post('/api/habits', { name: 'Gauge probe', mode: 'gauge', gaugeDrainPerDay: 100, gaugeFillPerTick: 20 });
  const gaugeId = gaugeMade.json().id;
  const put = async (value: number) =>
    (await app.inject({ method: 'PUT', url: `/api/habits/${gaugeId}/value`, payload: { value } })).json();

  check('a gauge takes a level', (await put(35)).gaugeNow === 35);
  check('  ...including empty', (await put(0)).gaugeNow === 0);
  check('  ...and full', (await put(100)).gaugeNow === 100);
  check('  ...without logging a completion', (await put(60)).doneThisPeriod === 0);

  await app.inject({ method: 'DELETE', url: `/api/habits/${id}` });
  await app.inject({ method: 'DELETE', url: `/api/habits/${gaugeId}` });
}

console.log('');
console.log('packages (installing, switching, removing)');
{
  /*
   * The disk work and the zip parser are proved by `modules-check`; this is the
   * HTTP skin around them — the part that decides who is allowed to run any of
   * it. Installing runs somebody else's code on this machine and removing
   * deletes a folder from it, so the local-only gate is the check that matters
   * most here.
   */
  const { modulesDir } = await import('../modules.js');
  const { existsSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');

  const ID = 'smoke-probe-package';
  const manifest = JSON.stringify({ id: ID, label: 'Smoke probe', blurb: 'Installed by the smoke suite.', version: '0.0.1' });

  /* A stored (uncompressed) one-entry zip, built by hand so the suite needs no fixture file. */
  const { crc32 } = await import('node:zlib');
  const name = Buffer.from('module.json', 'utf8');
  const body = Buffer.from(manifest, 'utf8');
  const sum = crc32(body);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(local.length + name.length + body.length, 16);
  const zip = Buffer.concat([local, name, body, central, name, eocd]).toString('base64');

  /*
   * What is on disk before this section runs, so the `finally` can prove none of
   * it went missing. A test that can delete a package is a test that can delete
   * the wrong one, and the way that failure presented — a wall of unrelated
   * module-not-found errors in *other* suites — gave no hint at all about which
   * check had done it.
   */
  const shippedBefore = (await import('../modules.js'))
    .scanModules()
    .filter((mod) => mod.shipped)
    .map((mod) => mod.id);

  try {
    const listed = await app.inject({ method: 'GET', url: '/api/modules' });
    check('the list answers', listed.statusCode === 200);
    check('  ...and names the folder to a local caller', typeof listed.json().folder === 'string');

    const installed = await app.inject({ method: 'POST', url: '/api/modules', payload: { data: zip, filename: 'probe.zip' } });
    check('a zip installs', installed.statusCode === 200 && installed.json().id === ID, `${installed.statusCode} ${installed.body.slice(0, 120)}`);
    check('  ...and lands in modules/', existsSync(join(modulesDir, ID, 'module.json')));

    const after = (await app.inject({ method: 'GET', url: '/api/modules' })).json();
    const row = (after.modules as { id: string; enabled: boolean; usable: boolean }[]).find((m) => m.id === ID);
    check('it appears in the list', row !== undefined && row.usable);
    check('  ...switched off, because it is code that arrived from outside', row?.enabled === false);

    const on = await app.inject({ method: 'PATCH', url: `/api/modules/${ID}`, payload: { enabled: true } });
    check('it can be switched on', on.statusCode === 200 && on.json().enabled === true);
    check('  ...and says a restart is owed', on.json().pendingRestart === true);

    /*
     * The local-only gate is **not** tested here, and the reason is worth
     * writing down rather than discovering twice.
     *
     * This file sets `AUTH_REQUIRED=false` at the top so the whole suite can
     * run without minting a device, and `auth.ts` short-circuits on that by
     * setting `isLocal = true` for every request before `isTrustedLocal` is
     * ever consulted. So an injected request carrying a tailnet Host and
     * `Sec-Fetch-Site: cross-site` is allowed in here — which looks exactly
     * like a broken gate and is in fact a disabled one.
     *
     * Asserting a 403 here would therefore have been a test that could only
     * fail, and asserting a 200 would enshrine the harness's own bypass as
     * though it were the app's behaviour. The gate is exercised against a real
     * socket instead, with auth on, where the header checks actually run.
     */

    /*
     * An id that is not a package name must never reach the filesystem.
     *
     * **`vault` was in this list and it deleted the vault.** It was here as an
     * example of a reserved id the route would refuse — true while the vault was
     * a *feature*, and false the moment it became a package, at which point the
     * suite cheerfully removed `packages/modules/vault` from the working tree
     * and every later check failed with a module-not-found for a folder the test
     * itself had just erased.
     *
     * So this list holds only shapes that can never name anything: a traversal,
     * and an id belonging to something that is still a feature and has no folder
     * at all. The names of real packages do not belong in a destructive test.
     */
    for (const nasty of ['..', '..%2F..%2Fpackages', 'habits']) {
      const escaped = await app.inject({ method: 'DELETE', url: `/api/modules/${nasty}` });
      check(`a crafted package id deletes nothing (${decodeURIComponent(nasty)})`, escaped.statusCode === 400 || escaped.statusCode === 404, `${escaped.statusCode}`);
    }

    const gone = await app.inject({ method: 'DELETE', url: `/api/modules/${ID}` });
    check('it removes', gone.statusCode === 200 && !existsSync(join(modulesDir, ID)));

    const junk = await app.inject({ method: 'POST', url: '/api/modules', payload: { data: Buffer.from('not a zip').toString('base64') } });
    check('a file that is not a zip is refused', junk.statusCode === 400);
    check('  ...with a reason worth reading', /not a zip/.test(junk.json().error ?? ''), junk.body.slice(0, 120));
  } finally {
    // Never leave a package behind: the next run would test a different app.
    if (existsSync(join(modulesDir, ID))) rmSync(join(modulesDir, ID), { recursive: true, force: true });

    const shippedAfter = (await import('../modules.js')).scanModules().filter((m) => m.shipped).map((m) => m.id);
    const lost = shippedBefore.filter((id) => !shippedAfter.includes(id));
    check(
      'and this suite deleted none of the shipped packages',
      lost.length === 0,
      lost.length > 0 ? `lost ${lost.join(', ')} — restore with git checkout` : ''
    );
  }
}

await app.close();
console.log(failures === 0 ? '\n\x1b[32mAll checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
