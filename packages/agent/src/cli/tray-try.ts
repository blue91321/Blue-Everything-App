/**
 * Prove the tray icon reaches the notification area.
 *
 *   npm run tray-try -w @everything/agent
 *
 * Same idea as `overlay-try`: the Win32 layer either works or fails in ways
 * that are invisible from the outside, and running the whole agent to find out
 * is a slow way to check. `Shell_NotifyIconW` in particular does not throw when
 * the struct is wrong — it returns FALSE, and the icon simply never appears.
 *
 * Deliberately does *not* stop or restart anything. The menu items are wired to
 * a harmless log line here, so you can open the menu, read it, and click things
 * without the agent you are testing from being killed underneath you.
 */
import { createTray } from '../tray.js';

const SECONDS = Number(process.argv[2]) || 30;

console.log('Look in the notification area — under the ^ arrow if it is hidden.');
console.log('Left-click opens the app; right-click shows the menu.');
console.log(`Taking it down again in ${SECONDS}s.\n`);

const tray = createTray({
  tooltip: 'Blue Everything (tray-try)',
  onOpen: () => console.log('clicked: would open the app'),
});

setTimeout(() => {
  tray.destroy();
  console.log('gone.');
  process.exit(0);
}, SECONDS * 1000);
