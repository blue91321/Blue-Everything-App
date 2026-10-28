import { useEffect, useState } from 'react';
import { Editable } from '../ui-text';
import { type Session } from '../api';
import { GamesTab } from './settings/GamesTab';
import { PeopleTab } from './settings/PeopleTab';
import { DevicesTab } from './settings/DevicesTab';
import { GeneralTab } from './settings/GeneralTab';
import { NotificationsTab } from './settings/NotificationsTab';
import { PackagesTab } from './settings/PackagesTab';

/**
 * The Settings tabs.
 *
 * One long scroll was fine when this screen was a theme picker and a quiet-hours
 * switch. It is now appearance, reminders, phone push, sound, four kinds of
 * device, and the switches that decide which parts of the app exist at all —
 * and the thing you came to change was always somewhere in the middle of it.
 *
 * Which tab is open lives in `useState` like every other bit of navigation
 * here: there is no router, and the app has never had a URL for a screen.
 */
const TABS = [
  { id: 'general', label: 'General', hint: 'Appearance and reminders' },
  { id: 'notifications', label: 'Notifications', hint: 'Sound, quiet hours and the phone' },
  { id: 'devices', label: 'Devices', hint: 'Phones, browsers and the extension' },
  { id: 'games', label: 'Games', hint: 'What counts as a game, and what may interrupt one' },
  { id: 'packages', label: 'Packages', hint: 'Which parts of the app run' },
  // On the host only: friends' copies of the app on this PC. See PeopleTab.
  { id: 'people', label: 'People', hint: 'Friends with their own copy, on this PC' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const SECTION_TAB: Record<string, TabId> = {
  'dashboard-panel': 'general',
  'dashboard-blocks': 'general',
  'menu-drawer': 'general',
  'menu-home': 'general',
  'desktop-icon': 'devices',
};

export function Settings({
  session,
  onChanged,
  focus,
  onFocused,
}: {
  session: Session;
  onChanged: () => void;
  /** A section id to open and scroll to — see `SECTION_TAB`. */
  focus?: string | null;
  onFocused?: () => void;
}) {
  const [tab, setTab] = useState<TabId>('general');

  /*
   * Sent here by something that wanted a *particular* setting — the Dashboard
   * panel's "change what's here" button. The tabs made Settings much easier to
   * navigate and made linking into it impossible without this: the section you
   * were pointed at may be behind a tab you are not on, and landing on General
   * while the answer is under Packages is worse than not linking at all.
   */
  useEffect(() => {
    if (!focus) return;
    const home = SECTION_TAB[focus];
    if (!home) return;
    setTab(home);
    /*
     * **Waited for on a timer, not looked for once, and not on a frame.**
     *
     * Two goes at this, both silently doing nothing:
     *
     * A single `requestAnimationFrame` was the first, and the section is behind
     * its tab *and* behind a `useAsync` — so at the next frame it is usually not
     * in the document. Retrying across frames fixed that and still did nothing,
     * because **`requestAnimationFrame` does not fire at all when the page is
     * not compositing** — a hidden tab, a window nobody is showing. `setTimeout`
     * runs regardless, throttled at worst, for exactly the same complexity.
     *
     * Both failures presented identically: the tab switched, because that part
     * is synchronous, and nothing else happened. The half that worked hid the
     * half that did not.
     *
     * Bounded, so a section id that matches nothing gives up rather than
     * retrying for the life of the page.
     */
    let frames = 0;
    let cancelled = false;

    /*
     * **`onFocused` is called at the *end*, not before the wait.**
     *
     * Clearing the request changes `focus`, which re-runs this effect, whose
     * cleanup sets `cancelled` — so announcing "handled" up front cancelled the
     * frame loop it had just started, every time. The tab still switched, since
     * that happens synchronously, which is what made it look like the scroll was
     * the broken part rather than the waiting.
     */
    const done = () => {
      cancelled = true;
      onFocused?.();
    };

    const find = () => {
      if (cancelled) return;
      const element = document.getElementById(focus);
      if (!element) {
        // Giving up still counts as handled, or the request would sit there and
        // fire again the next time this screen mounted.
        if (frames++ < 120) setTimeout(find, 16);
        else done();
        return;
      }
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // A moment of highlight, because "we brought you here" is otherwise
      // indistinguishable from "the tab you opened happened to look like this".
      element.classList.add('flash');
      setTimeout(() => element.classList.remove('flash'), 1400);
      done();
    };
    setTimeout(find, 0);

    return () => {
      cancelled = true;
    };
  }, [focus, onFocused]);

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {TABS.filter((entry) => entry.id !== 'people' || session.copy === null).map((entry) => (
          <button
            key={entry.id}
            role="tab"
            className={`tab${tab === entry.id ? ' on' : ''}`}
            aria-selected={tab === entry.id}
            title={entry.hint}
            onClick={() => setTab(entry.id)}
          >
            <Editable id={`tab:settings:${entry.id}`} fallback={entry.label} inButton />
          </button>
        ))}
      </div>

      {tab === 'general' && <GeneralTab name={session.displayName ?? null} fallback={session.defaultName ?? 'user'} local={session.local} />}
      {tab === 'notifications' && <NotificationsTab session={session} />}
      {tab === 'devices' && <DevicesTab session={session} onChanged={onChanged} />}
      {tab === 'games' && <GamesTab session={session} />}
      {tab === 'packages' && <PackagesTab session={session} />}
      {tab === 'people' && session.copy === null && <PeopleTab />}
    </>
  );
}
