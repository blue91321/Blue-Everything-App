/**
 * The settings row, and the one decision about whether it is quiet now.
 */
import { z } from 'zod';
import { MAX_VOICE_FOLLOW_UP_SECONDS, overlayPlacementSchema, wakeAlikesSchema, wakeDecoysSchema, wakeWordSchema } from './voice.js';
import { isGlobalHotkey } from './voice-commands.js';

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const minuteOfDay = z.number().int().min(0).max(24 * 60 - 1);

/**
 * How the app looks.
 *
 * `dark` is the default rather than `system`: this thing is looked at in a dim
 * room next to a game, and following Windows would mean a white screen every
 * time the OS decided it was daytime. `system` is offered for anyone who wants
 * it, but it is a choice rather than the assumption.
 */
export const APP_THEMES = ['dark', 'light', 'system'] as const;
export type AppTheme = (typeof APP_THEMES)[number];
export const DEFAULT_THEME: AppTheme = 'dark';

/**
 * The accent, by name rather than by hex.
 *
 * A free colour picker would need `--accent-text` derived from luminance at
 * runtime to keep labels legible on top of it, and would happily let you pick
 * something unreadable. A short list pairs each accent with a foreground that
 * has been looked at, in both themes, which is the part that actually matters.
 *
 * The names live here because the server validates them; the hex values live
 * in the PWA's stylesheet, because CSS is a better place to keep colours than
 * a TypeScript constant the browser then has to apply by hand.
 */
export const ACCENT_COLORS = ['blue', 'amber', 'green', 'teal', 'purple', 'pink', 'red', 'grey'] as const;
export type AccentColor = (typeof ACCENT_COLORS)[number];
export const DEFAULT_ACCENT: AccentColor = 'blue';

/**
 * The accent as the *icon renderer* needs it, since a PNG cannot read a CSS
 * variable.
 *
 * These are the dark-theme values, and app icons use them whatever the theme
 * is: a home-screen icon sits on the OS's wallpaper, not on our background, and
 * has no idea whether the app inside is currently light.
 *
 * **This table and the `[data-accent=…]` rules in `styles.css` must agree.**
 * They cannot be shared — the PWA deliberately does not import this package,
 * and CSS cannot import TypeScript — so `make-icons.mjs` reads both and fails
 * the build if they drift. A logo that is a different blue from the app it
 * belongs to is exactly the sort of thing nobody notices for months.
 */
export const ACCENT_HEX: Record<AccentColor, string> = {
  blue: '#4c8dff',
  amber: '#ffb454',
  green: '#5fd18c',
  teal: '#3fc9c2',
  purple: '#a78bfa',
  pink: '#f472b6',
  red: '#ff7a7a',
  grey: '#9aa3b8',
};

/** The background every generated icon is drawn on. Matches the dark `--bg`. */
export const ICON_BACKGROUND = '#14161c';

/**
 * The mark itself.
 *
 * `pause` is the original and still the default — the app's whole idea is
 * holding something back until the moment is right, and the glyph says so.
 * The rest are there because it is your app and you should be able to make it
 * look like your.
 *
 * `image` means "use the file that was uploaded". It is a shape like the others
 * rather than a separate boolean, because the two are genuinely exclusive and a
 * `useCustomLogo` flag alongside a shape would allow the nonsense state of a
 * custom logo *and* a triangle.
 */
export const LOGO_SHAPES = ['pause', 'circle', 'triangle', 'square', 'image'] as const;
export type LogoShape = (typeof LOGO_SHAPES)[number];
export const DEFAULT_LOGO_SHAPE: LogoShape = 'pause';

export const LOGO_SHAPE_LABELS: Record<LogoShape, string> = {
  pause: 'Pause',
  circle: 'Circle',
  triangle: 'Triangle',
  square: 'Square',
  image: 'My own picture',
};

