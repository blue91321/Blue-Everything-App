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
  | { supported: false; reason: string };

/**
 * iOS only exposes push to an installed app, so a page that looks fine in
 * Safari still can't subscribe. `standalone` is how it reports being launched
 * from the Home Screen.
 */
export function checkPushSupport(): PushSupport {
  if (!('serviceWorker' in navigator)) return { supported: false, reason: 'This browser has no service worker support.' };
  if (!('PushManager' in window)) return { supported: false, reason: 'This browser cannot receive push notifications.' };
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: 'Needs a secure (https) address. On the phone, use the Tailscale https URL.',
    };
  }

  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const installed =
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  if (iOS && !installed) {
    return {
      supported: false,
      reason: 'On iPhone, add this to your Home Screen first — Safari can only deliver notifications to an installed app.',
    };
  }

  return { supported: true };
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
