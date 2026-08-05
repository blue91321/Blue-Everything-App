/** Human-readable times. Small enough not to justify a date library. */

export function relative(at: number | null | undefined): string {
  if (!at) return '';
  const diff = at - Date.now();
  const past = diff < 0;
  const minutes = Math.round(Math.abs(diff) / 60_000);

  if (minutes < 1) return past ? 'just now' : 'now';
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;

  const days = Math.round(hours / 24);
  if (days < 7) return past ? `${days}d ago` : `in ${days}d`;

  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const isOverdue = (at: number | null | undefined): boolean => at !== null && at !== undefined && at < Date.now();

/** Local midnight boundaries, so "today" means the day as it's actually lived. */
export function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `3:40 pm` — for saying when something will interrupt. */
export const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** `YYYY-MM-DDTHH:mm` for a datetime-local input, in local time. */
export function toLocalInputValue(at: number): string {
  const d = new Date(at - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}
