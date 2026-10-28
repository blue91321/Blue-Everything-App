/**
 * The password vault's inputs.
 */
import { z } from 'zod';
import { patchOf } from './patch.js';
import { NudgeQuality } from './attention.js';

/* ------------------------------------------------------------------ */
/* Vault                                                               */
/* ------------------------------------------------------------------ */

/**
 * A master password this short is not worth the Argon2id cost protecting it.
 * Long beats complex — the strength comes from length, so the UI should ask for
 * a passphrase rather than punctuation.
 */
export const MIN_MASTER_PASSWORD = 12;

export const vaultSetupSchema = z.object({
  masterPassword: z.string().min(MIN_MASTER_PASSWORD).max(1024),
  /** Off only if you explicitly accepts that a forgotten password is final. */
  withRecovery: z.boolean().default(true),
});

export const vaultUnlockSchema = z.object({
  masterPassword: z.string().min(1).max(1024),
});

export const vaultItemSchema = z.object({
  title: z.string().min(1).max(300),
  username: z.string().max(300).default(''),
  password: z.string().max(2000).default(''),
  /** Used to match a login form to an entry; encrypted like everything else. */
  url: z.string().max(2000).default(''),
  notes: z.string().max(20_000).default(''),
  /** TOTP secret, if the site has one. */
  totp: z.string().max(300).default(''),
});
export type VaultItemInput = z.infer<typeof vaultItemSchema>;
export const vaultItemUpdateSchema = patchOf(vaultItemSchema);

export const vaultRecoverSchema = z.object({
  shareA: z.string().min(1).max(200),
  shareB: z.string().min(1).max(200),
  newMasterPassword: z.string().min(MIN_MASTER_PASSWORD).max(1024),
});

export const vaultImportSchema = z.object({
  /** The raw export. Held in memory only; never written down or logged. */
  csv: z.string().min(1).max(20 * 1024 * 1024),
  /** Preview first; nothing is written until this is true. */
  commit: z.boolean().default(false),
  /** Bring in logins that already exist for the same site and username. */
  includeDuplicates: z.boolean().default(false),
});

/**
 * Deleting the vault takes the master password, not merely an unlocked
 * session. It is irreversible, so it should cost a deliberate act rather than
 * a stray click on an already-open screen.
 */
export const vaultDestroySchema = z.object({
  masterPassword: z.string().min(1).max(1024),
});

export const vaultChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(MIN_MASTER_PASSWORD).max(1024),
});

/**
 * Does a stored entry's URL match the page a login form is on?
 *
 * Compares registrable-ish host suffixes, so an entry for `example.com` fills
 * on `login.example.com`. Deliberately does *not* match the other way round: an
 * entry for `login.example.com` should not fill on `example.com.evil.test`.
 */
export function urlMatchesEntry(entryUrl: string, pageUrl: string): boolean {
  const host = (value: string): string | null => {
    try {
      return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  };

  const entryHost = host(entryUrl);
  const pageHost = host(pageUrl);
  if (!entryHost || !pageHost) return false;
  if (entryHost === pageHost) return true;

  // Suffix match must land on a dot boundary, or "evil-example.com" would match
  // "example.com".
  return pageHost.endsWith(`.${entryHost}`);
}

/** Shape the API returns for a nudge the client should show right now. */
export interface DeliverableNudge {
  id: string;
  title: string;
  body: string | null;
  taskId: string | null;
  habitId: string | null;
  minQuality: NudgeQuality;
  /** True when this fired because its deadline passed, not because the moment was good. */
  escalated: boolean;
}
