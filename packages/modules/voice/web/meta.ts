import type { FeatureMeta } from '@app/features/index';

/*
 * Under Command in the menu, with Blueprints and Code. Written out in each of the
 * three, since a package may not import another: see `menu-groups.ts` in core.
 * The glyph is drawn by core (`Glyph.tsx`): a command block.
 */
const COMMAND = { id: 'command', label: 'Command', glyph: 'icon:command' };

/**
 * Its own tab rather than a section of Settings: it is the one feature that
 * holds a microphone open, so the switch that turns it off should never be
 * something you have to go looking for.
 */
export const meta: FeatureMeta = { id: 'voice', label: 'Voice', glyph: '🎙', order: 60, group: COMMAND };
