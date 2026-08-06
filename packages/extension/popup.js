/**
 * Everything Vault — the whole extension.
 *
 * There is deliberately no background worker and no content script. The
 * extension does nothing at all until its icon is clicked: no listener runs on
 * every page, nothing is injected into sites you visit, and there is no
 * long-lived process holding a token. `activeTab` plus `scripting` means the
 * fill code is injected into one tab, once, on an explicit click.
 *
 * All network calls happen here, in the popup, which is an extension page —
 * host_permissions covers it and no CORS preflight is involved.
 */

const el = (id) => document.getElementById(id);
const screens = ['loading', 'pair', 'offline', 'locked', 'vault'];
const show = (name) => screens.forEach((s) => (el(s).hidden = s !== name));

/** Token and server address live in extension storage, never in a page. */
async function config() {
  const stored = await chrome.storage.local.get(['serverUrl', 'token']);
  return { serverUrl: stored.serverUrl ?? 'http://127.0.0.1:8787', token: stored.token ?? '' };
}

class Unauthorized extends Error {}
class Offline extends Error {}

async function api(path, options = {}) {
  const { serverUrl, token } = await config();
  let response;
  try {
    response = await fetch(`${serverUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
  } catch (cause) {
    throw new Offline(cause.message);
  }

  if (response.status === 401) throw new Unauthorized('the code was rejected');
  if (response.status === 423) return { locked: true };
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

/* ------------------------------------------------------------------ */
/* Filling                                                             */
/* ------------------------------------------------------------------ */

/**
 * Injected into the page. Must be entirely self-contained — it is serialised
 * and evaluated in a different world, so it can close over nothing.
 */
function fillCredentials(username, password) {
  const isVisible = (node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  };

  // React and friends track value on the DOM node, so assigning `.value`
  // directly is silently reverted on the next render. Going through the
  // prototype setter and dispatching input is what makes frameworks notice.
  const setValue = (node, value) => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const passwordField = [...document.querySelectorAll('input[type="password"]')].find(isVisible);
  if (!passwordField) return { ok: false, reason: 'no password box on this page' };

  // The username box is whichever text-ish input sits before the password one,
  // preferring the same form. Ordering beats guessing at names, which differ
  // wildly between sites.
  const scope = passwordField.form ?? document;
  const candidates = [...scope.querySelectorAll('input')].filter(
    (node) => ['text', 'email', 'tel', ''].includes(node.type) && isVisible(node)
  );
  const before = candidates.filter(
    (node) => passwordField.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING
  );
  const usernameField = before[before.length - 1] ?? candidates[0] ?? null;

  if (usernameField && username) setValue(usernameField, username);
  setValue(passwordField, password);
  passwordField.focus();

  return { ok: true, filledUsername: Boolean(usernameField && username) };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

async function start() {
  const { token } = await config();
  if (!token) return show('pair');

  try {
    const status = await api('/api/vault/status');
    if (!status.configured) {
      el('offline-detail').textContent = 'No vault has been set up yet. Create one in the app first.';
      return show('offline');
    }
    if (!status.unlocked) return show('locked');
    return openVault();
  } catch (error) {
    if (error instanceof Unauthorized) {
      el('pair-error').textContent = 'That code is no longer valid. Create a new one in the app.';
      el('pair-error').hidden = false;
      return show('pair');
    }
    el('offline-detail').textContent = String(error.message ?? error);
    return show('offline');
  }
}

async function openVault() {
  show('vault');

  const tab = await activeTab();
  const pageUrl = tab?.url ?? '';

  const [all, matches] = await Promise.all([
    api('/api/vault/items'),
    pageUrl.startsWith('http') ? api(`/api/vault/match?url=${encodeURIComponent(pageUrl)}`) : Promise.resolve([]),
  ]);

  if (all?.locked || matches?.locked) return show('locked');

  const matchIds = new Set((matches ?? []).map((item) => item.id));
  let hostLabel = '';
  try {
    hostLabel = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    hostLabel = '';
  }

  el('context').textContent = hostLabel
    ? matchIds.size
      ? `${matchIds.size} saved for ${hostLabel}`
      : `Nothing saved for ${hostLabel}`
    : '';

  const render = (query) => {
    const needle = query.trim().toLowerCase();
    const visible = (all ?? [])
      .filter((item) =>
        !needle ? true : [item.title, item.username, item.url].some((f) => (f ?? '').toLowerCase().includes(needle))
      )
      // Matches for this page first; that is nearly always the one wanted.
      .sort((a, b) => Number(matchIds.has(b.id)) - Number(matchIds.has(a.id)));

    const list = el('results');
    list.textContent = '';
    el('empty').hidden = visible.length > 0;

    for (const item of visible) {
      const row = document.createElement('li');
      if (matchIds.has(item.id)) row.className = 'match';

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = item.title;

      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = item.username || item.url || '';

      const actions = document.createElement('div');
      actions.className = 'actions';

      const fillButton = document.createElement('button');
      fillButton.textContent = 'Fill';
      fillButton.addEventListener('click', () => fillFrom(item));

      const copyButton = document.createElement('button');
      copyButton.textContent = 'Copy password';
      copyButton.addEventListener('click', () => copyFrom(item));

      actions.append(fillButton, copyButton);
      row.append(title, sub, actions);
      list.append(row);
    }
  };

  el('search').oninput = (event) => render(event.target.value);
  render('');
}

function note(text) {
  const status = el('status');
  status.textContent = text;
  status.hidden = false;
}

async function fillFrom(item) {
  const tab = await activeTab();
  if (!tab?.id) return note('no page to fill');

  const secret = await api(`/api/vault/items/${item.id}/secret`);
  if (secret?.locked) return show('locked');

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fillCredentials,
    args: [item.username ?? '', secret.password ?? ''],
  });

  const outcome = result?.result;
  if (!outcome?.ok) return note(outcome?.reason ?? 'could not fill');
  note(outcome.filledUsername ? 'Filled.' : 'Filled the password.');
  // Close so the popup isn't left sitting there holding a secret in memory.
  setTimeout(() => window.close(), 600);
}

async function copyFrom(item) {
  const secret = await api(`/api/vault/items/${item.id}/secret`);
  if (secret?.locked) return show('locked');
  await navigator.clipboard.writeText(secret.password ?? '');
  note('Password copied.');
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

el('pair-submit').addEventListener('click', async () => {
  const serverUrl = el('pair-url').value.trim().replace(/\/$/, '');
  const token = el('pair-token').value.trim();
  el('pair-error').hidden = true;

  await chrome.storage.local.set({ serverUrl, token });
  try {
    const status = await api('/api/vault/status');
    if (status?.configured === undefined) throw new Error('unexpected reply from the server');
    el('pair-token').value = '';
    start();
  } catch (error) {
    await chrome.storage.local.remove('token');
    el('pair-error').textContent =
      error instanceof Unauthorized ? 'That code was not accepted.' : `Could not reach ${serverUrl}`;
    el('pair-error').hidden = false;
  }
});

el('unlock-submit').addEventListener('click', async () => {
  const password = el('unlock-password').value;
  el('unlock-error').hidden = true;
  el('unlock-submit').textContent = 'Unlocking…';
  el('unlock-submit').disabled = true;

  try {
    await api('/api/vault/unlock', { method: 'POST', body: JSON.stringify({ masterPassword: password }) });
    el('unlock-password').value = '';
    openVault();
  } catch (error) {
    el('unlock-error').textContent = error instanceof Unauthorized ? 'Wrong password.' : String(error.message);
    el('unlock-error').hidden = false;
  } finally {
    el('unlock-submit').textContent = 'Unlock';
    el('unlock-submit').disabled = false;
  }
});

el('unlock-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('unlock-submit').click();
});

el('lock').addEventListener('click', async () => {
  await api('/api/vault/lock', { method: 'POST', body: '{}' });
  show('locked');
});

el('offline-retry').addEventListener('click', start);

start();
