/**
 * What the Dashboard shows, in which column and order, and how often it
 * refreshes (Settings → General).
 */
import { useState } from 'react';
import { api } from '../../api';
import { useAsync } from '../../useAsync';
import { panelChoices } from '../../panels';
import { CORE_BLOCKS, chosenBlocks } from '../../blocks';
import { featureEnabled } from '../../features';
import { OrderedPicker } from './OrderedPicker';
import { useUiText } from '../../ui-text';

/**
 * What sits beside the Dashboard.
 *
 * The options are discovered, not listed here: `panelChoices()` merges the
 * panels core owns with whatever the installed features declare, so a build with
 * `features/integrations` deleted simply offers one fewer and this file does not
 * change. Same reasoning as the drawer's tabs.
 *
 * Radio buttons rather than a dropdown, unlike the tone picker. There are three
 * of them, each wants a line of explanation about what you would actually see,
 * and a `<select>` has nowhere to put one.
 */
/**
 * What is on the Dashboard's main column, and in what order.
 *
 * Sits above the side-column picker because it is the Dashboard — the column
 * you are actually looking at — where the other is the strip beside it.
 */
/**
 * How often the Dashboard refetches, above both pickers.
 *
 * It used to sit inside the side-column section, on the reasoning that the
 * panels are the part of the Dashboard whose content moves without anybody
 * touching it — which was true when the only thing in the main column was your
 * own tasks. It is not any more: a shelf card there goes stale exactly as a
 * panel does. So it governs both columns, and now sits above both rather than
 * inside one of them.
 */
export function DashboardRefresh() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  return (
    <section>
      <RefreshRate
        seconds={settings.data?.dashboardRefreshSeconds ?? 0}
        onPick={(seconds) => void api.settings.update({ dashboardRefreshSeconds: seconds }).then(settings.reload)}
      />
    </section>
  );
}

export function DashboardBlocks() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  // A section renamed in edit mode is listed by its new name here too.
  const t = useUiText();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');

  // A server older than this column drops the field, and a picker that writes
  // something the server discards is worse than no picker at all.
  if (settings.data && settings.data.dashboardBlocks === undefined) return null;

  const chosen = chosenBlocks(settings.data);
  const isDefault = (settings.data?.dashboardBlocks ?? []).length === 0;

  /*
   * Core's own sections, plus everything the side column could hold. One pool,
   * two columns: a card is a card, and which column it goes in is your choice
   * rather than a property of the thing.
   *
   * A core section belonging to a switched-off feature is left out, the same
   * respect `notes:recent` pays its own switch.
   */
  const choices = [
    ...CORE_BLOCKS.filter((block) => !block.featureId || featureEnabled(block.featureId)).map(
      ({ id, label, hint }) => ({ id, label: t(`block:${id}`, label), hint })
    ),
    ...panelChoices().map(({ id, label, hint }) => ({ id, label, hint })),
  ];

  const save = async (blocks: string[]) => {
    setSaving(true);
    setProblem('');
    try {
      await api.settings.update({ dashboardBlocks: blocks });
      settings.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="dashboard-blocks">
      <h2>On the Dashboard</h2>

      <div className="card">
        <div className="meta" style={{ marginBottom: 8 }}>
          The Dashboard itself, top to bottom. Move anything anywhere — habits above your tasks, a
          package's card between them — or take a section off entirely.
        </div>

        <OrderedPicker
          chosen={chosen}
          choices={choices}
          saving={saving}
          onChange={(ids) => void save(ids)}
          missingNote="not in this build, kept for when it is back"
        />

        {/*
          Said rather than left to be inferred. An empty stored list and a list
          that happens to match the built-in order look identical on screen, and
          only one of them keeps up with a later version that adds a section.
        */}
        <div className="meta" style={{ marginTop: 12 }}>
          {isDefault
            ? 'This is the order the app ships with. Anything new in a later version appears here on its own.'
            : 'Your own order. A section added in a later version will not appear until you add it below.'}
        </div>

        {!isDefault && (
          <button className="btn subtle" style={{ marginTop: 8 }} disabled={saving} onClick={() => void save([])}>
            Back to the default order
          </button>
        )}

        {problem && <div className="meta warn" style={{ marginTop: 8 }}>{problem}</div>}
      </div>
    </section>
  );
}

