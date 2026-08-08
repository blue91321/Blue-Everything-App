/**
 * Which feature screens this build actually contains.
 *
 * Discovered with `import.meta.glob` rather than a list of imports, because a
 * list is exactly what breaks when somebody deletes a folder: Vite resolves a
 * static `import './features/vault/view'` at build time and fails the build if
 * the file is gone. A glob returns whatever is there and nothing else, so
 * deleting a folder is a supported operation rather than a broken build.
 *
 * Two globs, deliberately:
 *
 *   - **meta** is eager. It is a handful of strings per feature and the drawer
 *     needs it to draw the menu; making it lazy would mean loading every
 *     feature's code to find out what to call its tab, which is the opposite of
 *     the point.
 *   - **view** is lazy. This is the part that costs something, and a feature
 *     that is off or that Blake never opens is never downloaded at all.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export interface FeatureViewProps {
  /** Whether this browser is on the PC running the server. */
  local: boolean;
}

export interface FeatureMeta {
  /** Must match the id the server uses in `/api/session`. */
  id: string;
  label: string;
  glyph: string;
  /** Where it sits in the drawer. Core items occupy 10–40. */
  order: number;
}

export interface WebFeature extends FeatureMeta {
  View: LazyExoticComponent<ComponentType<FeatureViewProps>>;
}

const metaModules = import.meta.glob<{ meta: FeatureMeta }>('./*/meta.ts', { eager: true });
const viewModules = import.meta.glob<{ default: ComponentType<FeatureViewProps> }>('./*/view.tsx');

/** './vault/meta.ts' -> 'vault' */
const folderOf = (path: string) => path.split('/')[1];

export const webFeatures: WebFeature[] = Object.entries(metaModules)
  .map(([path, mod]) => {
    const folder = folderOf(path);
    const load = viewModules[`./${folder}/view.tsx`];
    // A meta with no view is a half-deleted feature. Dropping it is kinder than
    // rendering a tab that throws the moment it is clicked.
    if (!load) return null;
    return { ...mod.meta, View: lazy(load) };
  })
  .filter((f): f is WebFeature => f !== null)
  .sort((a, b) => a.order - b.order);

/** Present in this build. Being *enabled* is the server's call, not ours. */
export const installedFeatureIds: string[] = webFeatures.map((f) => f.id);

/* ------------------------------------------------------------------ */
/* What the server says is on                                          */
/* ------------------------------------------------------------------ */

/**
 * A module-level store rather than context or a prop.
 *
 * The screens that need this are three and four levels down — the voice-phrase
 * editor inside the habit editor inside the Habits screen — and none of them
 * take a `session` today. Threading one through purely to answer "is voice on"
 * would touch every component in between for a boolean that changes once per
 * page load.
 *
 * No subscription and no re-render on change, because there is no change to
 * react to: `App` sets this from the session before it renders anything, and a
 * feature being switched off elsewhere arrives as an SSE reload of the whole
 * page rather than as a live update. If that ever stops being true this needs
 * to become real state.
 */
let enabledIds: string[] | undefined;

export function setEnabledFeatures(ids: string[] | undefined): void {
  enabledIds = ids;
}

/**
 * Undefined means a server old enough not to send the list, which is treated as
 * everything on — the ordinary case right after an edit, when the PWA has been
 * rebuilt and the server has not restarted. A stale server should look stale,
 * not like an app that has lost half its features.
 */
export function featureEnabled(id: string): boolean {
  return enabledIds === undefined || enabledIds.includes(id);
}
