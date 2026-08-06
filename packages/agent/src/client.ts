/**
 * The agent's only link to the server: HTTP with a bearer token.
 *
 * Deliberately has no access to the database. The agent is a network client
 * exactly like the phone will be, which is what keeps the server free to move
 * to another machine later.
 */
import type { AttentionReport, DeliverableNudge, VoiceAgentReport, VoiceHeard } from '@everything/shared';
import { agentConfig } from './config.js';
import type { VoiceConfig } from './voice.js';

export interface AttentionResponse {
  moment: string | null;
  deliver: DeliverableNudge[];
}

/** Something for the agent to do on the machine Blake is sitting at. */
export type VoiceAction =
  | { do: 'open-url'; url: string }
  | { do: 'press-keys'; keys: string }
  | { do: 'pause'; untilMs: number | null };

/** What the server did with something it was told was said. */
export interface VoiceOutcome {
  outcome:
    | 'habit-checked'
    | 'note-added'
    | 'opened'
    | 'keys-sent'
    | 'paused'
    | 'captured-as-note'
    | 'ambiguous'
    | 'no-match'
    | 'wrong-speaker'
    | 'disabled';
  text: string;
  /** Human-readable summary — what the overlay will show. */
  say?: string;
  action?: VoiceAction;
  choices?: { id: string; label: string }[];
  habitName?: string;
  doneThisPeriod?: number;
  target?: number;
  met?: boolean;
}

export class ServerUnreachable extends Error {}

export class ServerClient {
  constructor(
    private readonly baseUrl = agentConfig.serverUrl,
    private readonly token = agentConfig.token
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 5000): Promise<T> {
    const method = init.method ?? 'GET';

    // Fastify rejects a request that declares JSON but sends nothing (415), so
    // action endpoints that take no payload still need an empty object.
    const body = init.body ?? (method === 'GET' ? undefined : '{}');

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        body,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          // Omitted entirely when empty: a local server trusts loopback, and an
          // empty `Bearer ` would be treated as a bad token rather than none.
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...init.headers,
        },
        // The PC sleeps and the server restarts; a hung socket must not wedge
        // the poll loop. Long-polling endpoints pass their own, longer budget.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ServerUnreachable(cause instanceof Error ? cause.message : 'network error');
    }

    if (response.status === 401) {
      throw new Error('server rejected the token — pair this device again');
    }
    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
    }

    return (await response.json()) as T;
  }

  report(payload: AttentionReport): Promise<AttentionResponse> {
    return this.request<AttentionResponse>('/api/attention', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  acknowledge(nudgeId: string): Promise<unknown> {
    return this.request(`/api/nudges/${nudgeId}/ack`, { method: 'POST' });
  }

  /** Wake word, phrase vocabulary and the enrolled voiceprint. */
  voiceConfig(): Promise<VoiceConfig> {
    return this.request<VoiceConfig>('/api/voice/config');
  }

  /**
   * Say what the microphone is doing, and get back what to do next — wake word,
   * chosen device, and whether a listening test is running. One round trip
   * rather than a status POST plus a config GET.
   */
  voiceAgentReport(status: VoiceAgentReport): Promise<Partial<VoiceConfig> & { testUntil: number; version: number }> {
    // The server may hold this open for `waitMs`, so the socket budget has to
    // exceed it or every long poll would abort as a timeout.
    return this.request(
      '/api/voice/agent',
      { method: 'POST', body: JSON.stringify(status) },
      (status.waitMs ?? 0) + 5000
    );
  }

  /** Report something heard during a test. Never acted on — see the route. */
  voiceHeard(event: VoiceHeard): Promise<unknown> {
    return this.request('/api/voice/heard', { method: 'POST', body: JSON.stringify(event) });
  }

  /** Only used by `voice-try`, to report which habit a phrase would reach. */
  habits(): Promise<{ id: string; name: string; active: number; voicePhrases: string[] }[]> {
    return this.request('/api/habits');
  }

  /**
   * A transcript, never audio. The recording is destroyed in the agent as soon
   * as it has been turned into text — there is deliberately no endpoint that
   * would accept it.
   */
  voiceCommand(payload: { text: string; speakerScore: number | null }): Promise<VoiceOutcome> {
    return this.request<VoiceOutcome>('/api/voice/command', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /** Run a specific command, after the overlay resolved a disambiguation. */
  runVoiceCommand(id: string, text = ''): Promise<VoiceOutcome> {
    return this.request<VoiceOutcome>(`/api/voice/command/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  /** Live voice state, as the Voice screen sees it. Used by the CLIs. */
  voiceStatus(): Promise<{
    enabled: boolean;
    agentRunning: boolean;
    listening: boolean;
    enrolling: boolean;
    enrolSamples: number;
    enrolAgreement: number | null;
  }> {
    return this.request('/api/voice/status');
  }

  startEnrol(): Promise<{ enrolUntil: number }> {
    return this.request('/api/voice/enrol/start', { method: 'POST' });
  }

  stopEnrol(): Promise<unknown> {
    return this.request('/api/voice/enrol/stop', { method: 'POST' });
  }

  enrolVoice(voiceprint: number[], samples: number): Promise<{ ok: boolean; dimensions: number }> {
    return this.request('/api/voice/enrol', {
      method: 'POST',
      body: JSON.stringify({ voiceprint, samples }),
    });
  }

  health(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/health');
  }
}
