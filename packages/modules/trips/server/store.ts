/**
 * Trips, on disk.
 *
 * A package cannot add a table, so everything is in `data/trips.json` beside
 * the database, the arrangement the weather and the manga library use.
 *
 * ### Unlike the weather's file, this one is not a cache
 *
 * The weather treats an unreadable file as empty, because it is a reading and
 * two settings and the next fetch puts it back. A trip is something you typed:
 * flights, confirmation codes, a checklist. Treating a stray comma as "no trips"
 * and then saving would replace all of it with nothing. So an unreadable file is
 * refused, loudly, and nothing is written over it until it is fixed or moved.
 *
 * Written to a temporary file and renamed into place, so a crash mid-write
 * leaves the old file rather than half of the new one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDir } from '@everything/server/module-api';

export const STORE_FILE = join(dataDir, 'trips.json');

export interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  /** IANA zone. Times at this airport are shown in it. */
  tz: string;
}

/** What the flight service said last, kept beside the schedule it can change. */
export interface Live {
  status: string | null;
  /** Best known departure and arrival: revised if there is one, else scheduled. */
  departs: number;
  arrives: number;
  gate: string | null;
  terminal: string | null;
  arrivalGate: string | null;
  arrivalTerminal: string | null;
  baggageBelt: string | null;
  aircraft: string | null;
}

export interface Flight {
  id: string;
  /** "UA123", normalised. */
  number: string;
  /** The departure date at the departure airport, as typed: what the flight is booked on. */
  date: string;
  airline: string | null;
  from: Airport;
  to: Airport;
  /** The timetable's times. Live status never overwrites these; it is beside them. */
  departs: number;
  arrives: number;
  confirmation: string | null;
  seat: string | null;
  notes: string | null;
  /** Where the times came from, so the screen can say. */
  filledBy: 'service' | 'typed';
  live: Live | null;
  /** When the service was last asked about this flight, and what went wrong if it failed. */
  checkedAt: number | null;
  checkError: string | null;
  /** Task links, kept after the task is gone so it is never made twice. See `tasks.ts`. */
  tasks: TaskLinks;
}

export interface Place {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  kind: 'stay' | 'visit' | 'food' | 'other';
  /** A day of the trip, as "YYYY-MM-DD", or null. */
  date: string | null;
  notes: string | null;
}

export interface ChecklistItem {
  id: string;
  text: string;
  /** Days from the trip's first day: -2 is two days before, 0 the first day. Null for no date. */
  offsetDays: number | null;
  task: TaskLink;
}

/**
 * One task this package made.
 *
 * `made` stays true after the task is deleted, with `id` null, and that is what
 * stops a deleted task coming back on the next sync: the coursework sync's
 * `integration_task_links`, as a field. `due` is what this package last set its
 * due date to, so a date you moved by hand is left where you put it.
 */
export interface TaskLink {
  made: boolean;
  id: string | null;
  due?: number | null;
}

export interface TaskLinks {
  checkIn: TaskLink;
  leave: TaskLink;
}

export interface Trip {
  id: string;
  name: string;
  /** Typed dates. When absent, the flights decide. */
  start: string | null;
  end: string | null;
  notes: string | null;
  flights: Flight[];
  places: Place[];
  checklist: ChecklistItem[];
  createdAt: number;
}

export interface Settings {
  /** Which reminders a flight becomes. */
  checkInTask: boolean;
  leaveTask: boolean;
  /** Hours before departure that online check-in opens. 24 for most airlines. */
  checkInHours: number;
  /** Minutes before departure to leave for the airport. */
  leaveDomesticMinutes: number;
  leaveInternationalMinutes: number;
  /** A nudge when live status shows a delay, a gate change or a cancellation. */
  alerts: boolean;
  /** Lookups this package may make in a calendar month, which is how a free plan is kept free. */
  monthlyBudget: number;
}

export interface Store {
  trips: Trip[];
  settings: Settings;
  /** RapidAPI key for AeroDataBox. Never sent to a browser. */
  apiKey: string | null;
  usage: { month: string; calls: number };
}

export const DEFAULT_SETTINGS: Settings = {
  checkInTask: true,
  leaveTask: true,
  checkInHours: 24,
  leaveDomesticMinutes: 120,
  leaveInternationalMinutes: 180,
  alerts: true,
  monthlyBudget: 250,
};

const EMPTY: Store = { trips: [], settings: DEFAULT_SETTINGS, apiKey: null, usage: { month: '', calls: 0 } };

export class StoreUnreadable extends Error {}

export function newId(): string {
  return randomUUID();
}

const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** Settings read back defensively, so a hand-edited number cannot leave a reminder a year early. */
export function cleanSettings(raw: Partial<Settings> | undefined): Settings {
  const s = raw ?? {};
  return {
    checkInTask: s.checkInTask !== false,
    leaveTask: s.leaveTask !== false,
    checkInHours: num(s.checkInHours, 1, 72, DEFAULT_SETTINGS.checkInHours),
    leaveDomesticMinutes: num(s.leaveDomesticMinutes, 15, 600, DEFAULT_SETTINGS.leaveDomesticMinutes),
    leaveInternationalMinutes: num(s.leaveInternationalMinutes, 15, 720, DEFAULT_SETTINGS.leaveInternationalMinutes),
    alerts: s.alerts !== false,
    monthlyBudget: num(s.monthlyBudget, 0, 100_000, DEFAULT_SETTINGS.monthlyBudget),
  };
}

export function read(): Store {
  if (!existsSync(STORE_FILE)) return structuredClone(EMPTY);
  let parsed: Partial<Store>;
  try {
    const raw = readFileSync(STORE_FILE, 'utf8');
    parsed = JSON.parse(raw.startsWith('﻿') ? raw.slice(1) : raw) as Partial<Store>;
  } catch (error) {
    throw new StoreUnreadable(
      `data/trips.json could not be read (${(error as Error).message}). Nothing has been changed; fix the file or move it aside to start again.`
    );
  }
  return {
    trips: Array.isArray(parsed.trips) ? parsed.trips : [],
    settings: cleanSettings(parsed.settings),
    apiKey: typeof parsed.apiKey === 'string' && parsed.apiKey.trim() ? parsed.apiKey.trim() : null,
    usage:
      parsed.usage && typeof parsed.usage.month === 'string' && typeof parsed.usage.calls === 'number'
        ? parsed.usage
        : { month: '', calls: 0 },
  };
}

export function write(next: Store): void {
  mkdirSync(dataDir, { recursive: true });
  const temp = `${STORE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temp, STORE_FILE);
}

/** The month a lookup is counted against, on this machine's calendar. */
export function monthKey(at = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Lookups used this month, counting a new month as zero. */
export function usedThisMonth(store: Store, at = Date.now()): number {
  return store.usage.month === monthKey(at) ? store.usage.calls : 0;
}

/**
 * The trip's first and last days: typed if typed, else from its flights.
 *
 * A flight's day is its departure date at its own airport, the date on the
 * booking. Null when there is nothing to go on.
 */
export function tripSpan(trip: Trip, localDateOf: (at: number, tz: string) => string): { start: string | null; end: string | null } {
  const days = trip.flights.flatMap((f) => [f.date, localDateOf(f.arrives, f.to.tz)]).sort();
  return {
    start: trip.start ?? days[0] ?? null,
    end: trip.end ?? days.at(-1) ?? trip.start ?? null,
  };
}
