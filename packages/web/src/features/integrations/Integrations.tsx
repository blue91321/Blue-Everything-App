/**
 * Connections: the outside services, who is online, and what you listen to.
 *
 * Three tabs rather than one long scroll, for the reason Settings has them: the
 * screen holds three genuinely different questions — "is this hooked up",
 * "who's about", "what have I been listening to" — and whichever one you came
 * for would otherwise be in the middle of the other two. Which tab is open is
 * `useState`, like every other bit of navigation here.
 *
 * The design rule running through all of it: **a capability that cannot work
 * says why, where you would look for it**. Four of the seven services here
 * cannot do the obvious thing — Battle.net has no friends API at all, Epic's is
 * gated behind per-friend consent, Discord's needs their approval, YouTube
 * stopped serving watch history in 2016 — and a row that renders as merely empty
 * sends you hunting for a setting that was never there.
 */
import { useState } from 'react';
import { api } from '../../api';
import { Connections } from './Connections';
import { Following } from './Following';
import { Friends } from './Friends';
import { Music } from './Music';

type Tab = 'friends' | 'following' | 'connections' | 'music';

const TABS: Array<{ id: Tab; label: string }> = [
  // Friends first, and deliberately: it is the one you open repeatedly, while
  // connections is a screen you visit twice a year.
  { id: 'friends', label: 'Friends' },
  // Next to Friends because they answer neighbouring questions — who do I know,
  // and who do I follow — but separate because only one of them has a status.
  { id: 'following', label: 'Following' },
  { id: 'music', label: 'Music' },
  { id: 'connections', label: 'Services' },
];

export function Integrations({ local }: { local: boolean }) {
  const [tab, setTab] = useState<Tab>('friends');

  return (
    <section>
      <h2>Connections</h2>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'friends' && <Friends />}
      {tab === 'following' && <Following />}
      {tab === 'music' && <Music local={local} />}
      {tab === 'connections' && <Connections local={local} />}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

/**
 * How a capability's status is drawn, everywhere it appears.
 *
 * One definition because the same four words show up on the services list, the
 * friends list and the music tab, and three copies would eventually disagree
 * about what "partial" looks like.
 */
export const STATUS_LABEL: Record<string, string> = {
  works: 'works',
  partial: 'partly',
  'needs-approval': 'needs approval',
  unavailable: 'not possible',
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`chip status-${status}`} title={STATUS_LABEL[status] ?? status}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * The eighteen families, in English.
 *
 * Here rather than in Music.tsx because Following needs them too — an artist
 * carries the same category a track does. A second copy would be the first
 * thing to drift, and the one that drifted would be a label nobody looks at
 * twice.
 *
 * Duplicated from `MUSIC_CATEGORY_LABELS` in shared, which this bundle
 * deliberately does not import — see the note at the top of api.ts. Display
 * copy only; nothing here refuses anything.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  rock: 'Rock',
  metal: 'Metal',
  punk: 'Punk',
  pop: 'Pop',
  hiphop: 'Hip-hop',
  rnb: 'R&B / Soul',
  electronic: 'Electronic',
  dance: 'Dance / House',
  jazz: 'Jazz / Blues',
  classical: 'Classical',
  folk: 'Folk / Acoustic',
  country: 'Country',
  latin: 'Latin',
  world: 'World',
  soundtrack: 'Soundtrack / Game',
  ambient: 'Ambient / Chill',
  spoken: 'Spoken word',
  unknown: 'Uncategorised',
};


export function relativeTime(at: number | null | undefined): string {
  if (!at) return 'never';
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Shared by every tab that can kick off a sync. */
export async function runSync(provider: string, capabilities?: string[]) {
  return (await api.integrations.sync(provider, capabilities)).outcomes;
}