export function DashboardPanel() {
  const settings = useAsync(() => api.settings.get(), [], ['settings']);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');

  const choices = panelChoices();

  // A server that predates the column sends nothing, and a picker that writes a
  // field the server drops is worse than no picker at all.
  if (settings.data && settings.data.dashboardPanels === undefined) return null;

  /*
   * The single `dashboardPanel` is the fallback, not a second source of truth.
   * A server older than the list column sends only that, and reading it here is
   * what keeps this screen usable on one while the other restarts.
   */
  const chosen =
    settings.data?.dashboardPanels ??
    (settings.data?.dashboardPanel ? [settings.data.dashboardPanel] : []);

  /**
   * One writer for every control here.
   *
   * The list and the live scope are two fields of one settings row and
   * `PATCH /api/settings` takes both, so a second saver would be a second copy
   * of the busy flag, the error handling and the reload.
   */
  const save = async (panels: string[], scope?: 'all' | 'favourites') => {
    setSaving(true);
    setProblem('');
    try {
      await api.settings.update({ dashboardPanels: panels, ...(scope ? { livePanelScope: scope } : {}) });
      settings.reload();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="dashboard-panel">
      <h2>Beside the Dashboard</h2>

      <div className="card">
        <div className="meta" style={{ marginBottom: 8 }}>
          A second column on a wide screen, holding as many of these as you like, one under the other in
          the order below. On a phone they sit underneath the Dashboard instead.
        </div>

        {chosen.length === 0 && (
          <div className="empty" style={{ marginTop: 8 }}>
            Nothing here — the Dashboard is one column. Add something below.
          </div>
        )}

        {/*
          The chosen ones first, in their order, because that is what the column
          looks like — the list on screen and the list on the Dashboard read
          top to bottom the same way.

          Arrows rather than drag and drop: the Habits screen already reorders
          this way, a list of three or four does not need a drag, and a drag is
          the one interaction that has to be built twice for touch.
        */}
        <OrderedPicker
          chosen={chosen}
          choices={choices}
          saving={saving}
          onChange={(ids) => void save(ids)}
          missingNote="not in this build, kept for when it is back"
        />

        {/*
          Only while the live panel is one of them. A scope control for a panel
          you are not showing is a setting for nothing — and worse, it invites the
          reading that it governs the Live *tab*, which always shows everybody.
        */}
        {chosen.includes('integrations:live') && settings.data?.livePanelScope !== undefined && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <div className="title">Which live channels</div>
            <div className="meta" style={{ marginTop: 4, marginBottom: 8 }}>
              The Connections tab always lists everyone on air; this is only the column on the Dashboard.
              Star a channel there to add it here.
            </div>

            <div className="row wrap" style={{ gap: '.35rem' }}>
              {LIVE_SCOPES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={(settings.data?.livePanelScope ?? 'all') === option.id ? 'btn primary' : 'btn subtle'}
                  disabled={saving}
                  onClick={() => void save(chosen, option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {problem && <div className="banner">{problem}</div>}
      </div>
    </section>
  );
}

/**
 * Two choices, so two buttons rather than a range input.
 *
 * A slider is the right control for a number on a continuum — the gauge drain
 * and fill both earn one. This is a pair of named alternatives, where a slider
 * would have two positions, no labels at the stops, and no way to show which is
 * live except by where the handle sat.
 */
const LIVE_SCOPES: { id: 'all' | 'favourites'; label: string }[] = [
  { id: 'all', label: 'Everyone I follow' },
  { id: 'favourites', label: 'Starred only' },
];

/**
 * How often an open Dashboard refetches on its own.
 *
 * **Off by default, and the copy leads with why.** Nothing else in this app
 * polls: the server announces changes over `/api/events` and every reader
 * refetches when one lands, which is how a habit ticked off on the phone shows
 * up on the PC without a timer anywhere.
 *
 * What that cannot see is data moving at somebody else's server — a friend
 * going idle on Steam, an hour passing in a stored forecast, a duration
 * counting up. That is what this is for, and saying so is what stops it reading
 * as "the app was broken and this fixes it".
 *
 * Named options rather than a slider. A slider is right for a number on a
 * continuum — the gauge drain earns one — and wrong for a handful of
 * alternatives where every position between them is a worse version of a
 * neighbour.
 */
const REFRESH_RATES = [
  { seconds: 0, label: 'Only when something changes' },
  { seconds: 30, label: 'Every 30 seconds' },
  { seconds: 60, label: 'Every minute' },
  { seconds: 300, label: 'Every 5 minutes' },
  { seconds: 900, label: 'Every 15 minutes' },
] as const;

function RefreshRate({ seconds, onPick }: { seconds: number; onPick: (seconds: number) => void }) {
  return (
    <div className="card">
      <div className="title">Refresh the Dashboard</div>
      <div className="meta" style={{ marginTop: 4 }}>
        Anything you change here or on your phone already appears immediately — the server says so and the
        screen listens. This is for what it cannot be told about: a friend going idle on Steam, an hour
        passing in the stored forecast, a timer on screen counting up.
      </div>

      <div className="row wrap" style={{ gap: '.35rem', marginTop: 8 }}>
        {REFRESH_RATES.map((rate) => (
          <button
            key={rate.seconds}
            type="button"
            className={seconds === rate.seconds ? 'btn primary' : 'btn subtle'}
            onClick={() => onPick(rate.seconds)}
          >
            {rate.label}
          </button>
        ))}
      </div>

      <div className="meta" style={{ marginTop: 8 }}>
        {seconds === 0
          ? 'Off — the Dashboard updates when something tells it to, and not on a clock.'
          : 'Only while the Dashboard is the screen you are on and the window is in front; a hidden tab costs nothing.'}
      </div>
    </div>
  );
}
