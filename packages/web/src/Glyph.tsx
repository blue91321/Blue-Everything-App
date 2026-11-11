/**
 * A screen's or a folder's glyph: an emoji or a character as text, which is
 * what nearly all of them are, or `icon:<name>` for one drawn here.
 *
 * Drawn because some want a picture no character has: Command's folder, asked
 * for as something like a command block. In core so a package can name one in
 * its `meta.ts` without carrying a drawing, the way it names an emoji. An
 * unknown name draws nothing rather than the text `icon:…`.
 */
import type { ReactNode } from 'react';

/**
 * A block with a prompt on its face: copper-coloured sides, a dark panel, and
 * `>_` in it, for the folder of things that make the app do things (Voice,
 * Blueprints, Code). Its own colours whatever the accent, as an emoji keeps
 * its own, since it stands among emoji in the menu.
 */
function CommandBlock() {
  return (
    <svg className="glyph-icon" viewBox="0 0 16 16" width="1.15em" height="1.15em" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="14" height="14" rx="2" fill="#c8773c" stroke="#6e3b18" strokeWidth="1" />
      <path d="M1.5 4.5h13M1.5 11.5h13" stroke="#a65e2a" strokeWidth="0.8" />
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="#2b1a10" stroke="#6e3b18" strokeWidth="0.8" />
      <path d="M5.2 6.2 7 8 5.2 9.8" fill="none" stroke="#f4d9ad" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 9.9h2.8" stroke="#f4d9ad" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

const ICONS: Record<string, () => ReactNode> = { command: CommandBlock };

export function Glyph({ glyph }: { glyph: string }) {
  if (glyph.startsWith('icon:')) {
    const Icon = ICONS[glyph.slice(5)];
    return Icon ? <Icon /> : null;
  }
  return <>{glyph}</>;
}
