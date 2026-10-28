/**
 * The bar edit mode puts at the top of the screen: what you can do, and Done.
 *
 * Fixed at the top right, clear of the ☰, so it is on every screen whatever
 * the screen draws (Manga has its own top bar and a tab bar along the bottom).
 * Saying what to do matters more than it looks: an outline round a word does
 * not by itself say "click me to rename this".
 */
import { setEditMode } from './edit-mode';

export function EditBar() {
  return (
    <div className="edit-bar" role="status">
      <span className="edit-bar-text">
        <strong>Editing.</strong> <span className="edit-bar-hint">Click outlined text to rename or hide it; drag ⠿ to move things.</span>
      </span>
      <button className="btn primary" aria-label="Done editing" onClick={() => setEditMode(false)}>
        {/* On a phone the words go and the pen says what Done is done with. */}
        <span className="edit-bar-pen" aria-hidden="true">
          ✎{' '}
        </span>
        Done
      </button>
    </div>
  );
}
