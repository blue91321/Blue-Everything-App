/**
 * Nudges: a reminder held until a good moment.
 */
import { z } from 'zod';
import { nudgeQualitySchema } from './attention.js';

/* ------------------------------------------------------------------ */
/* Nudges                                                              */
/* ------------------------------------------------------------------ */

export const nudgeStates = ['pending', 'delivered', 'acknowledged', 'snoozed', 'dismissed', 'expired'] as const;
export const nudgeStateSchema = z.enum(nudgeStates);

export const createNudgeSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(2000).nullish(),
  taskId: z.string().uuid().nullish(),
  habitId: z.string().uuid().nullish(),
  /** Don't even consider delivering before this. Defaults to now. */
  earliestAt: z.number().int().optional(),
  /**
   * Past this, the nudge stops being polite and interrupts anyway — except
   * when you are away from the machine, where a toast would just be missed.
   */
  deadlineAt: z.number().int().nullish(),
  /** Drop it unfired after this. Recurring reminders set it; one-offs don't. */
  expiresAt: z.number().int().nullish(),
  minQuality: nudgeQualitySchema.default('decent'),
});

export const snoozeNudgeSchema = z.object({ minutes: z.number().int().positive().max(60 * 24) });
