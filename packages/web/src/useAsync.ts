import { useCallback, useEffect, useRef, useState } from 'react';
import { Unauthorized } from './api';
import { onDataChange, type ChangeScope } from './live';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  /**
   * There is nothing to show yet.
   *
   * **Only true before the first result arrives**, never during a refresh of
   * data already on screen. Callers overwhelmingly write
   * `if (x.loading) return <spinner/>`, and if that fired on every reload the
   * screen would be replaced by a placeholder each time anything changed — the
   * page collapses to one line and the browser takes the scroll position with
   * it. That is not a caller mistake to be fixed one file at a time; it is the
   * only sensible reading of the word, so it is what the word means here.
   */
  loading: boolean;
  /** A reload is in flight over data that is already on screen. */
  refreshing: boolean;
  reload: () => void;
}

/**
 * Load-and-reload, which is the only data pattern this app needs.
 *
 * A query library would be ~13KB gzipped to solve caching and deduplication
 * problems a single-user app on a local network doesn't have.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
  /**
   * Which change scopes should refetch this.
   *
   * Omit and it reloads on every change anywhere, which is where this started
   * and why one settings toggle refetched the notes list. Naming the scopes is
   * what stops a screen doing work for a change it is not showing.
   */
  watch?: readonly ChangeScope[]
): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Whether a result has ever arrived.
   *
   * A ref rather than reading `data`, because the fetch effect must not depend
   * on it — adding `data` to its dependencies would refetch every time a fetch
   * succeeded, forever.
   */
  const settled = useRef(false);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  // Anything that changes on the server — from the phone, from the agent
  // delivering a nudge — reloads here too, so two open copies never disagree.
  // Joined for the dependency because a caller writing the array inline gets a
  // new identity every render, which would resubscribe on each one.
  const scopes = watch?.join(',');
  useEffect(
    () => onDataChange(reload, scopes ? (scopes.split(',') as ChangeScope[]) : undefined),
    [reload, scopes]
  );

  useEffect(() => {
    let cancelled = false;
    // The distinction that keeps a refresh from blanking the screen.
    if (settled.current) setRefreshing(true);
    else setLoading(true);

    fn()
      .then((result) => {
        if (cancelled) return;
        settled.current = true;
        setData(result);
        setError(undefined);
      })
      .catch((cause: Error) => {
        if (cancelled) return;
        // Let an expired token bubble to the pairing gate rather than
        // rendering it as an ordinary error inside the view.
        if (cause instanceof Unauthorized) window.dispatchEvent(new Event('everything:unauthorized'));
        setError(cause);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return { data, error, loading, refreshing, reload };
}
