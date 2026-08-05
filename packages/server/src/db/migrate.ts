/**
 * Migrations run on boot.
 *
 * For a single-user app that will eventually be redeployed onto a VPS, "start
 * the server" and "bring the schema up to date" should be the same action.
 * There is nobody else to coordinate a migration window with.
 */
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db } from './client.js';

// Resolved from this file, not the working directory, so it survives being
// launched by a service manager from an arbitrary cwd.
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
}
