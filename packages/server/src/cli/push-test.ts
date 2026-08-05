/**
 * Sends a push to every subscribed device and prints whatever comes back,
 * verbatim.
 *
 * The delivery path swallows errors by design — a failed push must not fail the
 * agent's heartbeat — which makes "pushed: 0" impossible to diagnose from the
 * outside. This is the way in.
 *
 *   npm run push-test -w @everything/server
 */
import webpush, { type PushSubscription } from 'web-push';
import { and, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { getVapidKeys } from '../push.js';

const subscribed = await db
  .select()
  .from(devices)
  .where(and(isNotNull(devices.pushSubscription), isNull(devices.revokedAt)));

console.log(`subscribed devices: ${subscribed.length}`);
if (subscribed.length === 0) {
  console.log('Nothing to send to. Turn on notifications on the phone first.');
  process.exit(1);
}

const keys = await getVapidKeys();
console.log(`vapid public key  : ${keys.publicKey.slice(0, 24)}… (${keys.publicKey.length} chars)`);

const subject = process.argv.includes('--subject')
  ? process.argv[process.argv.indexOf('--subject') + 1]
  : 'mailto:everything-app@localhost';
console.log(`vapid subject     : ${subject}\n`);

webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

for (const device of subscribed) {
  const subscription = JSON.parse(device.pushSubscription!) as PushSubscription;
  const host = (() => {
    try {
      return new URL(subscription.endpoint).host;
    } catch {
      return 'unparseable endpoint';
    }
  })();

  console.log(`${device.name} -> ${host}`);
  try {
    const result = await webpush.sendNotification(
      subscription,
      JSON.stringify({ title: 'Everything', body: 'Test push from the server.', tag: 'push-test' }),
      { TTL: 300 }
    );
    console.log(`  SENT  status ${result.statusCode}`);
  } catch (error) {
    const e = error as { statusCode?: number; body?: string; message?: string; headers?: unknown };
    console.log(`  FAILED status ${e.statusCode ?? '(none)'}`);
    console.log(`  message: ${e.message}`);
    if (e.body) console.log(`  body   : ${String(e.body).trim()}`);
  }
}

process.exit(0);
