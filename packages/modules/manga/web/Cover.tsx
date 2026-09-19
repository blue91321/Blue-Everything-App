/**
 * A cover picture, fetched with the bearer token.
 *
 * Shared by the tab and the panel rather than written twice, because the object
 * URL lifecycle is the fiddly part and two copies means one of them leaks.
 *
 * It deliberately does **not** revoke on unmount, which is the opposite of what
 * the notes attachments do. Those create a URL per render of a note; this caches
 * one per series for the life of the page, so revoking when one row unmounts
 * would break every other row still showing the same series — and scrolling a
 * list would revoke and refetch endlessly. The cache is bounded by the size of
 * your library, which is the point at which this is worth revisiting.
 */
import { useEffect, useState } from 'react';
import { coverFor } from './manga-api';

export function Cover({ id, title, size = 48 }: { id: string; title: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    coverFor(id).then(
      (u) => alive && setUrl(u),
      () => alive && setFailed(true)
    );
    return () => {
      alive = false;
    };
  }, [id]);

  const style = { width: size, height: Math.round(size * 1.4) } as const;

  // A placeholder rather than nothing, so a row is the same height whether or
  // not the picture arrived — a list that reflows as covers land is worse than
  // one that never had them.
  if (!url) {
    return (
      <div className="manga-cover manga-cover-empty" style={style} aria-hidden="true">
        {failed ? '' : '…'}
      </div>
    );
  }

  return <img className="manga-cover" style={style} src={url} alt={`Cover of ${title}`} />;
}
