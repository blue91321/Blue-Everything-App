/**
 * Talking to the voice package's endpoints.
 *
 * Its own client rather than entries on `api` in core, because core must not
 * know a package exists: deleting this folder takes its routes, its screens
 * and this file together. It goes through core's `apiRequest`, so its reads
 * are kept for offline use and its changes refused or queued by the same
 * rules as everything else. `manga-api.ts` was the first of these.
 *
 * The server half is `packages/modules/voice/server`.
 */

import { apiRequest as request, type AppSettings } from '@app/api';

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
  /** Closed because the desk is empty — distinct from off, paused and broken. */
  awayFromPc?: boolean;
  /** Open for one command from the listen shortcut, with voice switched off. */
  borrowed?: boolean;
  /** Fetching the speech models, in words, or null. */
  preparing?: string | null;
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
  /** Phrase words the recogniser never writes — a number in digits — so can never match. */
  unknownWords: string[];
  /**
   * Key combinations the agent could not register — nearly always taken by
   * another program. Optional so a newer bundle against an older server reads
   * as "none" rather than throwing.
   */
  hotkeyProblems?: string[];
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

export type VoiceCommandKind = 'habit' | 'note' | 'url' | 'hotkey' | 'media' | 'launch' | 'pause' | 'cancel' | 'music';

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

const post = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) });
const patch = <T>(path: string, payload: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) });

export const voiceApi = {
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
};
