import type { FeatureMeta } from '../index';

/**
 * Its own tab rather than a section of Settings: it is the one feature that
 * holds a microphone open, so the switch that turns it off should never be
 * something you have to go looking for.
 */
export const meta: FeatureMeta = { id: 'voice', label: 'Voice', glyph: '🎙', order: 60 };
