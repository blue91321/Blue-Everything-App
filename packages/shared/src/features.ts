/**
 * Which parts of the app exist, and what each one costs.
 *
 * This is the single list the server, the agent and the setup script all read,
 * so they cannot disagree about what "voice is off" means. The PWA is the one
 * exception — it does not import this package (see CLAUDE.md on why zod must
 * not reach that bundle), so the server hands it a plain `string[]` of enabled
 * ids on `/api/session`.
 *
 * Deliberately dependency-free: no zod, no imports at all. `npm run features`
 * runs on a fresh clone before `npm install`, and the manifest is a list of
 * facts rather than untrusted input needing validation.
 */

export const FEATURE_IDS = ['vault', 'voice', 'push', 'integrations', 'habits', 'notes', 'time'] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

export interface FeatureSpec {
  id: FeatureId;
  label: string;
  /** One line, shown by `npm run features` and on the Settings screen. */
  blurb: string;
  /**
   * On when `features.json` is absent. These match what the app did before it
   * had feature switches, so an existing install behaves identically until
   * somebody actually chooses otherwise.
   */
  defaultEnabled: boolean;
  /**
   * Whether the feature's folders can be deleted from disk outright, as opposed
   * to merely switched off.
   *
   * Honest rather than aspirational. `habits` and `notes` are woven into the
   * Dashboard — the one screen that is the point of the app — so they switch
   * off cleanly but cannot be removed without leaving a hole there. Claiming
   * otherwise would send someone deleting a folder and into a broken build.
   */
  removable: boolean;
  /** Folders that belong to this feature and nothing else. Safe to delete. */
  owns: string[];
  /** What turning it on actually costs, measured. Empty when it is negligible. */
  cost?: string;
  /** Must be on for this one to work. */
  requires?: FeatureId[];
  /**
   * Its own version, for a feature that does **not** ship with the app.
   *
   * Absent is the honest answer for everything here today: they all come out of
   * this repo, in one commit, and the five workspace packages deliberately
   * share one number — see the Versions section in CLAUDE.md. A feature with no
   * `version` reports the app's, and the Packages screen says it moves with the
   * app rather than showing a number that looks independent and is not.
   *
   * It exists for the case being built toward: a feature downloaded separately,
   * which genuinely can be a different version from the app around it. Adding
   * that field then is a one-line change here rather than a new concept.
   */
  version?: string;
}

export const FEATURES: Record<FeatureId, FeatureSpec> = {
  vault: {
    id: 'vault',
    label: 'Password vault',
    blurb: 'Encrypted password storage, CSV import, and the browser extension that fills them.',
    defaultEnabled: true,
    removable: true,
    owns: [
      'packages/server/src/features/vault',
      'packages/web/src/features/vault',
      'packages/extension',
    ],
  },

  voice: {
    id: 'voice',
    label: 'Voice commands',
    blurb: 'Wake word, spoken commands, and the popup at the cursor.',
    defaultEnabled: true,
    removable: true,
    owns: [
      'packages/server/src/features/voice',
      'packages/web/src/features/voice',
      'packages/agent/src/features/voice',
    ],
    // The one feature that breaks the leanness budget, so the number is stated
    // where the switch is rather than buried in a document.
    cost: '~150MB of models on disk, and 198MB resident in the agent while the microphone is open',
  },

  push: {
    id: 'push',
    label: 'Phone notifications',
    blurb: 'Web push to an installed PWA when you are away from the PC.',
    defaultEnabled: true,
    removable: true,
    owns: ['packages/server/src/features/push'],
    cost: 'needs VAPID_SUBJECT set to a real domain — Apple rejects localhost',
  },

  integrations: {
    id: 'integrations',
    label: 'App integrations',
    blurb:
      'Canvas coursework as tasks, Spotify and YouTube libraries, and which of your friends are ' +
      'online on Steam, Discord and Riot.',
    // Off until somebody asks for it. Every other feature here works the moment
    // it is switched on; this one does nothing at all until you have registered
    // an app with a third party and pasted an id into the environment, so
    // defaulting it on would put a tab in the drawer that can only apologise.
    defaultEnabled: false,
    removable: true,
    owns: [
      'packages/server/src/features/integrations',
      'packages/web/src/features/integrations',
      'packages/agent/src/features/integrations',
    ],
    cost: 'one HTTP request per provider when the friends list is on screen; nothing at all when it is not',
  },

  habits: {
    id: 'habits',
    label: 'Habits',
    blurb: 'Recurring things to tick off, with optional reminders.',
    defaultEnabled: true,
    // The Dashboard renders habits inline. Switching them off hides the section
    // and skips the fetch; deleting the folder would leave that screen broken.
    removable: false,
    owns: [],
  },

  notes: {
    id: 'notes',
    label: 'Notes',
    blurb: 'Plain text jottings, and where a spoken `note` command lands.',
    defaultEnabled: true,
    removable: false,
    owns: [],
  },

  time: {
    id: 'time',
    label: 'Time tracking',
    blurb: 'Start and stop timers against a task.',
    defaultEnabled: true,
    removable: false,
    owns: [],
  },
};

export const FEATURE_LIST: FeatureSpec[] = FEATURE_IDS.map((id) => FEATURES[id]);

export function isFeatureId(value: string): value is FeatureId {
  return (FEATURE_IDS as readonly string[]).includes(value);
}

export interface ResolvedFeatures {
  enabled: Set<FeatureId>;
  /** Things worth saying out loud but not worth refusing to start over. */
  notes: string[];
}

/**
 * Turn a requested set into an enabled set.
 *
 * Unknown ids are reported rather than ignored — a typo in `features.json`
 * silently disabling something is exactly the kind of quiet failure this whole
 * exercise is meant to remove. Dependencies are pulled in rather than treated
 * as an error, because refusing to boot over an implied dependency helps
 * nobody.
 */
export function resolveFeatures(requested: Partial<Record<string, boolean>> | undefined): ResolvedFeatures {
  const notes: string[] = [];
  const enabled = new Set<FeatureId>();

  for (const spec of FEATURE_LIST) {
    const asked = requested?.[spec.id];
    if (asked ?? spec.defaultEnabled) enabled.add(spec.id);
  }

  for (const key of Object.keys(requested ?? {})) {
    if (!isFeatureId(key)) notes.push(`features.json mentions "${key}", which is not a feature — ignored`);
  }

  // One pass is enough: the graph is one level deep and checked by `features`
  // below, so there is nothing to iterate toward.
  for (const id of [...enabled]) {
    for (const need of FEATURES[id].requires ?? []) {
      if (!enabled.has(need)) {
        enabled.add(need);
        notes.push(`${FEATURES[id].label} needs ${FEATURES[need].label}, so that was switched on too`);
      }
    }
  }

  return { enabled, notes };
}
