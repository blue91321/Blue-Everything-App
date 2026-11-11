/**
 * The reader's gear.
 *
 * **Pictures first, words second** (2026-11-11, asked for "in the pursuit of
 * having it be as intuitive as possible"): each choice is a tile with a drawn
 * picture and a word or two under it, chosen ones filled in the accent, and
 * what a choice does in full is in its tooltip and its accessible name rather
 * than in paragraphs on the panel. Only what applies now is shown: the strip's
 * own switch in Scroll, the pages' in Pages.
 *
 * Shaped like the panel in the app it replaced: the choices, two sliders, then
 * Reset and More along the foot, with the rarely touched ones behind More. It
 * shows only what a web app can do: that app also locked the screen's rotation
 * and set the screen's own brightness, and a web app on an iPhone can do
 * neither, so the brightness slider dims the pages, and says so in its tooltip.
 *
 * Everything is kept per device — see `reader-prefs.ts`.
 */
import { useState, type ReactNode } from 'react';
import { Icon } from './Icons';
import { automaticText, QualityChoice } from './QualityChoice';
import { automaticNow, qualityPrefs, setQualityPrefs } from './quality';
import { BRIGHTNESS_MIN, DEFAULT_PREFS, HIDE_CHOICES, WIDTH_MIN, type ReaderMode, type ReaderPrefs } from './reader-prefs';

/**
 * One choice: a picture, a word or two, and the full sentence as its tooltip
 * and accessible name. `on` makes it a toggle or a picked option, drawn filled.
 */
