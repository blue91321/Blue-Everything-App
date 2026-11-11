/**
 * Talking to this package's endpoints, through core's request so the token,
 * the errors and the offline behaviour are the same as everywhere else.
 */
import { apiRequest } from '@app/api';
import type { Blueprint, Graph, Step } from './engine';

export type { Blueprint, Graph, GraphNode, Step, Wire } from './engine';

export interface Run {
  id: string;
  blueprint: string;
  at: number;
  from: string;
  dry: boolean;
  steps: Step[];
  waiting?: boolean;
  hand?: boolean;
}

export interface Template {
  id: string;
  name: string;
  blurb: string;
}

export interface Folder {
  id: string;
  name: string;
}

export interface State {
  blueprints: Blueprint[];
  /** Folders on the list. Absent from a server older than them. */
  folders?: Folder[];
  runs: Run[];
  waiting: string[];
  templates: Template[];
  /** The file could not be read; nothing will be saved until it is fixed. */
  error: string | null;
  attention: { state: string; away: boolean; game: string | null } | null;
  /** Whether the agent is there to hear hotkeys and press keys, and what it could not register. */
  agent?: { around: boolean; problems: string[] };
  /** Switches "Flip a switch" has turned on. Absent from a server older than them. */
  switchesOn?: string[];
  /** Every variable "Set a variable" keeps, and what it holds. Absent from a server older than them. */
  variables?: Record<string, number | string>;
  /**
   * Whether each can start now, by id: on, idle (waiting for something, like
   * its game being open), disabled (cannot as things are set, like voice
   * being off), off or stopped, and why. Absent from a server older than it.
   */
  statuses?: Record<string, BlueprintStatus>;
}

export interface BlueprintStatus {
  state: 'on' | 'idle' | 'disabled' | 'off' | 'stopped';
  why: string;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const blueprints = {
  get: () => apiRequest<State>('/api/blueprints'),
  create: (template: string) => apiRequest<Blueprint>('/api/blueprints', { method: 'POST', ...json({ template }) }),
  update: (id: string, patch: { name?: string; enabled?: boolean; graph?: Graph; folder?: string | null }) =>
    apiRequest<Blueprint>(`/api/blueprints/${encodeURIComponent(id)}`, { method: 'PUT', ...json(patch) }),
  remove: (id: string) => apiRequest<void>(`/api/blueprints/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  run: (id: string, from: string | null, dry: boolean) =>
    apiRequest<Run | { started: true }>(`/api/blueprints/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      ...json({ from, dry }),
    }),
  folders: {
    create: (name: string) => apiRequest<Folder>('/api/blueprints/folders', { method: 'POST', ...json({ name }) }),
    rename: (id: string, name: string) =>
      apiRequest<Folder>(`/api/blueprints/folders/${encodeURIComponent(id)}`, { method: 'PUT', ...json({ name }) }),
    remove: (id: string) => apiRequest<void>(`/api/blueprints/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  forgetVariable: (name: string) => apiRequest<void>(`/api/blueprints/variables/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  stop: (id: string) => apiRequest<{ stopped: number }>(`/api/blueprints/${encodeURIComponent(id)}/stop`, { method: 'POST', ...json({}) }),
};
