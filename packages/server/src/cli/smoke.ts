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

const post = async (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object });

const report = (over: Partial<AttentionReport>): AttentionReport => ({
  state: 'free',
  reason: 'smoke test',
  idleMs: 0,
  liveGames: [],
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
}

console.log('\naway from the PC (phone push gating)');
const { isAwayFromPc, AWAY_FROM_PC_IDLE_MS } = await import('@everything/shared');
const longIdle = AWAY_FROM_PC_IDLE_MS + 60_000;

// Pure rule checks — no phone needed, and these are the ones that must not be
// wrong: a false positive buzzes his pocket while he's sat watching something.
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
check('the server agrees he is away', awayBody.awayFromPc === true);
check('and with no phone subscribed nothing is pushed', awayBody.pushed === 0);

// A `prime`-only nudge must still be able to reach the phone: minQuality asks
// about breaks on the PC, and there is no PC activity to break into.
await post('/api/nudges', { title: 'Prime-only, but he has left', minQuality: 'prime' });
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
check('and arrives as a toast once he returns', titles(backAtDesk).includes('Waiting for the phone'), titles(backAtDesk).join(', '));

console.log('\nsnooze');
const snoozeTarget = await post('/api/nudges', { title: 'Snooze me', minQuality: 'any' });
await post(`/api/nudges/${snoozeTarget.json().id}/snooze`, { minutes: 30 });
const afterSnooze = await post('/api/attention', report({ reason: 'right after snoozing' }));
const snoozedFired = afterSnooze.json().deliver.some((n: { title: string }) => n.title === 'Snooze me');
check('a snoozed nudge stays quiet', !snoozedFired);

await app.close();
console.log(failures === 0 ? '\n\x1b[32mAll checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
