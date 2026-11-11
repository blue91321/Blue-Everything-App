/**
 * Talking to this package's endpoints, through core's request so the token,
 * the errors and the offline behaviour are the same as everywhere else.
 */
import { apiRequest } from '@app/api';

export interface CodeFile {
  path: string;
  size: number;
  /** When it last changed on disk, by the PC's clock. */
  modified: number;
  /** Against the last commit; null when it is as committed, or nobody knows. */
  changed: 'changed' | 'new' | null;
}

export interface Part {
  folder: string;
  title: string;
  summary: string;
  readme: string;
}

export interface Listing {
  source: 'git' | 'release' | null;
  canSave: boolean;
  /** When the running server started, by the PC's clock: a file newer than this is not in use yet. */
  startedAt: number;
  files: CodeFile[];
  parts: Part[];
}

export interface OpenedFile {
  path: string;
  size: number;
  version: string;
  text: string | null;
  why?: string;
  readOnly: string | null;
}

export interface Problem {
  line: number;
  column: number;
  message: string;
}

export type SaveResult =
  | { saved: true; version: string }
  | { saved: false; conflict: true; version: string }
  | { saved: false; problem: Problem };

const q = (path: string) => encodeURIComponent(path);

export const code = {
  list: () => apiRequest<Listing>('/api/code'),
  open: (path: string) => apiRequest<OpenedFile>(`/api/code/file?path=${q(path)}`),
  committed: (path: string) => apiRequest<{ text: string | null }>(`/api/code/committed?path=${q(path)}`),
  save: (path: string, text: string, version: string, force = false) =>
    apiRequest<SaveResult>('/api/code/file', {
      method: 'PUT',
      body: JSON.stringify({ path, text, version, force }),
    }),
};
