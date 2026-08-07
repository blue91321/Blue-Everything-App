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

/** `YYYY-MM-DD` for a date input, in local time. */
export const toDateInputValue = (at: number): string => toLocalInputValue(at).slice(0, 10);

/** `HH:mm` for a time input, in local time. */
export const toTimeInputValue = (at: number): string => toLocalInputValue(at).slice(11, 16);

/**
 * How a due date reads.
 *
 * An all-day task must never say "due in 6h" — the time is an implementation
 * detail of storing a date as an instant, and surfacing it makes the app look
 * like it invented a deadline Blake never set.
 */
export function dueLabel(at: number, allDay: boolean): string {
  if (!allDay) return relative(at);

  const day = new Date(at);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(day).setHours(0, 0, 0, 0) - midnight.getTime()) / 86_400_000);

  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1 && days < 7) return day.toLocaleDateString(undefined, { weekday: 'long' });
  if (days < 0) return `${Math.abs(days)} days ago`;
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
