import type { FeatureMeta } from '@app/features/index';

/*
 * Under Command in the menu, with Voice and Code. Written out in each of the
 * three, since a package may not import another: see `menu-groups.ts` in core.
 * The glyph is drawn by core (`Glyph.tsx`): a command block.
 */
const COMMAND = { id: 'command', label: 'Command', glyph: 'icon:command' };

// Near the end, before Code: it is for making the app do more, which is a
// thing you set up rather than a screen you live in.
export const meta: FeatureMeta = { id: 'blueprints', label: 'Blueprints', glyph: '🧩', order: 85, group: COMMAND };
