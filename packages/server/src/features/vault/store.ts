/**
 * Reading and writing the vault.
 *
 * Everything that crosses this boundary is either fully encrypted (going down)
 * or fully decrypted (coming up); nothing half-way. Callers never see key
 * material and never see a sealed blob.
 */
import { desc, eq } from 'drizzle-orm';
import type { VaultItemInput } from '@everything/shared';
import { db } from '../../db/client.js';
import { vault, vaultEntries } from '../../db/schema.js';
import {
  KDF,
  KDF_VERSION,
  deriveKeyFromPassword,
  deriveKeyFromRecoveryCode,
  encodeShare,
  newRecoveryCode,
  newSalt,
  newVaultKey,
  open,
  seal,
  splitSecret,
  unwrapVaultKey,
  wrapVaultKey,
} from './crypto.js';

/** What a decrypted entry looks like once open. */
export interface VaultItem extends VaultItemInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** The list view: everything except the secrets themselves. */
export type VaultItemSummary = Omit<VaultItem, 'password' | 'totp' | 'notes'>;

export async function getVaultRow() {
  const [row] = await db.select().from(vault).limit(1);
  return row ?? null;
}

export const isConfigured = async (): Promise<boolean> => (await getVaultRow()) !== null;

export interface SetupResult {
  /** Shown exactly once. Never stored anywhere in any form. */
  recoveryShares: { a: string; b: string } | null;
}

/**
 * Create the vault.
 *
 * The recovery code is generated, used to wrap the vault key, split, and then
 * dropped — the server keeps only the wrapping. Losing both printed shares is
 * therefore unrecoverable by design; there is no copy to find.
 */
export async function setupVault(masterPassword: string, withRecovery: boolean): Promise<SetupResult> {
  if (await isConfigured()) throw new Error('the vault already exists');

  const salt = newSalt();
  const vaultKey = newVaultKey();
  const passwordKey = await deriveKeyFromPassword(masterPassword, salt);

  let wrappedByRecovery: string | null = null;
  let recoveryShares: { a: string; b: string } | null = null;

  if (withRecovery) {
    const code = newRecoveryCode();
    wrappedByRecovery = wrapVaultKey(vaultKey, deriveKeyFromRecoveryCode(code));
    const shares = splitSecret(code);
    recoveryShares = { a: encodeShare(shares.a), b: encodeShare(shares.b) };
    code.fill(0);
  }

  await db.insert(vault).values({
    id: 'singleton',
    kdfSalt: salt.toString('base64'),
    kdfVersion: KDF_VERSION,
    kdfMemoryKiB: KDF.memoryKiB,
    kdfPasses: KDF.passes,
    kdfParallelism: KDF.parallelism,
    wrappedByPassword: wrapVaultKey(vaultKey, passwordKey),
    wrappedByRecovery,
  });

  vaultKey.fill(0);
  passwordKey.fill(0);
  return { recoveryShares };
}

/**
 * Derive and unwrap. Throws on a wrong password — indistinguishably from a
 * corrupted wrapping, because GCM cannot tell you which it was.
 */
export async function openWithPassword(masterPassword: string): Promise<Buffer> {
  const row = await getVaultRow();
  if (!row) throw new Error('no vault has been set up');

  const key = await deriveKeyFromPassword(masterPassword, Buffer.from(row.kdfSalt, 'base64'));
  try {
    return unwrapVaultKey(row.wrappedByPassword, key);
  } finally {
    key.fill(0);
  }
}

export async function openWithRecoveryCode(code: Buffer): Promise<Buffer> {
  const row = await getVaultRow();
  if (!row?.wrappedByRecovery) throw new Error('this vault has no recovery code');

  const key = deriveKeyFromRecoveryCode(code);
  try {
    return unwrapVaultKey(row.wrappedByRecovery, key);
  } finally {
    key.fill(0);
  }
}

/**
 * Re-wrap the vault key under a new password.
 *
 * Only 32 bytes are re-encrypted; the items are untouched. That is the entire
 * point of the envelope, and it means changing the master password is instant
 * and cannot half-fail across a thousand entries.
 */
