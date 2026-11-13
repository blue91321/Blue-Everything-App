/**
 * The manga screen's icons, drawn rather than typed.
 *
 * A tab bar of symbols has to look the same on the phone and the PC, and take
 * the accent when chosen. Unicode does neither reliably: the arrows and clocks
 * are in whatever font a device happens to have, and iOS draws several of them
 * as colour emoji, which ignore `color` entirely. Six strokes each in SVG, with
 * `currentColor`, is the same call `Logo.tsx` makes about the app's mark.
 */
const base = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export const Icon = {
  search: () => (
    <svg {...base}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </svg>
  ),
  browse: () => (
    <svg {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </svg>
  ),
  library: () => (
    <svg {...base}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  ),
  history: () => (
    <svg {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  downloads: () => (
    <svg {...base}>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  ),
  more: () => (
    <svg {...base} fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  ),
  sort: () => (
    <svg {...base} width={18} height={18}>
      <path d="M4 7h16M7 12h10M10 17h4" />
    </svg>
  ),
  /** A funnel: what Browse is leaving out. */
  filter: () => (
    <svg {...base} width={18} height={18}>
      <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
    </svg>
  ),
  /**
   * A cog: a thick dashed ring is the teeth, a thin one the wheel. The teeth
   * need square ends — with the round caps every other icon here uses, each
   * dash grows by half its width at both ends and the gaps close into a ring.
   */
  gear: () => (
    <svg {...base} width={24} height={24}>
      <circle cx="12" cy="12" r="8.5" strokeWidth={3.2} strokeDasharray="3.6 3.07" strokeLinecap="butt" />
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  ),
  sun: () => (
    <svg {...base}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  ),
  zoom: () => (
    <svg {...base}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-4.8-4.8M7.5 10.5h6" />
    </svg>
  ),
  previous: () => (
    <svg {...base} width={28} height={28} strokeWidth={1.8}>
      <path d="M15 4l-8 8 8 8" />
    </svg>
  ),
  next: () => (
    <svg {...base} width={28} height={28} strokeWidth={1.8}>
      <path d="M9 4l8 8-8 8" />
    </svg>
  ),

  /*
   * The reader's gear, drawn so most of it reads without words: a tall strip
   * for Scroll, an open book for Pages, one page or two, which way to read.
   */
  /** One tall strip, cut into slices: scroll. */
  strip: () => (
    <svg {...base}>
      <rect x="7" y="2.5" width="10" height="19" rx="1.5" />
      <path d="M7 9h10M7 15h10" />
    </svg>
  ),
  /** An open book: pages. */
  book: () => (
    <svg {...base}>
      <path d="M12 6.5C10 5 7 4.5 3 5v13c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5z" />
      <path d="M12 6.5v13" />
    </svg>
  ),
  /** The next chapter carrying on below this one. */
  carryOn: () => (
    <svg {...base}>
      <rect x="6" y="2.5" width="12" height="7" rx="1.2" />
      <rect x="6" y="14.5" width="12" height="7" rx="1.2" />
      <path d="M12 9.5v5M10 12.5l2 2 2-2" />
    </svg>
  ),
  onePage: () => (
    <svg {...base}>
      <rect x="7" y="3" width="10" height="18" rx="1.5" />
    </svg>
  ),
  twoPages: () => (
    <svg {...base}>
      <rect x="2.5" y="4" width="9" height="16" rx="1.2" />
      <rect x="12.5" y="4" width="9" height="16" rx="1.2" />
    </svg>
  ),
  /** One page or two, as the screen allows: a screen with a page and a faint second. */
  fitPages: () => (
    <svg {...base}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <rect x="6" y="7" width="5.5" height="10" rx="0.8" />
      <rect x="12.5" y="7" width="5.5" height="10" rx="0.8" strokeDasharray="2 2" />
    </svg>
  ),
  /** Reading right to left: a page with lines and an arrow pointing left. */
  readLeft: () => (
    <svg {...base}>
      <path d="M20 7H9M20 12H9M20 17H9" />
      <path d="M7 12H3M5 10l-2 2 2 2" />
    </svg>
  ),
  readRight: () => (
    <svg {...base}>
      <path d="M4 7h11M4 12h11M4 17h11" />
      <path d="M17 12h4M19 10l2 2-2 2" />
    </svg>
  ),
  /** The pairs moved along by one. */
  shiftPair: () => (
    <svg {...base}>
      <rect x="3" y="5" width="7" height="12" rx="1" />
      <rect x="10" y="5" width="7" height="12" rx="1" />
      <path d="M8 21h12M18 19l2 2-2 2" />
    </svg>
  ),
  /** The pairs moved along by one from a page on: a page alone, then the pairs after it. */
  shiftFromHere: () => (
    <svg {...base}>
      <rect x="2" y="5" width="5" height="12" rx="1" />
      <rect x="10" y="5" width="6" height="12" rx="1" />
      <rect x="16" y="5" width="6" height="12" rx="1" />
      <path d="M10 21h10M18 19l2 2-2 2" />
    </svg>
  ),
  /** Pictures as they came, smaller, smallest: a picture at three sizes. */
  pictureFull: () => (
    <svg {...base}>
      <rect x="2.5" y="4" width="19" height="16" rx="1.5" />
      <path d="M2.5 17l5.5-5.5 4 4 3-3 6 6" />
      <circle cx="16" cy="8.5" r="1.5" />
    </svg>
  ),
  pictureSmaller: () => (
    <svg {...base}>
      <rect x="5.5" y="6.5" width="13" height="11" rx="1.2" />
      <path d="M5.5 15.5l3.8-3.8 2.7 2.7 2-2 4.5 4.5" />
      <circle cx="15" cy="9.5" r="1" />
    </svg>
  ),
  pictureSmallest: () => (
    <svg {...base}>
      <rect x="8" y="8.5" width="8" height="7" rx="1" />
      <path d="M8 14l2.3-2.3 1.7 1.7 1.2-1.2 2.8 2.8" />
    </svg>
  ),
  /** Picks by itself: a wand. */
  wand: () => (
    <svg {...base}>
      <path d="M4 20L15 9" />
      <path d="M17 3v3M15.5 4.5h3M20 8v2M19 9h2M11 3.5v2M10 4.5h2" />
    </svg>
  ),
  reload: () => (
    <svg {...base}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  ),
  /** Letting go of the chapters above: a page going, dashed, over the one staying. */
  clearAbove: () => (
    <svg {...base}>
      <rect x="6" y="2.5" width="12" height="7" rx="1" strokeDasharray="2 2.2" />
      <rect x="6" y="12" width="12" height="9.5" rx="1" />
      <path d="M12 9.5v-4M10 7.5l2 2 2-2" />
    </svg>
  ),
  /** The controls hiding when a chapter opens: a book and a clock. */
  timerOpen: () => (
    <svg {...base}>
      <path d="M10 6.5C8.5 5.5 6 5 3 5.3v12c3-.3 5.5.2 7 1.2" />
      <circle cx="16.5" cy="15.5" r="5" />
      <path d="M16.5 13v2.5l1.6 1" />
    </svg>
  ),
  /** And after a tap: a finger and a clock. */
  timerTap: () => (
    <svg {...base}>
      <path d="M7 13V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M10 10.5V9a1.5 1.5 0 0 1 3 0v1.5" />
      <circle cx="17" cy="16" r="4.5" />
      <path d="M17 13.8V16l1.4.9" />
    </svg>
  ),
  /** A page with a bar down its right edge. */
  scrollbar: () => (
    <svg {...base}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M16 3v18" />
      <path d="M18 7v4" strokeWidth={2.6} />
    </svg>
  ),
  /** A hand, for dragging the page. */
  hand: () => (
    <svg {...base}>
      <path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v6.5c0 4-2.5 7.5-6.5 7.5-2.5 0-4-1.2-5.2-3L3.6 13.6a1.4 1.4 0 0 1 2.2-1.7L8 14" />
    </svg>
  ),
};
