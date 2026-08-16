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
 *     that is off or that you never opens is never downloaded at all.
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
  /** What this feature offers to put in the Dashboard's side column. */
  panels: PanelMeta[];
  Panel: LazyExoticComponent<ComponentType<PanelProps>> | null;
}

/**
 * One thing a feature offers to show beside the Dashboard.
 *
 * A list rather than a single panel per feature, because a feature genuinely
 * may have more than one worth putting there — integrations could offer both
 * who is online and what you follow — and discovering that after picking the
 * one-per-feature shape would mean changing every feature that had adopted it.
 */
export interface PanelMeta {
  /**
   * Globally unique. By convention `<feature>:<what>`, which is not enforced —
   * it is stored as an opaque string in `settings.dashboard_panel` and core
   * never parses it.
   */
  id: string;
  label: string;
  /** One line under the picker, saying what you would actually see. */
  hint?: string;
}

export interface PanelProps {
  /** The id being asked for, since one module may serve several panels. */
  panelId: string;
}

const metaModules = import.meta.glob<{ meta: FeatureMeta; panels?: PanelMeta[] }>('./*/meta.ts', {
  eager: true,
});
const viewModules = import.meta.glob<{ default: ComponentType<FeatureViewProps> }>('./*/view.tsx');
/**
 * Lazy like the views, and for a stronger reason: a panel that is not the one
 * you chose must not be downloaded at all, and the Dashboard is the screen that
 * has to open fastest.
 */
const panelModules = import.meta.glob<{ default: ComponentType<PanelProps> }>('./*/panel.tsx');

/** './vault/meta.ts' -> 'vault' */
const folderOf = (path: string) => path.split('/')[1];

export const webFeatures: WebFeature[] = Object.entries(metaModules)
  .map(([path, mod]) => {
    const folder = folderOf(path);
    const load = viewModules[`./${folder}/view.tsx`];
    // A meta with no view is a half-deleted feature. Dropping it is kinder than
    // rendering a tab that throws the moment it is clicked.
    if (!load) return null;
    /*
     * Typed as possibly absent, which `import.meta.glob` does not do for you:
     * its record type makes every lookup look defined, so a plain truthiness
     * check on a missing key is flagged as always true while being exactly the
     * check that is needed. A feature with no `panel.tsx` is the normal case.
     */
    const loadPanel: (typeof panelModules)[string] | undefined = panelModules[`./${folder}/panel.tsx`];
    return {
      ...mod.meta,
      View: lazy(load),
      // Panels declared with no module behind them are dropped for the same
      // reason a meta with no view is: an option in a picker that renders
      // nothing when chosen is worse than an option that is not offered.
      panels: loadPanel === undefined ? [] : mod.panels ?? [],
      Panel: loadPanel === undefined ? null : lazy(loadPanel),
    };
  })
  .filter((f): f is WebFeature => f !== null)
  .sort((a, b) => a.order - b.order);

/** Present in this build. Being *enabled* is the server's call, not ours. */
export const installedFeatureIds: string[] = webFeatures.map((f) => f.id);

/**
 * Every panel this build can draw, from features that are switched on.
 *
 * Filtered by `featureEnabled` rather than only by what is on disk, because the
 * two are genuinely different states here as everywhere else: a panel from a
 * feature you switched off should stop being *offered*, while the stored
 * setting is left alone so switching the feature back on restores what you had.
 */
export function availablePanels(): Array<PanelMeta & { featureId: string }> {
  return webFeatures
    .filter((f) => featureEnabled(f.id))
    .flatMap((f) => f.panels.map((panel) => ({ ...panel, featureId: f.id })));
}

/** The lazy component for a chosen panel id, or null if nothing answers to it. */
export function panelComponent(
  panelId: string
): LazyExoticComponent<ComponentType<PanelProps>> | null {
  const owner = webFeatures.find(
    (f) => featureEnabled(f.id) && f.panels.some((p) => p.id === panelId)
  );
  return owner?.Panel ?? null;
}

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
