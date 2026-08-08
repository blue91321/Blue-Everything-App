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
  /** The date matters, the time of day doesn't. `dueAt` is end of that day. */
  dueIsAllDay: number;
  /** 1 yes, 0 no, null follows the default in Settings. */
  pushToPhone: number | null;
  projectId: string | null;
  createdAt: number;
  completedAt: number | null;
}

/** What the API accepts for a task, as opposed to what a row looks like. */
export interface TaskInput {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: number;
  dueAt?: number | null;
  dueIsAllDay?: boolean;
  /** null puts it back to following the default rather than meaning "no". */
  pushToPhone?: boolean | null;
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
  /** Minutes since midnight before reminders start; null means straight away. */
  reminderStartMinute: number | null;
  /** 1 yes, 0 no, null follows the default in Settings. */
  pushToPhone: number | null;
  /** Things you can say to tick this off. Empty means voice can't reach it. */
  voicePhrases: string[];
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
  /** A short tone with each popup. Absent on a server older than the column. */
  soundEnabled?: number;
  pushEnabled: number;
  /**
   * What a task or habit that hasn't chosen gets. Optional for the same reason
   * the voice fields are — a server predating the column sends nothing, and the
   * screen should hide the control rather than render a switch stuck on.
   */
  pushDefault?: number;
  /** Public half only; the private key never leaves the server. */
  vapidPublicKey: string;
  awayFromPcIdleMinutes: number;
  /** Live from the agent, not stored. */
  windowsDnd: boolean;
  /** Whether reminders are silenced right this second, and why. */
  quietNow: boolean;
  quietReason: 'reminders-off' | 'paused' | 'quiet-hours' | 'windows-dnd' | null;

  /**
   * How the app looks. Optional for the same reason the voice fields are — a
   * server that predates the appearance migration sends neither, and the app
   * falls back to dark + blue rather than rendering an empty picker.
   */
  theme?: 'dark' | 'light' | 'system';
  accentColor?: string;
  logoShape?: 'pause' | 'circle' | 'triangle' | 'square' | 'image';
  /** Bumped on every upload; used to bust caches on the icon URLs. */
  logoVersion?: number;

  /**
   * Optional because the server can genuinely be older than this bundle — the
   * PWA is rebuilt and served by a process that may not have restarted yet.
   * Typed as present when it isn't is what turned a stale server into a blank
   * Settings screen, so the absence is in the type now and has to be handled.
   */
  voiceEnabled?: number;
  wakeWord?: string;
  requireKnownSpeaker?: number;
  /** 0-1. Stored as whole percent; converted on the way out of the server. */
  speakerThreshold?: number;
  /** The voiceprint itself is never sent — no screen has a use for 128 floats. */
  hasVoiceprint?: boolean;
  voiceprintSamples?: number;
  /** Microphone name; null follows the Windows default. */
  voiceInputDevice?: string | null;
  /** Seconds it keeps listening after answering. 0 switches follow-ups off. */
  voiceFollowUpSeconds?: number;
  voiceRetrySeconds?: number;
  overlayPlacement?: string;
  overlayScreen?: string | null;
  /** An emoji, `file` for an uploaded picture, or empty for none. */
  overlayAvatar?: string;
  updatedAt?: number;
}

/** An `AppSettings` from a server that actually has voice support. */
export type VoiceSettings = AppSettings & Required<Pick<AppSettings, 'wakeWord' | 'speakerThreshold' | 'voiceprintSamples'>>;

export const serverSupportsVoice = (settings: AppSettings): settings is VoiceSettings =>
  settings.wakeWord !== undefined;

/** Live state of the listener, as last reported by the agent. */
export interface VoiceStatus {
  /** The setting. Whether anything is *actually* listening is `listening`. */
  enabled: boolean;
  agentRunning: boolean;
  listening: boolean;
  device: string | null;
  devices: { id: number; name: string }[];
  error: string | null;
  /** Loudest level since the agent's last report, 0-1. Drives the meter. */
  peak: number;
  lastReportAt: number | null;
  selectedDevice: string | null;
  paused: boolean;
  /** -1 means until switched back on by hand; a timestamp means until then. */
  pausedUntil: number | null;
  testing: boolean;
  testUntil: number;
  /** The last test ended because a command matched, not because it ran out. */
  testSucceeded: boolean;
  /** Collecting wake-word samples right now. */
  enrolling: boolean;
  enrolUntil: number;
  enrolSamples: number;
  /** How well the last sample agreed with the ones before it, 0-1. */
  enrolAgreement: number | null;
  /** Phrase words the speech model cannot pronounce, so can never be heard. */
  unknownWords: string[];
  followUpSeconds: number;
  retrySeconds: number;
  overlayPlacement: string;
  overlayScreen: string | null;
  overlayAvatar: string;
  /** Monitors the agent can see — the browser only knows about its own. */
  screens: { id: string; label: string; primary: boolean }[];
  heard: {
    /** `speech` is words heard while still waiting for the wake word. */
    kind: 'level' | 'speech' | 'wake' | 'command';
    /** Whether the transcript actually contains the wake word. */
    matchedWake: boolean;
    text: string;
    speakerScore: number | null;
    peak: number;
    at: number;
    wouldMatch: { habitName: string | null; phrase: string } | null;
  }[];
}

export type VoiceCommandKind = 'habit' | 'note' | 'url' | 'hotkey' | 'media' | 'pause' | 'cancel';

