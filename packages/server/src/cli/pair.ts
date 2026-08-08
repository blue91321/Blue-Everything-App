/**
 * Pair a device and print its bearer token exactly once.
 *
 *   npm run pair -w @everything/server -- "your Phone" phone
 *
 * Only the SHA-256 hash is stored, so a lost token can't be recovered — pair
 * again and revoke the old device. That's the intended failure mode.
 */
import { randomBytes } from 'node:crypto';
import { registerDeviceSchema } from '@everything/shared';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { hashToken } from '../auth.js';

const [name, kind = 'browser'] = process.argv.slice(2);

if (!name) {
  console.error('usage: npm run pair -w @everything/server -- "<device name>" <windows-agent|phone|browser>');
  process.exit(1);
}

const parsed = registerDeviceSchema.safeParse({ name, kind });
if (!parsed.success) {
  console.error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

const token = randomBytes(32).toString('base64url');
const [device] = await db
  .insert(devices)
  .values({ name: parsed.data.name, kind: parsed.data.kind, tokenHash: hashToken(token) })
  .returning();

console.log(`\nPaired "${device.name}" (${device.kind})`);
console.log(`  device id: ${device.id}`);
console.log(`\n  token: ${token}\n`);
console.log('This is the only time the token is shown. Store it in the device config now.');
process.exit(0);
