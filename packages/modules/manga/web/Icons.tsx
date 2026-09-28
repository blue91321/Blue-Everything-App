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
};
