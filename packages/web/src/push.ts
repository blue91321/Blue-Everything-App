import { api } from './api';

/**
 * Turning on phone notifications.
 *
 * The awkward parts are all iOS's: notifications only work from a Home Screen
 * install, permission can only be asked from a real tap, and the whole thing
 * requires a secure context.
 */

/**
 * VAPID keys arrive base64url; PushManager wants raw bytes.
 *
 * Typed as ArrayBuffer rather than Uint8Array because the DOM types insist the
 * buffer cannot be a SharedArrayBuffer, which a plain Uint8Array doesn't prove.
 */
function decodeKey(base64Url: string): ArrayBuffer {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export type PushSupport =
  | { supported: true }
  | { supported: false; reason: string; fix?: string };

export const isInstalled = (): boolean =>
  (navigator as { standalone?: boolean }).standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

/**
 * Why this device can or can't receive push.
 *
 * Order matters. iOS removes `navigator.serviceWorker` *entirely* on an
 * insecure page, so testing for the API first blames the browser for what is
 * actually the address — which sends you debugging Safari instead of fixing
 * the URL. Secure context is therefore checked first, always.
 */
export function checkPushSupport(): PushSupport {
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: `This page is open on ${location.origin}, which isn't a secure address.`,
      fix: isInstalled()
        ? 'This Home Screen icon was saved from the old address. Delete it, open the https:// Tailscale address in Safari, and add it again.'
        : 'Open the https:// Tailscale address instead.',
    };
  }

  if (!('serviceWorker' in navigator)) {
    return { supported: false, reason: 'This browser has no service worker support.' };
  }
  if (!('PushManager' in window)) {
    return { supported: false, reason: 'This browser cannot receive push notifications.' };
  }
  if (!('Notification' in window)) {
    return {
      supported: false,
      reason: 'Notifications are unavailable here.',
      fix: 'On iPhone this usually means the app was opened in Safari rather than from the Home Screen icon.',
    };
  }

  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
  if (iOS && !isInstalled()) {
    return {
      supported: false,
      reason: 'Safari itself cannot receive these notifications.',
      fix: 'Tap Share, then "Add to Home Screen", and open the app from that icon.',
    };
  }

  return { supported: true };
}

export interface PushDiagnostics {
  origin: string;
  secure: boolean;
  installed: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  permission: string;
  subscribed: boolean;
}

/** Everything needed to work out why push isn't available, on the phone itself. */
export async function pushDiagnostics(): Promise<PushDiagnostics> {
  let subscribed = false;
  try {
    subscribed = Boolean(await currentSubscription());
  } catch {
    // Registration unavailable — reported by the other fields.
  }

  return {
    origin: location.origin,
    secure: window.isSecureContext,
    installed: isInstalled(),
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    permission: 'Notification' in window ? Notification.permission : 'unavailable',
    subscribed,
  };
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export interface EnableResult {
  ok: boolean;
  message: string;
}

export async function enablePush(vapidPublicKey: string): Promise<EnableResult> {
  const support = checkPushSupport();
  if (!support.supported) return { ok: false, message: support.reason };
  if (!vapidPublicKey) return { ok: false, message: 'The server has not produced a push key yet.' };

  // Must be called from a user gesture; iOS silently denies otherwise.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, message: 'Notifications were not allowed. You can change that in your phone settings.' };
  }

  const registration = await navigator.serviceWorker.ready;

  // Reuse an existing subscription rather than creating a second one; the
  // browser refuses a new one with a different key anyway.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true, // required, and honest: every push shows something
      applicationServerKey: decodeKey(vapidPublicKey),
    }));

  await api.push.subscribe(subscription.toJSON());
  return { ok: true, message: 'This device will now get nudges when you are away from the PC.' };
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  await subscription?.unsubscribe();
  // Clear the server's copy too, or it keeps pushing into the void.
  await api.push.subscribe(null);
}
