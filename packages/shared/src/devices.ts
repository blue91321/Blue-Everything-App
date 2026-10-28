/**
 * Devices: what can be paired, and what a guest copy's key is.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

/**
 * `instance` is not a device: it is the key a guest copy of the server holds
 * to ask the host's Suwayomi for things (plan A). Only the host mints one, for
 * a copy it finds in `instances/`, so it is left out of what a person can pair.
 */
export const deviceKinds = ['windows-agent', 'phone', 'browser', 'extension', 'instance'] as const;
export const deviceKindSchema = z.enum(deviceKinds);

export const pairableDeviceKinds = ['windows-agent', 'phone', 'browser', 'extension'] as const;

export const registerDeviceSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(pairableDeviceKinds),
});