function Tile({ icon, label, title, on, onClick }: { icon: ReactNode; label: string; title: string; on?: boolean; onClick: () => void }) {
  return (
    <button className="manga-tile" aria-pressed={on} title={title} aria-label={title} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function ReaderSettings({
  prefs,
  onChange,
  mode,
  onMode,
  detected = null,
  onShift,
  shifted = false,
  twoUp = false,
  missing = 0,
  reloading = false,
  onReload,
}: {
  prefs: ReaderPrefs;
  onChange: (change: Partial<ReaderPrefs>) => void;
  /** The mode showing now, which with switching by itself on may not be `prefs.mode`. */
  mode: ReaderMode;
  onMode: (mode: ReaderMode) => void;
  /** What this series was found (or picked) to be, while switching by itself is on. */
  detected?: ReaderMode | null;
  /** Move the pairs along by one page; only offered while two pages show side by side. */
  onShift?: () => void;
  shifted?: boolean;
  /** Whether two pages are side by side now. */
  twoUp?: boolean;
  /** Pages of this chapter not on screen yet: slow, failed, or still coming. */
  missing?: number;
  reloading?: boolean;
  /**
   * Ask for pages again, past any saved copy: the missing ones when there are
   * any, otherwise every page, for one that loaded but drew wrong.
   */
  onReload?: () => void;
}) {
  const [panel, setPanel] = useState<'main' | 'more'>('main');
  // Per device, beside the reader's own settings — see `quality.ts`.
  const [quality, setQuality] = useState(() => qualityPrefs().reading);
  const auto = automaticNow();
  const brightness = Math.round(prefs.brightness * 100);
  const zoom = mode === 'pages' ? prefs.pagesZoom : prefs.width;

  if (panel === 'more') {
    return (
      <div className="manga-reader-settings" role="dialog" aria-label="More reader settings">
        <button className="btn subtle" onClick={() => setPanel('main')}>
          ‹ Back
        </button>
        <HideChoice
          icon={<Icon.timerOpen />}
          title="When a chapter opens, hide the controls after"
          value={prefs.hideOnOpenMs}
          onPick={(ms) => onChange({ hideOnOpenMs: ms })}
        />
        <HideChoice
          icon={<Icon.timerTap />}
          title="After a tap brings the controls back, hide them after"
          value={prefs.hideAfterTapMs}
          onPick={(ms) => onChange({ hideAfterTapMs: ms })}
        />
        <div className="manga-tiles">
          <Tile
            icon={<Icon.scrollbar />}
            label="Scrollbar"
            title="Show the scrollbar down the side"
            on={prefs.scrollbar}
            onClick={() => onChange({ scrollbar: !prefs.scrollbar })}
          />
          <Tile
            icon={<Icon.hand />}
            label="Drag"
            title="Drag the page with the mouse to scroll it, or in Pages to turn it. A finger already does this, so touch is left alone."
            on={prefs.dragToScroll}
            onClick={() => onChange({ dragToScroll: !prefs.dragToScroll })}
          />
        </div>
        <div className="meta">Picture size</div>
        <QualityChoice
          label="How big the pictures are while reading"
          value={quality}
          auto={automaticText(auto.level, auto.speed)}
          onPick={(q) => setQuality(setQualityPrefs({ reading: q }).reading)}
        />
        {quality === 'auto' && <div className="meta">{automaticText(auto.level, auto.speed)}</div>}
      </div>
    );
  }

  return (
    <div className="manga-reader-settings" role="dialog" aria-label="Reader settings">
      <div className="manga-tiles" role="group" aria-label="How the chapter is shown">
        <Tile
          icon={<Icon.strip />}
          label="Scroll"
          title="Scroll: one long strip, for webtoons"
          on={mode === 'scroll'}
          onClick={() => onMode('scroll')}
        />
        <Tile
          icon={<Icon.book />}
          label="Pages"
          title="Pages: a page at a time, for manga printed as a book. Drag, scroll or use the arrow keys to turn them."
          on={mode === 'pages'}
          onClick={() => onMode('pages')}
        />
        <Tile
          icon={<Icon.wand />}
          label="Auto"
          title={
            "Switch by itself: black-and-white book pages open in Pages, webtoon strips in Scroll, remembered for each series" +
            (prefs.autoMode && detected ? `. This one looks like ${detected === 'pages' ? 'a printed manga' : 'a webtoon'}.` : '')
          }
          on={prefs.autoMode}
          onClick={() => onChange({ autoMode: !prefs.autoMode })}
        />
      </div>

      {mode === 'scroll' ? (
        <div className="manga-tiles">
          <Tile
            icon={<Icon.carryOn />}
            label="Endless"
            title="Carry on into the next chapter below the end of this one. The one you finished counts as read."
            on={prefs.infinite}
            onClick={() => onChange({ infinite: !prefs.infinite })}
          />
        </div>
      ) : (
        <>
          <div className="manga-tiles" role="group" aria-label="Pages side by side">
            <Tile icon={<Icon.onePage />} label="1 page" title="One page at a time" on={prefs.spread === 'one'} onClick={() => onChange({ spread: 'one' })} />
            <Tile
              icon={<Icon.twoPages />}
              label="2 pages"
              title="Two pages side by side, as the book has them"
              on={prefs.spread === 'two'}
              onClick={() => onChange({ spread: 'two' })}
            />
            <Tile
              icon={<Icon.fitPages />}
              label="Fit"
              title="Two side by side when the screen is wide enough, such as a phone held sideways; one otherwise"
              on={prefs.spread === 'auto'}
              onClick={() => onChange({ spread: 'auto' })}
            />
          </div>
          <div className="manga-tiles" role="group" aria-label="Reading direction">
            <Tile
              icon={<Icon.readLeft />}
              label="Right to left"
              title="Right to left, as Japanese manga is read: the first page of a pair on the right"
              on={prefs.rightToLeft}
              onClick={() => onChange({ rightToLeft: true })}
            />
            <Tile
              icon={<Icon.readRight />}
              label="Left to right"
              title="Left to right, as most comics outside Japan are read"
              on={!prefs.rightToLeft}
              onClick={() => onChange({ rightToLeft: false })}
            />
            {twoUp && onShift && (
              <Tile
                icon={<Icon.shiftPair />}
                label="Shift"
                title="Pages paired wrong? Move the pairs along by one page, for this chapter"
                on={shifted}
                onClick={onShift}
              />
            )}
          </div>
        </>
      )}

      <label className="manga-reader-slider" title="Dims the pages; the screen's own brightness is not something a web app can set">
        <Icon.sun />
        <input
          type="range"
          min={BRIGHTNESS_MIN * 100}
          max={100}
          step={1}
          value={brightness}
          aria-label="Page brightness"
          onChange={(e) => onChange({ brightness: Number(e.target.value) / 100 })}
        />
        <span className="meta">{brightness}%</span>
      </label>
      {/*
        One slider, two numbers: the strip's width in scroll mode and the pages'
        size in pages mode, kept apart so setting one does not undo the other.
      */}
      <label
        className="manga-reader-slider"
        title={mode === 'pages' ? "How big the pages are, against fitting the screen's height" : "How much of the screen's width the pages take"}
      >
        <Icon.zoom />
        <input
          type="range"
          min={WIDTH_MIN}
          max={100}
          step={5}
          value={zoom}
          aria-label={mode === 'pages' ? 'Page size' : 'Page width'}
          onChange={(e) => onChange(mode === 'pages' ? { pagesZoom: Number(e.target.value) } : { width: Number(e.target.value) })}
        />
        <span className="meta">{zoom}%</span>
      </label>
      <div className="manga-reader-settings-foot">
        <button
          className="btn subtle manga-reader-more"
          title="Brightness and size back to normal"
          disabled={prefs.brightness === DEFAULT_PREFS.brightness && zoom === 100}
          onClick={() =>
            onChange({ brightness: DEFAULT_PREFS.brightness, ...(mode === 'pages' ? { pagesZoom: DEFAULT_PREFS.pagesZoom } : { width: DEFAULT_PREFS.width }) })
          }
        >
          <Icon.reset /> Reset
        </button>
        {onReload && (
          <button
            className="btn subtle manga-reader-more"
            disabled={reloading}
            onClick={onReload}
            title={
              missing > 0
                ? `Ask again for the ${missing} page${missing === 1 ? '' : 's'} not here yet`
                : 'Ask again for every page, for one that came but looks wrong'
            }
          >
            <Icon.reload /> {reloading ? '…' : missing > 0 ? missing : 'Reload'}
          </button>
        )}
        <button className="btn subtle manga-reader-more" onClick={() => setPanel('more')}>
          <Icon.more /> More
        </button>
      </div>
    </div>
  );
}

function HideChoice({
  icon,
  title,
  value,
  onPick,
}: {
  icon: ReactNode;
  title: string;
  value: number | null;
  onPick: (ms: number | null) => void;
}) {
  return (
    <div className="manga-reader-hide" role="group" aria-label={title} title={title}>
      <div className="manga-reader-choices">
        <span className="manga-reader-hide-icon">{icon}</span>
        {HIDE_CHOICES.map((choice) => (
          <button
            key={choice.label}
            className="btn"
            aria-pressed={choice.ms === value}
            aria-label={choice.ms === null ? 'Never' : choice.label}
            onClick={() => onPick(choice.ms)}
          >
            {choice.ms === null ? '∞' : choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
