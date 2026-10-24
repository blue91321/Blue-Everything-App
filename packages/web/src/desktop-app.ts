/**
 * Where the desktop client is downloaded from: the latest release's page,
 * which carries `BlueEverything-Desktop-<version>.zip` beside the full app
 * (`scripts/package-desktop.mjs`).
 *
 * The desktop client is the agent on its own, for a PC that does not run the
 * server: the tray icon, popups above games, noticing a match end, and voice.
 * Linked from wherever the app needs more of a PC than a browser can reach.
 */
export const DESKTOP_APP_URL = 'https://github.com/blue91321/Blue-Everything-App/releases/latest';
