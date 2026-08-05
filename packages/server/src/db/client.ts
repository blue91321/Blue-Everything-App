/**
 * The database handle.
 *
 * libsql is chosen specifically for the move-it-later requirement: the same
 * client speaks to a local SQLite file (`file:./data/everything.db`) and to a
 * remote server (`libsql://…` or `http://…`). Relocating the database is a
 * DATABASE_URL change, not a driver swap.
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { schema } from './schema.js';

/** libsql won't create a missing directory for a `file:` URL, so do it here. */
function ensureLocalDirectory(url: string): void {
  if (!url.startsWith('file:')) return;
  const filePath = resolve(url.slice('file:'.length));
  mkdirSync(dirname(filePath), { recursive: true });
}

ensureLocalDirectory(config.DATABASE_URL);

export const client = createClient({
  url: config.DATABASE_URL,
  authToken: config.DATABASE_AUTH_TOKEN,
});

export const db = drizzle(client, { schema });
export type Database = typeof db;
