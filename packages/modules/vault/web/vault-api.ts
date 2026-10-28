/**
 * Talking to the vault's endpoints.
 *
 * Its own client rather than entries on `api` in core, because core must not
 * know a package exists: deleting this folder takes its routes, its screens
 * and this file together. It goes through core's `apiRequest`, so its reads
 * are kept for offline use and its changes refused or queued by the same
 * rules as everything else. `manga-api.ts` was the first of these.
 *
 * The server half is `packages/modules/vault/server`.
 */

import { apiRequest as request } from '@app/api';

export interface VaultStatus {
  configured: boolean;
  hasRecovery: boolean;
  itemCount: number;
  unlocked: boolean;
  /** When the auto-lock will fire, if unlocked. */
  expiresAt: number | null;
  lockedOutUntil: number | null;
  autoLockMinutes: number;
}

/** The list view. Never carries a password — those come one at a time. */
export interface VaultSummary {
  id: string;
  title: string;
  username: string;
  url: string;
  createdAt: number;
  updatedAt: number;
}

export interface VaultSecret {
  id: string;
  password: string;
  totp: string;
  notes: string;
}

export interface ImportResult {
  preview: boolean;
  format: string;
  /** Preview only. */
  found?: number;
  wouldImport?: number;
  sample?: string[];
  /** Commit only. */
  imported?: number;
  duplicates: number;
  skippedWithoutPassword: number;
}

const post = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) });
const patch = <T>(path: string, payload: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) });
/** Alias, because `patch` is shadowed by a parameter name inside `vaultApi.update`. */
const patch2 = patch;

export const vaultApi = {
    status: () => request<VaultStatus>('/api/vault/status'),
    setup: (masterPassword: string, withRecovery: boolean) =>
      post<{ recoveryShares: { a: string; b: string } | null }>('/api/vault/setup', { masterPassword, withRecovery }),
    unlock: (masterPassword: string) => post<VaultStatus>('/api/vault/unlock', { masterPassword }),
    lock: () => post<VaultStatus>('/api/vault/lock'),
    items: () => request<VaultSummary[]>('/api/vault/items'),
    secret: (id: string) => request<VaultSecret>(`/api/vault/items/${id}/secret`),
    create: (item: Partial<VaultSecret> & { title: string; username?: string; url?: string }) =>
      post<VaultSummary>('/api/vault/items', item),
    update: (id: string, patch: Record<string, string>) => patch2(`/api/vault/items/${id}`, patch),
    remove: (id: string) => request<void>(`/api/vault/items/${id}`, { method: 'DELETE' }),
    recover: (shareA: string, shareB: string, newMasterPassword: string) =>
      post('/api/vault/recover', { shareA, shareB, newMasterPassword }),
    changePassword: (currentPassword: string, newPassword: string) =>
      post('/api/vault/change-password', { currentPassword, newPassword }),
    importCsv: (csv: string, commit: boolean, includeDuplicates = false) =>
      post<ImportResult>('/api/vault/import', { csv, commit, includeDuplicates }),
    regenerateRecovery: () =>
      post<{ recoveryShares: { a: string; b: string } }>('/api/vault/recovery/regenerate'),
    destroy: (masterPassword: string) =>
      post<{ ok: boolean; deletedEntries: number }>('/api/vault/destroy', { masterPassword }),
};
