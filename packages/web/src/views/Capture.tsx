import { useState } from 'react';
import { api } from '../api';

/**
 * Quick capture. The most important control in the app — if getting something
 * out of your head is slower than remembering it, nothing else here matters.
 *
 * One field, Enter to save, focus stays put for the next one.
 */
export function Capture({ onAdded }: { onAdded: () => void }) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || saving) return;

    setSaving(true);
    setError('');
    try {
      await api.tasks.create({ title: trimmed });
      setTitle('');
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="row">
        <div className="grow">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            enterKeyHint="done"
            aria-label="New task"
          />
        </div>
        <button className="btn primary" type="submit" disabled={!title.trim() || saving}>
          Add
        </button>
      </div>
      {error && <div className="banner">{error}</div>}
    </form>
  );
}
