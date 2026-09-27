/**
 * When something happened, for a change made on a device that was offline.
 *
 * The phone queues what you do with no connection — a habit ticked on the
 * train, a task finished — and replays it when the server is back, sending the
 * time it really happened in `x-happened-at`. Without it every replayed change
 * would be stamped with the moment it arrived: a habit ticked at eleven last
 * night, synced this morning, would count for today and leave yesterday
 * looking missed.
 *
 * Bounded, because a device's clock is not trusted outright: nothing from the
 * future (a phone running fast would otherwise stamp things ahead of everything
 * else forever) and nothing older than a month, beyond which a queue is not a
 * queue. Anything outside that — or no header at all, which is every ordinary
 * request — is now.
 */
export const HAPPENED_AT_HEADER = 'x-happened-at';

const MONTH_MS = 30 * 24 * 60 * 60_000;

export function happenedAt(request: { headers: Record<string, string | string[] | undefined> }): number {
  const now = Date.now();
  const raw = request.headers[HAPPENED_AT_HEADER];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(value) || value <= 0) return now;
  if (value > now + 60_000 || value < now - MONTH_MS) return now;
  return Math.min(value, now);
}
