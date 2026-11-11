/**
 * How big pictures are, as a row of picture tiles: the reader's gear, saving
 * to the device, and the Local collection all choose with this, so the three
 * read alike. The smaller copies are made on the PC — see `server/compress.ts`.
 */
import type { ReactNode } from 'react';
import { Icon } from './Icons';
import type { Quality, ReadingQuality } from './quality';

const CHOICES: Array<{ id: Quality; icon: () => ReactNode; label: string; title: string }> = [
  {
    id: 'original',
    icon: Icon.pictureFull,
    label: 'Full',
    title: 'Pictures as the source sent them',
  },
  {
    id: 'smaller',
    icon: Icon.pictureSmaller,
    label: 'Smaller',
    title: 'Made smaller on the PC: up to 1200 pixels wide, about half the size of a big page, and hard to tell apart',
  },
  {
    id: 'smallest',
    icon: Icon.pictureSmallest,
    label: 'Smallest',
    title: 'Made smallest on the PC: up to 900 pixels wide, about a third of the size of a big page, a little softer',
  },
];

export function QualityChoice({
  value,
  onPick,
  auto,
  label,
}: {
  value: ReadingQuality;
  onPick: (q: ReadingQuality) => void;
  /** Offer Automatic first, saying what it would pick now. Reading only. */
  auto?: string;
  label: string;
}) {
  return (
    <div className="manga-tiles" role="group" aria-label={label}>
      {auto !== undefined && (
        <button className="manga-tile" aria-pressed={value === 'auto'} title={auto} aria-label={auto} onClick={() => onPick('auto')}>
          <Icon.wand />
          <span>Auto</span>
        </button>
      )}
      {CHOICES.map((c) => (
        <button key={c.id} className="manga-tile" aria-pressed={value === c.id} title={c.title} aria-label={c.title} onClick={() => onPick(c.id)}>
          <c.icon />
          <span>{c.label}</span>
        </button>
      ))}
    </div>
  );
}

/** What Automatic is doing, in words, for its tooltip and the line under the tiles. */
export function automaticText(level: Quality, speed: number | null): string {
  const now = level === 'original' ? 'full size' : level;
  if (speed === null) return 'Automatic: full size until it has seen how fast pages arrive, then smaller while the connection is slow';
  return `Automatic: ${now} now, pages arriving at about ${speed >= 1000 ? `${(speed / 1000).toFixed(1)} MB/s` : `${Math.round(speed)} KB/s`}`;
}