export const updateSettingsSchema = z.object({
  /** Dark unless asked otherwise — see APP_THEMES. */
  theme: z.enum(APP_THEMES).optional(),
  accentColor: z.enum(ACCENT_COLORS).optional(),
  /**
   * Setting this to `image` with nothing uploaded is refused by the route
   * rather than the schema — the schema cannot see the filesystem, and a logo
   * silently falling back to a pause glyph would look like the upload failed.
   */
  logoShape: z.enum(LOGO_SHAPES).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietStartMinute: minuteOfDay.optional(),
  quietEndMinute: minuteOfDay.optional(),
  followWindowsDnd: z.boolean().optional(),
  /** Absolute time; null clears the manual pause. */
  dndUntil: z.number().int().nullish(),
  remindersEnabled: z.boolean().optional(),
  /** A short tone with each popup. On by default; see the schema. */
  soundEnabled: z.boolean().optional(),
  /** How loud the app's tones are, 0 to 100. */
  soundVolume: z.number().int().min(0).max(100).optional(),
  /*
   * Which tone each moment gets, by name. Validated as a bounded string rather
   * than an enum of tone names: the palette lives in the agent, which is the
   * only thing that can make a noise, and teaching the server the list would be
   * a second copy to keep in step for no gain. An unknown name falls back to
   * the default at the one place that can tell — see `setTones`.
   */
  soundWake: z.string().max(30).optional(),
  soundOk: z.string().max(30).optional(),
  soundMiss: z.string().max(30).optional(),
  soundNudge: z.string().max(30).optional(),
  pushEnabled: z.boolean().optional(),
  /** What a task or habit that hasn't chosen gets. Not the master switch. */
  pushDefault: z.boolean().optional(),
  voiceEnabled: z.boolean().optional(),
  wakeWord: wakeWordSchema.optional(),
  wakeDecoys: wakeDecoysSchema.optional(),
  wakeAlikes: wakeAlikesSchema.optional(),
  requireKnownSpeaker: z.boolean().optional(),
  speakerThreshold: z.number().min(0).max(1).optional(),
  /**
   * Stored as the device *name*, not its index. Windows renumbers inputs when
   * something is plugged in or removed, so an index saved today can silently
   * mean a different microphone tomorrow. Null follows the Windows default.
   */
  voiceInputDevice: z.string().max(200).nullish(),
  /** Seconds to keep listening after answering. 0 switches follow-ups off. */
  voiceFollowUpSeconds: z.number().int().min(0).max(MAX_VOICE_FOLLOW_UP_SECONDS).optional(),
  /** Seconds to keep listening after a miss. 0 means don't wait for a retry. */
  voiceRetrySeconds: z.number().int().min(0).max(MAX_VOICE_FOLLOW_UP_SECONDS).optional(),
  voiceRetryMatchesFollowUp: z.boolean().optional(),
  /*
   * Empty string clears; a combination is validated by the same `parseHotkey` a
   * `hotkey` voice command uses. Nullable so "unset" survives a round trip as
   * itself rather than as the empty string, which the PWA would render in the
   * box as though something had been typed there.
   */
  voiceToggleHotkey: z
    .string()
    .max(60)
    .refine((v) => v === '' || isGlobalHotkey(v), 'needs a key combination with at least one modifier')
    .nullish(),
  voiceListenHotkey: z
    .string()
    .max(60)
    .refine((v) => v === '' || isGlobalHotkey(v), 'needs a key combination with at least one modifier')
    .nullish(),
  voiceListenHotkeyWhileOff: z.boolean().optional(),
  /*
   * Capped at an hour, floored at ten seconds. Below ten this stops being a
   * refresh and becomes a poll, against a project that tuned its attention loop
   * down to ~1,500 rows a day; above an hour it is indistinguishable from off.
   */
  dashboardRefreshSeconds: z.number().int().min(0).max(3600).optional(),
  /*
   * Bounded 600–2400. Below 600 no phone would ever dock the menu, which is the
   * setting doing nothing; above 2400 no monitor would, which is the setting
   * doing nothing in the other direction. Both ends are "off" wearing a number.
   */
  drawerBreakpoint: z.number().int().min(600).max(2400).optional(),
  drawerDocked: z.boolean().optional(),
  gameDetectionEnabled: z.boolean().optional(),
  interruptDuringGames: z.boolean().optional(),
  overlayPlacement: overlayPlacementSchema.optional(),
  /** Device name of the screen to anchor to; null follows the mouse. */
  overlayScreen: z.string().max(200).nullish(),
  /** An emoji, `file` for the uploaded one, or empty for no avatar. */
  overlayAvatar: z.string().max(80).optional(),
  /**
   * Services to leave out of the friends list.
   *
   * **Plain slugs, deliberately not validated against the provider ids.** Those
   * live in the integrations feature, which is deletable, and core validating
   * against them would be core depending on a feature. An id that no longer
   * exists simply matches nobody — which is also the right behaviour when a
   * provider is dropped: the setting goes quiet rather than failing to save.
   */
  hiddenProviders: z.array(z.string().max(40)).max(20).optional(),
  /**
   * Which panel the Dashboard shows alongside its own columns. Empty for none.
   *
   * Opaque, and validated only for length — same reasoning as the slugs above.
   * The panels worth having come from features, and a core schema listing their
   * ids would be core depending on a folder that can be deleted.
   */
  dashboardPanel: z.string().max(64).optional(),
  /**
   * What the side column holds, in the order they are drawn.
   *
   * Shape only — the ids come from features that can be deleted, so core
   * validates the length and the count and never the values, exactly as it does
   * for `hiddenProviders`. Capped because a column is a column: past a handful
   * you are scrolling a sidebar to read a sidebar.
   */
  dashboardPanels: z.array(z.string().max(64)).max(8).optional(),
  /*
   * Longer than the panel list because it holds the core sections too — seven
   * of those before a single package has contributed anything. Still bounded:
   * this is a Dashboard, not a page builder.
   */
  dashboardBlocks: z.array(z.string().max(64)).max(24).optional(),
  /**
   * Whether the live panel shows everyone or only the starred ones.
   *
   * A real enum rather than an opaque string, unlike `dashboardPanel` — the
   * values are core's own and there are two of them, so validating costs nothing
   * and an unknown one would silently mean "all".
   */
  livePanelScope: z.enum(['all', 'favourites']).optional(),
});

/**
 * Is `at` inside the quiet window?
 *
 * Start > end wraps past midnight, which is the normal case for sleep. Whether
 * quiet hours apply at all is a separate flag — don't infer it from the times.
 */
export function isQuietHour(at: Date, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return false;
  const minute = at.getHours() * 60 + at.getMinutes();
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/** Why reminders are currently silent, or null if they aren't. */
export type QuietReason = 'reminders-off' | 'paused' | 'quiet-hours' | 'windows-dnd';

export interface QuietInputs {
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  followWindowsDnd: boolean;
  dndUntil: number | null;
  remindersEnabled: boolean;
  windowsDnd?: boolean;
}

/**
 * One place that decides whether anything is allowed to interrupt, so the
 * server, the phone and the settings screen can never disagree about why it's
 * gone quiet.
 */
export function quietReason(at: Date, input: QuietInputs): QuietReason | null {
  if (!input.remindersEnabled) return 'reminders-off';
  if (input.dndUntil && input.dndUntil > at.getTime()) return 'paused';
  if (input.quietHoursEnabled && isQuietHour(at, input.quietStartMinute, input.quietEndMinute)) return 'quiet-hours';
  if (input.followWindowsDnd && input.windowsDnd) return 'windows-dnd';
  return null;
}
