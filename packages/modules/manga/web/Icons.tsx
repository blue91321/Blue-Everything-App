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
};
