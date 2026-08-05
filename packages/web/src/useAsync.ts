import { useCallback, useEffect, useState } from 'react';
import { Unauthorized } from './api';
import { onDataChange } from './live';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Load-and-reload, which is the only data pattern this app needs.
 *
 * A query library would be ~13KB gzipped to solve caching and deduplication
 * problems a single-user app on a local network doesn't have.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  // Anything that changes on the server — from the phone, from the agent
  // delivering a nudge — reloads here too, so two open copies never disagree.
  useEffect(() => onDataChange(reload), [reload]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fn()
      .then((result) => {
        if (cancelled) return;
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
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return { data, error, loading, reload };
}
