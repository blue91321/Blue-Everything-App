/**
 * The unlocked state of the vault.
 *
 * The vault key lives in memory and nowhere else: never written to disk, never
 * logged, never returned by any route. A server restart locks the vault, which
 * is a feature — there is no persistence path for it to leak through.
 */
import { randomBytes } from 'node:crypto';

/** Locks itself after this long without vault activity. */
export const AUTO_LOCK_MS = 15 * 60_000;

/**
 * Slows guessing beyond what Argon2id already costs.
 *
 * Argon2 at 256 MiB means roughly one guess per second per core, which is
 * already brutal for an attacker — but it also means an attacker who *has* the
 * database file is doing this offline where none of this applies. This limit is
 * about the network-facing path only, and keeps a stuck client from hammering
 * the CPU.
 */
export const MAX_FAILED_UNLOCKS = 5;
export const FAILED_UNLOCK_COOLDOWN_MS = 60_000;

interface UnlockedState {
  vaultKey: Buffer;
  unlockedAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

let unlocked: UnlockedState | null = null;
let failedAttempts = 0;
let lockedOutUntil = 0;

/** Overwrite key material before dropping it, so it isn't left in freed heap. */
function wipe(buffer: Buffer): void {
  randomBytes(buffer.length).copy(buffer);
  buffer.fill(0);
}

export function lock(): void {
  if (!unlocked) return;
  clearTimeout(unlocked.timer);
  wipe(unlocked.vaultKey);
  unlocked = null;
}

export function unlock(vaultKey: Buffer): void {
  lock();
  const expiresAt = Date.now() + AUTO_LOCK_MS;
  unlocked = {
    vaultKey,
    unlockedAt: Date.now(),
    expiresAt,
    timer: setTimeout(lock, AUTO_LOCK_MS),
  };
  // Never keep the process alive just to hold an unlocked vault.
  unlocked.timer.unref?.();
  failedAttempts = 0;
}

/**
 * The vault key, or null when locked. Touching it pushes the auto-lock back,
 * so an active session doesn't lock under you mid-edit.
 */
export function useVaultKey(): Buffer | null {
  if (!unlocked) return null;
  if (Date.now() >= unlocked.expiresAt) {
    lock();
    return null;
  }

  clearTimeout(unlocked.timer);
  unlocked.expiresAt = Date.now() + AUTO_LOCK_MS;
  unlocked.timer = setTimeout(lock, AUTO_LOCK_MS);
  unlocked.timer.unref?.();
  return unlocked.vaultKey;
}

export const isUnlocked = (): boolean => useVaultKey() !== null;

export function status(): { unlocked: boolean; expiresAt: number | null; lockedOutUntil: number | null } {
  const key = unlocked && Date.now() < unlocked.expiresAt ? unlocked : null;
  return {
    unlocked: Boolean(key),
    expiresAt: key?.expiresAt ?? null,
    lockedOutUntil: lockedOutUntil > Date.now() ? lockedOutUntil : null,
  };
}

/** Throws when too many wrong passwords have been tried recently. */
export function assertNotLockedOut(): void {
  if (lockedOutUntil > Date.now()) {
    const seconds = Math.ceil((lockedOutUntil - Date.now()) / 1000);
    throw new Error(`too many failed attempts — try again in ${seconds}s`);
  }
}

export function recordFailedUnlock(): void {
  failedAttempts++;
  if (failedAttempts >= MAX_FAILED_UNLOCKS) {
    lockedOutUntil = Date.now() + FAILED_UNLOCK_COOLDOWN_MS;
    failedAttempts = 0;
  }
}

/** Tests only — a cooldown left over from one check must not fail the next. */
export function resetForTests(): void {
  lock();
  failedAttempts = 0;
  lockedOutUntil = 0;
}
