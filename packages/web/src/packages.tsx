/**
 * Screens and panels that arrived in a zip.
 *
 * The built-in features are found by `import.meta.glob`, which Vite resolves at
 * **build time** — that is what makes deleting a folder a supported operation,
 * and it is also why it can never see a package installed after the build. So a
 * package's browser half is loaded the only way a browser can load code it did
 * not know about: fetched, then imported.
 *
 * ### Why a blob, and not a `<script>` or a URL import
 *
 * Everything personal in this app sits behind a bearer token, and neither
 * `<script src>` nor `import('/api/…')` sends an Authorization header — the same
 * constraint that put the icons and the notification tones *outside* `/api/`.
 * That escape is not available here: those are a colour and a sine wave, while
 * this is code from a package you installed, on a server that binds `0.0.0.0`.
 *
 * So the source is fetched with the token like any other API call and imported
 * as a blob URL, which is exactly what the habit pictures do with their bytes.
 *
 * The cost is real and worth stating: a blob has no base URL, so a relative
 * `import './helper.js'` inside a package cannot resolve. A package's browser
 * half must be **one self-contained file**, which is why it is given React
 * rather than importing it.
 *
 * ### One React, handed over rather than imported
 *
 * A package that imported its own React would ship a second copy — 60KB it does
 * not need — and, far worse, hooks from one React inside a tree rendered by
 * another throw at runtime in ways that read as the package being broken. So
 * `register(host)` receives the app's own React, its API client and its
 * navigation port, and a package bundles nothing at all.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import * as React from 'react';
import { api } from './api';
import { useAsync } from './useAsync';
import { goTo } from './nav';
import type { PanelMeta, PanelProps, FeatureViewProps } from './features';

/** What a package declares in its manifest, as `/api/session` reports it. */
export interface PackageInfo {
  id: string;
  label: string;
  tab: { label: string; glyph: string; order: number } | null;
  panels: PanelMeta[];
}

/** Everything a package is handed. Deliberately small — see the note above. */
export interface PackageHost {
  React: typeof React;
  api: typeof api;
  useAsync: typeof useAsync;
  goTo: typeof goTo;
  /** The app's version, so a package can say what it is running against. */
  version: string;
  /** Whether this browser is on the PC running the server. */
  local: boolean;
}

/** What a package's entry file returns. Every field optional. */
export interface PackageRegistration {
  screen?: ComponentType<FeatureViewProps>;
  /** Keyed by the *local* panel id — `now`, not `weather:now`. */
  panels?: Record<string, ComponentType<PanelProps>>;
}

type Entry = { default?: (host: PackageHost) => PackageRegistration };

/*
 * Set by `App` from the session before anything renders, exactly as
 * `setEnabledFeatures` is and for the same reason: the drawer and the panel
 * picker are built during render and there is nothing to subscribe to — a
 * package being switched on arrives as an SSE reload of the whole page.
 */
let installed: PackageInfo[] = [];
let hostFacts: { version: string; local: boolean } = { version: '', local: false };

export function setInstalledPackages(list: PackageInfo[] | undefined, facts: { version: string; local: boolean }): void {
  installed = list ?? [];
  hostFacts = facts;
}

export function installedPackages(): PackageInfo[] {
  return installed;
}

/**
 * Load a package's entry once, and remember the promise rather than the result.
 *
 * Keyed on the promise so two panels from one package — or a panel and its tab
 * opening together — share a single fetch. Resolving first and caching after
 * would let both start their own.
 */
const loading = new Map<string, Promise<PackageRegistration>>();

async function loadPackage(id: string): Promise<PackageRegistration> {
  const source = await api.modules.web(id);

  /*
   * `@vite-ignore` because the specifier is a runtime value. Without it Vite
   * tries to analyse and pre-bundle it at build time, which is precisely the
   * thing that cannot work for code that does not exist yet.
   */
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const entry = (await import(/* @vite-ignore */ url)) as Entry;
    if (typeof entry.default !== 'function') {
      throw new Error('its browser half does not export a default register function');
    }
    const registration = entry.default({
      React,
      api,
      useAsync,
      goTo,
      version: hostFacts.version,
      local: hostFacts.local,
    });
    return registration ?? {};
  } finally {
    /*
     * Revoked as soon as the import settles. The module stays live — the engine
     * has already compiled it — and holding the URL would keep the source text
     * in memory for every package ever opened.
     */
    URL.revokeObjectURL(url);
  }
}

function entryFor(id: string): Promise<PackageRegistration> {
  const existing = loading.get(id);
  if (existing) return existing;
  const started = loadPackage(id);
  loading.set(id, started);
  return started;
}

/**
 * A failure has to be visible, and it has to name the package.
 *
 * `lazy` rejects into the nearest error boundary, and this app has none — a
 * throwing package would blank the whole screen, which is the one outcome that
 * makes a bad package impossible to uninstall. So the error is turned into a
 * component that renders it.
 */
function failed(id: string, error: unknown): { default: ComponentType<never> } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    default: () =>
      React.createElement(
        'div',
        { className: 'banner' },
        React.createElement('strong', null, `The "${id}" package could not be loaded.`),
        ' ',
        message,
        ' — you can switch it off or remove it under Settings → Packages.'
      ),
  };
}

/** The lazy screen for a package's tab. */
export function packageScreen(id: string): LazyExoticComponent<ComponentType<FeatureViewProps>> {
  return lazy(async () => {
    try {
      const registration = await entryFor(id);
      if (!registration.screen) throw new Error('it declares a tab but exports no screen');
      return { default: registration.screen };
    } catch (error) {
      return failed(id, error) as { default: ComponentType<FeatureViewProps> };
    }
  });
}

/** Every panel offered by an installed package, with its full id. */
export function packagePanels(): Array<PanelMeta & { packageId: string }> {
  return installed.flatMap((pkg) => pkg.panels.map((panel) => ({ ...panel, packageId: pkg.id })));
}

/** The lazy component for a package panel id, or null if none answers to it. */
export function packagePanelComponent(
  panelId: string
): LazyExoticComponent<ComponentType<PanelProps>> | null {
  const owner = installed.find((pkg) => pkg.panels.some((panel) => panel.id === panelId));
  if (!owner) return null;

  /*
   * The stored id is `weather:now`; the package keyed its own panel `now`. The
   * prefix is added by the server rather than by the author, so this is the one
   * place it has to come back off.
   */
  const local = panelId.slice(owner.id.length + 1);

  return lazy(async () => {
    try {
      const registration = await entryFor(owner.id);
      const component = registration.panels?.[local];
      if (!component) throw new Error(`it offers a "${local}" panel but exports no component for it`);
      return { default: component };
    } catch (error) {
      return failed(owner.id, error) as { default: ComponentType<PanelProps> };
    }
  });
}