export async function rewrapWithPassword(vaultKey: Buffer, newPassword: string): Promise<void> {
  const row = await getVaultRow();
  if (!row) throw new Error('no vault has been set up');

  // A fresh salt too, so the new password shares nothing with the old.
  const salt = newSalt();
  const key = await deriveKeyFromPassword(newPassword, salt);
  try {
    await db
      .update(vault)
      .set({
        kdfSalt: salt.toString('base64'),
        kdfVersion: KDF_VERSION,
        kdfMemoryKiB: KDF.memoryKiB,
        kdfPasses: KDF.passes,
        kdfParallelism: KDF.parallelism,
        wrappedByPassword: wrapVaultKey(vaultKey, key),
      })
      .where(eq(vault.id, row.id));
  } finally {
    key.fill(0);
  }
}

/**
 * Issue a fresh recovery kit, replacing any existing one.
 *
 * Works whether or not the vault already had recovery — the same operation
 * both replaces a lost kit and adds one to a vault created without.
 *
 * The old shares stop working the instant this returns, which is the point:
 * a half-lost kit is a liability, since whoever finds the surviving share is
 * one share away rather than two.
 */
export async function regenerateRecovery(vaultKey: Buffer): Promise<{ a: string; b: string }> {
  const row = await getVaultRow();
  if (!row) throw new Error('no vault has been set up');

  const code = newRecoveryCode();
  const wrapped = wrapVaultKey(vaultKey, deriveKeyFromRecoveryCode(code));
  const shares = splitSecret(code);
  code.fill(0);

  await db.update(vault).set({ wrappedByRecovery: wrapped }).where(eq(vault.id, row.id));
  return { a: encodeShare(shares.a), b: encodeShare(shares.b) };
}

/**
 * Destroy the vault and everything in it.
 *
 * Genuinely irreversible: the entries are encrypted under a key that exists
 * only in the wrapping being deleted, so there is nothing left to recover from
 * even with the master password. The caller must prove it knows that password
 * first.
 */
export async function destroyVault(): Promise<{ deletedEntries: number }> {
  const deleted = await db.delete(vaultEntries).returning({ id: vaultEntries.id });
  await db.delete(vault);
  return { deletedEntries: deleted.length };
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

const EMPTY: VaultItemInput = { title: '', username: '', password: '', url: '', notes: '', totp: '' };

function decrypt(vaultKey: Buffer, row: { id: string; sealed: string; createdAt: number; updatedAt: number }): VaultItem {
  const content = JSON.parse(open(vaultKey, row.sealed).toString('utf8')) as VaultItemInput;
  return { ...EMPTY, ...content, id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export async function listItems(vaultKey: Buffer): Promise<VaultItemSummary[]> {
  const rows = await db.select().from(vaultEntries).orderBy(desc(vaultEntries.updatedAt));
  return rows.map((row) => {
    const { password: _p, totp: _t, notes: _n, ...summary } = decrypt(vaultKey, row);
    return summary;
  });
}

/** Full entry including secrets. Only ever called for one item at a time. */
export async function getItem(vaultKey: Buffer, id: string): Promise<VaultItem | null> {
  const [row] = await db.select().from(vaultEntries).where(eq(vaultEntries.id, id));
  return row ? decrypt(vaultKey, row) : null;
}

export async function createItem(vaultKey: Buffer, input: VaultItemInput): Promise<VaultItemSummary> {
  const [row] = await db
    .insert(vaultEntries)
    .values({ sealed: seal(vaultKey, JSON.stringify({ ...EMPTY, ...input })).blob })
    .returning();

  const { password: _p, totp: _t, notes: _n, ...summary } = decrypt(vaultKey, row);
  return summary;
}

export async function updateItem(
  vaultKey: Buffer,
  id: string,
  patch: Partial<VaultItemInput>
): Promise<VaultItemSummary | null> {
  const existing = await getItem(vaultKey, id);
  if (!existing) return null;

  const { id: _id, createdAt: _c, updatedAt: _u, ...current } = existing;
  const merged: VaultItemInput = { ...current, ...patch };

  const [row] = await db
    .update(vaultEntries)
    .set({ sealed: seal(vaultKey, JSON.stringify(merged)).blob })
    .where(eq(vaultEntries.id, id))
    .returning();

  const { password: _p, totp: _t, notes: _n, ...summary } = decrypt(vaultKey, row);
  return summary;
}

export async function deleteItem(id: string): Promise<void> {
  await db.delete(vaultEntries).where(eq(vaultEntries.id, id));
}

export const countItems = async (): Promise<number> => (await db.select({ id: vaultEntries.id }).from(vaultEntries)).length;
