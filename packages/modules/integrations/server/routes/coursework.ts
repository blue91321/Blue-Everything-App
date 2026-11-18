/**
 * Coursework from Canvas, synced on a timer. No routes: registering this
 * starts the timer, and the server closing stops it.
 */
import type { FastifyInstance } from 'fastify';
import { getAccount } from '../store.js';
import { syncProvider } from '../sync.js';

export async function courseworkSync(app: FastifyInstance): Promise<void> {
  /* ---- the one thing here on a timer ----------------------------- */

  /**
   * Coursework, brought in without being asked.
   *
   * **The only background timer in this module, and it needs the argument this
   * project asks of anything on a clock.** Everything else here is
   * refresh-on-read: a friends list nobody is looking at does not need to be
   * right, so a 60-second poller was refused at 1,440 requests a day.
   *
   * Coursework is the opposite case, and the difference is what the data is
   * *for*. A friends list is something you go and look at, so reading it is the
   * moment it has to be true. A deadline's whole job is to reach the nudge
   * queue while you are thinking about something else — an assignment set on
   * Monday has to be in the queue on Thursday whether or not you have opened
   * the Services tab since. A "Sync now" button as the only route in would mean
   * the one feature that exists to remember things for you had to be
   * remembered.
   *
   * The number: **48 requests a day while connected, none at all otherwise**,
   * against a friends poller that was refused at 1,440 and an attention loop
   * budgeted at ~1,500 database rows a day. Half an hour is chosen against the
   * sweep, which queues a task within an hour of its due time — so the worst
   * case is that something set half an hour ago is half an hour late into a
   * queue it was never going to fire from yet.
   *
   * Owned by the feature rather than hung off the attention heartbeat, so it
   * goes away with the folder and core never learns it exists.
   */
  const COURSEWORK_EVERY_MS = 30 * 60_000;

  const sweepCoursework = async () => {
    // Costs one row read when nothing is connected, which is the ordinary case
    // for anybody who has not set Canvas up. No account, no request.
    const account = await getAccount('canvas');
    if (!account?.apiKey || !account.baseUrl) return;

    try {
      await syncProvider('canvas', ['assignments']);
    } catch (error) {
      // Never allowed to escape: this runs on a timer with nobody waiting on
      // it, and an unhandled rejection here would take the server down over a
      // school VPN being off. `syncProvider` has already recorded the failure
      // against the account, which is where the screen reads it from.
      app.log.warn({ err: error }, 'canvas sweep failed');
    }
  };

  // Shortly after boot as well as on the interval, or a restart means half an
  // hour of not knowing about anything set while the machine was off.
  const firstRun = setTimeout(() => void sweepCoursework(), 30_000);

  const repeat = setInterval(() => void sweepCoursework(), COURSEWORK_EVERY_MS);

  // Neither may hold the process open — `smoke` and `features-check` build an
  // app, assert, and close it, and a live interval would leave them hanging.
  firstRun.unref();

  repeat.unref();

  app.addHook('onClose', () => {
    clearTimeout(firstRun);
    clearInterval(repeat);
  });
}
