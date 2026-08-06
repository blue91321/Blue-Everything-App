/**
 * Talking to the server.
 *
 * Row types are declared here rather than imported from @everything/shared
 * because the API returns database rows — integer booleans, nullable columns —
 * while the shared package describes the *input* schemas. They're related but
 * not the same shape, and pretending otherwise causes quiet type lies.
 *
 * All paths are relative, so the same build works on localhost and over
 * Tailscale with no configuration.
 */

const TOKEN_KEY = 'everything.token';

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token.trim());
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

/** Thrown on 401 so the UI can drop back to the pairing screen. */
export class Unauthorized extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const body = init.body ?? (method === 'GET' ? undefined : '{}');

  const response = await fetch(path, {
    ...init,
    body,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${getToken()}`,
      ...init.headers,
    },
  });

  if (response.status === 401) throw new Unauthorized('this device is not paired');
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status})`);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const post = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) });
const patch = <T>(path: string, payload: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) });
/** Alias, because `patch` is shadowed by a parameter name inside api.vault. */
const patch2 = patch;

/* ---------- row shapes ---------- */

export type TaskStatus = 'todo' | 'doing' | 'done' | 'dropped';

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: number;
  dueAt: number | null;
  projectId: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface Habit {
  id: string;
  name: string;
  notes: string | null;
  cadence: 'daily' | 'weekly';
  targetPerPeriod: number;
  active: number;
  sortOrder: number;
  reminderEveryMinutes: number | null;
  periodKey: string;
  doneThisPeriod: number;
  met: boolean;
}

export interface AppSettings {
  quietHoursEnabled: number;
  quietStartMinute: number;
  quietEndMinute: number;
  followWindowsDnd: number;
  dndUntil: number | null;
  remindersEnabled: number;
  pushEnabled: number;
  /** Public half only; the private key never leaves the server. */
  vapidPublicKey: string;
  awayFromPcIdleMinutes: number;
  /** Live from the agent, not stored. */
  windowsDnd: boolean;
  /** Whether reminders are silenced right this second, and why. */
  quietNow: boolean;
  quietReason: 'reminders-off' | 'paused' | 'quiet-hours' | 'windows-dnd' | null;
}

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

export interface ConnectAddress {
  url: string;
  kind: 'tailscale-https' | 'tailscale' | 'lan' | 'local';
  label: string;
  secure: boolean;
}

export interface ConnectInfo {
  addresses: ConnectAddress[];
  tailscale: { dnsName: string; serving: boolean } | null;
  hostname: string;
  port: number;
}

export interface Note {
  id: string;
  title: string | null;
  body: string;
  pinned: number;
  updatedAt: number;
}

export interface Nudge {
  id: string;
  title: string;
  body: string | null;
  taskId: string | null;
  state: string;
  minQuality: 'any' | 'decent' | 'prime';
  earliestAt: number;
  deadlineAt: number | null;
  escalated: number;
}

export interface TimeEntry {
  id: string;
  taskId: string | null;
  label: string | null;
  startedAt: number;
  endedAt: number | null;
}

/* ---------- endpoints ---------- */

export interface Session {
  ok: boolean;
  /** True when running on the PC hosting the server — no token needed. */
  local: boolean;
  deviceId: string | null;
  deviceKind: string | null;
}

export interface Device {
  id: string;
  name: string;
  kind: string;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export const api = {
  health: () => request<{ ok: boolean }>('/health'),
  session: () => request<Session>('/api/session'),

  devices: {
    list: () => request<Device[]>('/api/devices'),
    create: (payload: { name: string; kind: 'phone' | 'browser' | 'windows-agent' | 'extension' }) =>
      post<Device & { token: string }>('/api/devices', payload),
    revoke: (id: string) => post(`/api/devices/${id}/revoke`),
  },

  tasks: {
    list: (status = 'todo,doing') => request<Task[]>(`/api/tasks?status=${encodeURIComponent(status)}`),
    create: (payload: { title: string; priority?: number; dueAt?: number | null; notes?: string | null }) =>
      post<Task>('/api/tasks', payload),
    update: (id: string, payload: Partial<Task>) => patch<Task>(`/api/tasks/${id}`, payload),
    remove: (id: string) => request<void>(`/api/tasks/${id}`, { method: 'DELETE' }),
  },

  habits: {
    list: () => request<Habit[]>('/api/habits'),
    create: (payload: { name: string; cadence?: 'daily' | 'weekly'; targetPerPeriod?: number }) =>
      post<Habit>('/api/habits', payload),
    update: (
      id: string,
      payload: {
        name?: string;
        cadence?: 'daily' | 'weekly';
        targetPerPeriod?: number;
        active?: boolean;
        reminderEveryMinutes?: number | null;
      }
    ) => patch<Habit>(`/api/habits/${id}`, payload),
    remove: (id: string) => request<void>(`/api/habits/${id}`, { method: 'DELETE' }),
    reorder: (ids: string[]) => post('/api/habits/reorder', { ids }),
    check: (id: string) => post(`/api/habits/${id}/check`),
    uncheck: (id: string) => post(`/api/habits/${id}/uncheck`),
  },

  connectInfo: () => request<ConnectInfo>('/api/connect-info'),

  settings: {
    get: () => request<AppSettings>('/api/settings'),
    update: (payload: {
      quietHoursEnabled?: boolean;
      quietStartMinute?: number;
      quietEndMinute?: number;
      followWindowsDnd?: boolean;
      dndUntil?: number | null;
      remindersEnabled?: boolean;
      pushEnabled?: boolean;
    }) => patch<AppSettings>('/api/settings', payload),
  },

  push: {
    subscribe: (subscription: unknown) => post('/api/devices/me/push', subscription),
  },

  vault: {
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
  },

  notes: {
    list: () => request<Note[]>('/api/notes'),
    create: (payload: { title?: string | null; body: string }) => post<Note>('/api/notes', payload),
    update: (id: string, payload: { title?: string | null; body?: string; pinned?: boolean }) =>
      patch<Note>(`/api/notes/${id}`, payload),
    remove: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
  },

  nudges: {
    queue: () => request<Nudge[]>('/api/nudges/queue'),
    create: (payload: { title: string; body?: string; minQuality?: string; deadlineAt?: number | null }) =>
      post<Nudge>('/api/nudges', payload),
    snooze: (id: string, minutes: number) => post(`/api/nudges/${id}/snooze`, { minutes }),
    dismiss: (id: string) => post(`/api/nudges/${id}/dismiss`),
  },

  time: {
    current: () => request<TimeEntry | null>('/api/time/current'),
    start: (payload: { taskId?: string | null; label?: string | null }) => post<TimeEntry>('/api/time/start', payload),
    stop: () => post<{ stopped: number }>('/api/time/stop'),
  },
};