export interface VoiceCommand {
  id: string;
  kind: VoiceCommandKind;
  phrases: string[];
  /** Habit id, URL, or key combo, depending on `kind`. */
  target: string | null;
  pauseMinutes: number | null;
  /** Server-derived display name when none was set by hand. */
  label: string | null;
  /** Whether the microphone stays open after this one fires. */
  allowFollowUp: boolean;
  enabled: boolean;
  sortOrder: number;
}

/** What `/api/voice/test` says a sentence would do. Nothing is written. */
export interface VoiceTest {
  heard: string;
  tokens: string[];
  count: number;
  match: { id: string; phrase: string; score: number; habitName: string | null } | null;
  /**
   * Set when the sentence is several commands joined by "and", in the order
   * they would run. `match` is null whenever this is present — a chain is not
   * one match, and showing the first would describe a fraction of what happens.
   *
   * Optional because a server older than chaining sends neither field.
   */
  chain?:
    | { phrase: string; kind: VoiceCommandKind; habitName: string | null; count: number }[]
    | null;
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
  /** What the server is running. Absent on a server older than this field. */
  version?: string;
  /**
   * Which optional features this server runs, e.g. `['vault', 'voice']`.
   *
   * Optional for the same reason the voice settings are: the three packages
   * restart independently and `start.ps1` rebuilds the PWA when its sources are
   * newer, so a browser holding a new bundle against a server that predates
   * this field is the *ordinary* case right after an edit. Absent means "an
   * older server", which is treated as everything on — a stale server should
   * look stale, not like an app with no features.
   */
  features?: string[];
  /** Switched on but with its folder deleted. Distinct from simply off. */
  featuresMissing?: string[];
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
    /** Only works on an already-revoked device — the server enforces that. */
    remove: (id: string) => request<void>(`/api/devices/${id}`, { method: 'DELETE' }),
  },

  tasks: {
    list: (status = 'todo,doing') => request<Task[]>(`/api/tasks?status=${encodeURIComponent(status)}`),
    create: (payload: TaskInput & { title: string }) => post<Task>('/api/tasks', payload),
    // Not Partial<Task>: the row stores dueIsAllDay as 0/1, but the API takes a
    // boolean, and letting the row type through here sends the wrong one.
    update: (id: string, payload: TaskInput) => patch<Task>(`/api/tasks/${id}`, payload),
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
        reminderStartMinute?: number | null;
        pushToPhone?: boolean | null;
        voicePhrases?: string[];
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
      theme?: 'dark' | 'light' | 'system';
      accentColor?: string;
      logoShape?: 'pause' | 'circle' | 'triangle' | 'square' | 'image';
      quietHoursEnabled?: boolean;
      quietStartMinute?: number;
      quietEndMinute?: number;
      followWindowsDnd?: boolean;
      dndUntil?: number | null;
      remindersEnabled?: boolean;
      soundEnabled?: boolean;
      pushEnabled?: boolean;
      pushDefault?: boolean;
      voiceEnabled?: boolean;
      wakeWord?: string;
      requireKnownSpeaker?: boolean;
      speakerThreshold?: number;
      voiceInputDevice?: string | null;
      voiceFollowUpSeconds?: number;
      voiceRetrySeconds?: number;
      overlayPlacement?: string;
      overlayScreen?: string | null;
      overlayAvatar?: string;
    }) => patch<AppSettings>('/api/settings', payload),
  },

  logo: {
    /**
     * Upload a picture to use as the mark.
     *
     * Sent as base64 in JSON rather than multipart, matching the voice avatar:
     * the server has no multipart parser registered and adding one for a single
     * endpoint used once in a blue moon is a dependency for nothing.
     */
    upload: (file: File) =>
      new Promise<{ ok: boolean; bytes: number }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('could not read that file'));
        reader.onload = () => {
          const result = String(reader.result);
          // Strip the `data:image/png;base64,` prefix the reader adds.
          const data = result.slice(result.indexOf(',') + 1);
          request<{ ok: boolean; bytes: number }>('/api/logo', {
            method: 'PUT',
            body: JSON.stringify({ data, type: file.type }),
          }).then(resolve, reject);
        };
        reader.readAsDataURL(file);
      }),

    remove: () => request<{ ok: boolean }>('/api/logo', { method: 'DELETE' }),
  },

  voice: {
    /** Dry run: what would this sentence do? Writes nothing. */
    test: (text: string) => post<VoiceTest>('/api/voice/test', { text }),
    forgetVoice: () => request<void>('/api/voice/enrol', { method: 'DELETE' }),
    status: () => request<VoiceStatus>('/api/voice/status'),
    commands: () => request<VoiceCommand[]>('/api/voice/commands'),
    createCommand: (payload: Partial<VoiceCommand>) => post<VoiceCommand>('/api/voice/commands', payload),
    updateCommand: (id: string, payload: Partial<VoiceCommand>) =>
      patch<VoiceCommand>(`/api/voice/commands/${id}`, payload),
    removeCommand: (id: string) => request<void>(`/api/voice/commands/${id}`, { method: 'DELETE' }),
    resume: () => post('/api/voice/resume'),
    uploadAvatar: (data: string, type: string) =>
      request<{ ok: boolean }>('/api/voice/avatar', {
        method: 'PUT',
        body: JSON.stringify({ data, type }),
      }),
    startEnrol: () => post<{ enrolUntil: number }>('/api/voice/enrol/start'),
    stopEnrol: () => post('/api/voice/enrol/stop'),
    startListening: () => post<{ testUntil: number }>('/api/voice/test-listen'),
    stopListening: () => post('/api/voice/test-listen/stop'),
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
