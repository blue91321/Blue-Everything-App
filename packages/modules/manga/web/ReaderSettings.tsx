/**
 * The reader's gear: brightness and page width, and behind More, when the
 * controls hide themselves.
 *
 * Shaped like the panel in the app it replaced — sliders first, a row of
 * actions along the foot, More leading to the rest — with only what a web app
 * can actually do. That app also locked the screen's rotation, which a web app
 * on an iPhone cannot, and set the screen's own brightness, which a web app
 * cannot either: the slider here dims the pages, and says so, rather than
 * pretending to be the thing in Control Centre.
 *
 * Everything is kept per device — see `reader-prefs.ts`.
 */
import { useState } from 'react';
import { Icon } from './Icons';
import { BRIGHTNESS_MIN, DEFAULT_PREFS, HIDE_CHOICES, WIDTH_MIN, type ReaderPrefs } from './reader-prefs';

export function ReaderSettings({
  prefs,
  onChange,
}: {
  prefs: ReaderPrefs;
  onChange: (change: Partial<ReaderPrefs>) => void;
}) {
  const [panel, setPanel] = useState<'main' | 'more'>('main');
  const brightness = Math.round(prefs.brightness * 100);

  if (panel === 'more') {
    return (
      <div className="manga-reader-settings" role="dialog" aria-label="When the controls hide">
        <button className="btn subtle" onClick={() => setPanel('main')}>
          ‹ Back
        </button>
        <HideChoice
          title="When a chapter opens, hide the controls after"
          value={prefs.hideOnOpenMs}
          onPick={(ms) => onChange({ hideOnOpenMs: ms })}
        />
        <HideChoice
          title="After a tap brings them back, hide them after"
          value={prefs.hideAfterTapMs}
          onPick={(ms) => onChange({ hideAfterTapMs: ms })}
        />
        <p className="meta">
          With Never they stay until you tap the page. Touching the controls restarts the countdown, and this panel
          holds them up while it is open. Kept on this device.
        </p>

        {/*
          Behind More with the countdowns, not on the front panel: these are set
          once and left, where brightness and width are reached for mid-chapter.
          Both are shown everywhere rather than hidden on touch — a phone browser
          decides for itself whether a scrollbar is drawn, and a tablet with a
          mouse is a real thing.
        */}
        <label className="manga-reader-check">
          <input
            type="checkbox"
            checked={prefs.scrollbar}
            onChange={(e) => onChange({ scrollbar: e.target.checked })}
          />{' '}
          Show the scrollbar
        </label>

        <label className="manga-reader-check">
          <input
            type="checkbox"
            checked={prefs.dragToScroll}
            onChange={(e) => onChange({ dragToScroll: e.target.checked })}
          />{' '}
          Drag the page to scroll
        </label>

        <p className="meta">
          Dragging is for a mouse — a finger already scrolls that way, so this leaves touch alone.
        </p>
      </div>
    );
  }

  return (
    <div className="manga-reader-settings" role="dialog" aria-label="Reader settings">
      <label className="manga-reader-slider" title="Dims the pages — the screen's own brightness is not something a web app can set">
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
      <label className="manga-reader-slider" title="How much of the screen's width the pages take">
        <Icon.zoom />
        <input
          type="range"
          min={WIDTH_MIN}
          max={100}
          step={5}
          value={prefs.width}
          aria-label="Page width"
          onChange={(e) => onChange({ width: Number(e.target.value) })}
        />
        <span className="meta">{prefs.width}%</span>
      </label>
      <div className="manga-reader-settings-foot">
        <button
          className="btn subtle"
          disabled={prefs.brightness === DEFAULT_PREFS.brightness && prefs.width === DEFAULT_PREFS.width}
          onClick={() => onChange({ brightness: DEFAULT_PREFS.brightness, width: DEFAULT_PREFS.width })}
        >
          Reset
        </button>
        <button className="btn subtle manga-reader-more" onClick={() => setPanel('more')}>
          <Icon.more /> More
        </button>
      </div>
    </div>
  );
}

function HideChoice({
  title,
  value,
  onPick,
}: {
  title: string;
  value: number | null;
  onPick: (ms: number | null) => void;
}) {
  return (
    <div className="manga-reader-hide" role="group" aria-label={title}>
      <span className="meta">{title}</span>
      <div className="manga-reader-choices">
        {HIDE_CHOICES.map((choice) => (
          <button
            key={choice.label}
            className="btn"
            aria-pressed={choice.ms === value}
            onClick={() => onPick(choice.ms)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
