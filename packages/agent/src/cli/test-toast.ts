/**
 * Prove a toast actually reaches the screen, and time what it costs.
 *
 *   npm run toast -w @everything/agent
 */
import { showToast } from '../notify.js';

const started = Date.now();
const shown = await showToast({
  title: 'Everything App',
  body: 'If you can see this, nudges will reach you. Buy milk & <eggs>',
  tag: 'test',
});

console.log(shown ? `toast shown in ${Date.now() - started}ms` : 'toast FAILED');
process.exit(shown ? 0 : 1);
