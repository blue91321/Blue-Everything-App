import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  urlMatchesEntry,
  vaultChangePasswordSchema,
  vaultDestroySchema,
  vaultImportSchema,
  vaultItemSchema,
  vaultItemUpdateSchema,
  vaultRecoverSchema,
  vaultSetupSchema,
  vaultUnlockSchema,
} from '@everything/shared';
import { changes } from '../../events.js';
import { combineShares, decodeShare } from './crypto.js';
import { isDuplicate, readExport } from './import.js';
import * as session from './session.js';
import * as store from './store.js';

/**
 * Who may talk to the vault at all.
 *
 * The PC itself, and the browser extension — nothing else. The phone is
 * deliberately excluded even though it holds a valid token: passwords would
 * then travel to a device that cannot autofill them anyway, widening the blast
 * radius for no benefit. Relaxing this is one line, and should be a decision
 * rather than a default.
 */
function assertMayUseVault(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.isLocal || request.deviceKind === 'extension') return true;
  reply.code(403).send({ error: 'the vault is only available on this PC and the browser extension' });
  return false;
}

/** Every route below needs the vault open; this is the one place that checks. */
function requireUnlocked(reply: FastifyReply): Buffer | null {
  const key = session.useVaultKey();
  if (key) return key;
  reply.code(423).send({ error: 'vault is locked' });
  return null;
}

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/vault')) return;
    assertMayUseVault(request, reply);
  });

  /** Safe to call locked — says nothing about the contents. */
  app.get('/api/vault/status', async () => {
    const row = await store.getVaultRow();

    // An in-memory session can outlive the vault row it belongs to. Reporting
    // "not configured but unlocked" is incoherent, so the session is dropped
    // rather than described.
    if (!row && session.isUnlocked()) session.lock();

    return {
      configured: row !== null,
      hasRecovery: Boolean(row?.wrappedByRecovery),
      itemCount: row ? await store.countItems() : 0,
      ...session.status(),
      autoLockMinutes: session.AUTO_LOCK_MS / 60_000,
    };
  });

  /**
   * First-run setup. The recovery shares in this response are the only copy
   * that will ever exist — the server keeps the wrapping, not the code.
   */
  app.post('/api/vault/setup', async (request, reply) => {
    const body = vaultSetupSchema.parse(request.body);
    if (await store.isConfigured()) {
      return reply.code(409).send({ error: 'the vault already exists' });
    }

    const result = await store.setupVault(body.masterPassword, body.withRecovery);
    session.unlock(await store.openWithPassword(body.masterPassword));
    changes.emitChange('all');

    return reply.code(201).send({
      ...result,
      warning: 'These two shares are shown once. Store them in separate places; both are needed.',
    });
  });

  app.post('/api/vault/unlock', async (request, reply) => {
    const { masterPassword } = vaultUnlockSchema.parse(request.body);

    try {
      session.assertNotLockedOut();
    } catch (error) {
      return reply.code(429).send({ error: (error as Error).message });
    }

    try {
      session.unlock(await store.openWithPassword(masterPassword));
    } catch {
      session.recordFailedUnlock();
      // Deliberately vague: distinguishing "wrong password" from "corrupt data"
      // would tell an attacker which guesses were structurally close.
      return reply.code(401).send({ error: 'could not unlock the vault' });
    }

    return session.status();
  });

  app.post('/api/vault/lock', async () => {
    session.lock();
    return session.status();
  });

  /**
   * Recover with the two shares, setting a new master password in the same
   * step — recovering without immediately re-securing would leave the vault
   * open to whoever found the shares.
   */
  app.post('/api/vault/recover', async (request, reply) => {
    const body = vaultRecoverSchema.parse(request.body);

    let vaultKey: Buffer;
    try {
      const code = combineShares(decodeShare(body.shareA), decodeShare(body.shareB));
      vaultKey = await store.openWithRecoveryCode(code);
      code.fill(0);
    } catch {
      return reply.code(401).send({ error: 'those two shares did not open the vault' });
    }

    await store.rewrapWithPassword(vaultKey, body.newMasterPassword);
    session.unlock(vaultKey);
    changes.emitChange('all');
    return { ok: true, ...session.status() };
  });

  /**
   * Issue a new recovery kit, invalidating the old one.
   *
   * Needs only an unlocked vault, because unlocking already proved the master
   * password (or the old shares). Asking again would add friction without
   * adding a check.
   */
  app.post('/api/vault/recovery/regenerate', async (_request, reply) => {
    const key = requireUnlocked(reply);
    if (!key) return;

    const shares = await store.regenerateRecovery(key);
    changes.emitChange('vault');
    return {
      recoveryShares: shares,
      warning: 'The previous kit no longer works. These two are shown once.',
    };
  });

  /**
   * Delete the vault and everything in it.
   *
   * Takes the master password rather than trusting the open session: this
   * cannot be undone, and an unlocked vault sitting on screen is too easy to
   * destroy by accident.
   */
  app.post('/api/vault/destroy', async (request, reply) => {
    const { masterPassword } = vaultDestroySchema.parse(request.body);

    try {
      const key = await store.openWithPassword(masterPassword);
      key.fill(0);
    } catch {
      return reply.code(401).send({ error: 'that password is wrong' });
    }

    const { deletedEntries } = await store.destroyVault();
    session.lock();
    changes.emitChange('vault');
    return { ok: true, deletedEntries };
  });

  app.post('/api/vault/change-password', async (request, reply) => {
    const body = vaultChangePasswordSchema.parse(request.body);

    let vaultKey: Buffer;
    try {
      vaultKey = await store.openWithPassword(body.currentPassword);
    } catch {
      return reply.code(401).send({ error: 'the current password is wrong' });
    }

    await store.rewrapWithPassword(vaultKey, body.newPassword);
    session.unlock(vaultKey);
    return { ok: true };
  });

  /* ---------------- items ---------------- */

  app.get('/api/vault/items', async (_request, reply) => {
    const key = requireUnlocked(reply);
    if (!key) return;
    return store.listItems(key);
  });

  /** The only route that returns a password, and only ever one at a time. */
  app.get('/api/vault/items/:id/secret', async (request, reply) => {
    const key = requireUnlocked(reply);
    if (!key) return;

    const { id } = request.params as { id: string };
    const item = await store.getItem(key, id);
    if (!item) return reply.code(404).send({ error: 'no such item' });

    return { id: item.id, password: item.password, totp: item.totp, notes: item.notes };
  });

  app.post('/api/vault/items', async (request, reply) => {
    const key = requireUnlocked(reply);
    if (!key) return;

    const created = await store.createItem(key, vaultItemSchema.parse(request.body));
    changes.emitChange('vault');
    return reply.code(201).send(created);
  });

  app.patch('/api/vault/items/:id', async (request, reply) => {
    const key = requireUnlocked(reply);
    if (!key) return;

    const { id } = request.params as { id: string };
    const updated = await store.updateItem(key, id, vaultItemUpdateSchema.parse(request.body));
    if (!updated) return reply.code(404).send({ error: 'no such item' });

    changes.emitChange('vault');
    return updated;
  });

  app.delete('/api/vault/items/:id', async (request, reply) => {
    const key = requireUnlocked(reply);
    if (!key) return;

    const { id } = request.params as { id: string };
    await store.deleteItem(id);
    changes.emitChange('vault');
    return reply.code(204).send();
  });

  /**
   * Import a browser password export.
   *
   * Two-phase on purpose: the first call reports what would happen and writes
   * nothing, so a mis-detected layout is caught before a thousand mangled
   * entries land in the vault. Only `commit: true` writes.
   *
   * The CSV is never logged, never stored, and never returned — and neither
   * are the passwords in the preview, which reports counts and titles only.
   */
  app.post('/api/vault/import', async (request, reply) => {
    const key = requireUnlocked(reply);
    if (!key) return;

    const body = vaultImportSchema.parse(request.body);

    let parsed;
    try {
      parsed = readExport(body.csv);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const existing = await store.listItems(key);
    const seen = existing.map((item) => ({ url: item.url, username: item.username }));

    const fresh = parsed.entries.filter(
      (entry) => body.includeDuplicates || !seen.some((old) => isDuplicate(entry, { ...entry, ...old }))
    );
    const duplicates = parsed.entries.length - fresh.length;

    if (!body.commit) {
      return {
        preview: true,
        format: parsed.format,
        found: parsed.entries.length,
        wouldImport: fresh.length,
        duplicates,
        skippedWithoutPassword: parsed.skipped,
        // Titles only — a preview must not become a way to read the file back.
        sample: fresh.slice(0, 5).map((entry) => entry.title),
      };
    }

    let imported = 0;
    for (const entry of fresh) {
      await store.createItem(key, entry);
      imported++;
    }

    changes.emitChange('vault');
    return {
      preview: false,
      format: parsed.format,
      imported,
      duplicates,
      skippedWithoutPassword: parsed.skipped,
    };
  });

  /**
   * What the browser extension asks: "anything for this page?"
   *
   * Matching happens here rather than in the extension because the entries are
   * encrypted at rest and only this process holds the key. Returns summaries
   * only — the extension fetches the actual password separately, once the user
   * has chosen an entry.
   */
  app.get('/api/vault/match', async (request, reply) => {
    const key = requireUnlocked(reply);
    if (!key) return;

    const { url } = request.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'url is required' });

    const items = await store.listItems(key);
    return items.filter((item) => item.url && urlMatchesEntry(item.url, url));
  });
}
