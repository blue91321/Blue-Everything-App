import type { FeatureMeta } from '@app/features/index';

/*
 * Under Command in the menu, with Voice and Blueprints. Written out in each of the
 * three, since a package may not import another: see `menu-groups.ts` in core.
 * The glyph is drawn by core (`Glyph.tsx`): a command block.
 */
const COMMAND = { id: 'command', label: 'Command', glyph: 'icon:command' };

// Last of the screens, above Settings: it is for working on the app rather
// than using it.
export const meta: FeatureMeta = { id: 'code', label: 'Code', glyph: '⌨️', order: 90, group: COMMAND };
