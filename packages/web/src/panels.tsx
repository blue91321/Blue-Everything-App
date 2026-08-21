/**
 * The Dashboard's side column: what can go in it, and how it is found.
 *
 * The Dashboard is core and the most useful panel comes from a feature that can
 * be deleted, so this cannot be a list of imports — that is the same bind the
 * drawer was in, and it is solved the same way: features declare panels in their
 * `meta.ts` and export a lazy `panel.tsx`, and core discovers them with a glob.
 * Core never imports a feature, and a build with `features/integrations` deleted
 * simply offers one fewer option.
 *
 * The chosen id is an **opaque string** in `settings.dashboard_panel`. Nothing
 * validates it — an id nothing answers to draws no panel, which is exactly what
 * should happen while a feature is switched off, and means switching it back on
 * restores the panel you had rather than finding the setting quietly erased.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { availablePanels, featureEnabled, panelComponent, type PanelMeta, type PanelProps } from './features';

/**
 * Panels core owns.
 *
 * Only one, and it is here rather than in a feature folder because `notes` is
 * switchable but not removable — there is no folder to delete, so there is
 * nowhere else for it to live. It still respects the switch: turning notes off
 * takes the option out of the picker.
 */
const CORE_PANELS: Array<PanelMeta & { featureId: string; Panel: LazyExoticComponent<ComponentType<PanelProps>> }> = [
  {
    id: 'notes:recent',
    label: 'Recent notes',
    hint: 'the last few things you jotted down',
    featureId: 'notes',
    Panel: lazy(() => import('./views/NotesPanel')),
  },
];

/** Everything offerable right now, core and features together. */
export function panelChoices(): Array<PanelMeta & { featureId: string }> {
  return [
    ...CORE_PANELS.filter((panel) => featureEnabled(panel.featureId)).map(({ Panel: _p, ...rest }) => rest),
    ...availablePanels(),
  ];
}

/**
 * The panels to draw, in order, out of what was chosen.
 *
 * Ids that nothing answers to are dropped rather than rendered as a gap — a
 * feature switched off should cost you that panel and nothing else, and the
 * stored list is left alone so switching it back on restores the order you had.
 *
 * Falls back to the single `dashboardPanel` when the list is absent, which is a
 * server older than the column rather than an empty choice: the two are
 * genuinely different and collapsing them would blank the column on any install
 * that had not restarted yet.
 */
export function chosenPanels(settings: {
  dashboardPanels?: string[];
  dashboardPanel?: string;
}): Array<{ id: string; Panel: LazyExoticComponent<ComponentType<PanelProps>> }> {
  const ids = settings.dashboardPanels ?? (settings.dashboardPanel ? [settings.dashboardPanel] : []);

  return ids
    .map((id) => ({ id, Panel: resolvePanel(id) }))
    .filter((entry): entry is { id: string; Panel: LazyExoticComponent<ComponentType<PanelProps>> } =>
      entry.Panel !== null
    );
}

/** What to draw for a chosen id, or null if nothing here answers to it. */
export function resolvePanel(panelId: string): LazyExoticComponent<ComponentType<PanelProps>> | null {
  if (panelId === '') return null;
  const core = CORE_PANELS.find((panel) => panel.id === panelId && featureEnabled(panel.featureId));
  return core?.Panel ?? panelComponent(panelId);
}
