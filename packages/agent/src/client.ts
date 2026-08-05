/**
 * The agent's only link to the server: HTTP with a bearer token.
 *
 * Deliberately has no access to the database. The agent is a network client
 * exactly like the phone will be, which is what keeps the server free to move
 * to another machine later.
 */
import type { AttentionReport, DeliverableNudge } from '@everything/shared';
import { agentConfig } from './config.js';

export interface AttentionResponse {
  moment: string | null;
  deliver: DeliverableNudge[];
}

export class ServerUnreachable extends Error {}

export class ServerClient {
  constructor(
    private readonly baseUrl = agentConfig.serverUrl,
    private readonly token = agentConfig.token
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
        // the poll loop.
        signal: AbortSignal.timeout(5000),
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

  health(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/health');
  }
}
