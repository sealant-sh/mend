import { useSyncExternalStore } from "react";

import type { SessionDto } from "#/lib/api";
import { isRecord } from "#/lib/is-record";

/**
 * Snooze — t3code's model (Sidebar.snooze.ts + threadSettled.ts at nightly
 * 20260821.1150, MIT): a visibility overlay, never a change to the session.
 * A snoozed row leaves the inbox for the collapsed Snoozed shelf until its
 * wake time — or until it raises a hand: the session starts waiting on you,
 * fails freshly (a session snoozed while already failed stays snoozed: that
 * snooze meant "I saw it, not now"), or settles after the snooze. Client-
 * local, like read state; a row's position is stable, its section moves.
 */

export interface SnoozeEntry {
  /** Wake time, ISO. */
  readonly until: string;
  /** When the snooze was set, ISO — the hand-raise rules compare against it. */
  readonly at: string;
}

export type Snoozes = Readonly<Record<string, SnoozeEntry>>;

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  readonly until: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

const atHour = (base: Date, dayOffset: number, hour: number): Date => {
  // Calendar-day advance, not + DAY_MS, so a DST transition cannot skip a day.
  const date = new Date(base);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  return date;
};

/**
 * The presets, resolved at open time. "This evening" is offered only while
 * more than an hour before it; "Next week" is next Monday 09:00 — a full
 * week out when today is Monday.
 */
export const snoozePresets = (now: Date): ReadonlyArray<SnoozePreset> => {
  const presets: Array<SnoozePreset> = [
    { id: "hour", label: "In 1 hour", until: new Date(now.getTime() + HOUR_MS) },
    { id: "three-hours", label: "In 3 hours", until: new Date(now.getTime() + 3 * HOUR_MS) },
  ];
  const evening = atHour(now, 0, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({ id: "evening", label: "This evening", until: evening });
  }
  presets.push({ id: "tomorrow", label: "Tomorrow", until: atHour(now, 1, MORNING_HOUR) });
  const daysToMonday = (8 - now.getDay()) % 7 || 7;
  presets.push({
    id: "next-week",
    label: "Next week",
    until: atHour(now, daysToMonday, MORNING_HOUR),
  });
  return presets;
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const clock = (date: Date): string =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** A wake time in words: bare time today, `tomorrow 09:00`, `Mon 09:00` within the week, `Mon 5, 09:00` beyond. */
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

export const describeWake = (until: Date, now: Date): string => {
  if (sameDay(until, now)) return clock(until);
  if (sameDay(until, atHour(now, 1, 0))) return `tomorrow ${clock(until)}`;
  const weekday = WEEKDAY[until.getDay()] ?? "";
  if (until.getTime() - now.getTime() < 7 * 24 * HOUR_MS) return `${weekday} ${clock(until)}`;
  return `${weekday} ${until.getDate()}, ${clock(until)}`;
};

/** The shelf's countdown: minutes round UP so a hidden row never reads "0m"; "now" once past. */
export const wakeLabel = (until: string, now: number): string => {
  const ms = Date.parse(until) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
};

/** Snooze is refused where it would be wrong: a session already waiting on you. */
export const canSnooze = (session: SessionDto): boolean => session.status !== "waiting";

const after = (iso: string | null, reference: string): boolean =>
  iso !== null && Date.parse(iso) > Date.parse(reference);

/**
 * Whether the row still classifies as snoozed: the timer has not run out and
 * no hand was raised since. Malformed data never hides a row.
 */
export const effectiveSnoozed = (
  session: SessionDto,
  entry: SnoozeEntry | undefined,
  now: number,
): boolean => {
  if (entry === undefined) return false;
  const until = Date.parse(entry.until);
  if (Number.isNaN(until) || until <= now) return false;
  if (session.status === "waiting") return false;
  if (session.status === "failed" && after(session.settledAt, entry.at)) return false;
  if (
    (session.status === "completed" || session.status === "stopped") &&
    after(session.settledAt, entry.at)
  ) {
    return false;
  }
  return true;
};

// ─── store ──────────────────────────────────────────────────────────────────

const KEY = "mend-snooze";
const listeners = new Set<() => void>();

const read = (): Snoozes => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const out: Record<string, SnoozeEntry> = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (!isRecord(entry)) continue;
      const { until, at } = entry;
      if (typeof until === "string" && typeof at === "string") out[id] = { until, at };
    }
    return out;
  } catch {
    return {};
  }
};

let snoozes: Snoozes = read();

const write = (next: Snoozes) => {
  snoozes = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the snooze still holds this run.
  }
  for (const listener of listeners) listener();
};

export const useSnoozes = (): Snoozes =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snoozes,
  );

export const snooze = (sessionId: string, until: Date, now: Date = new Date()): void =>
  write({ ...snoozes, [sessionId]: { until: until.toISOString(), at: now.toISOString() } });

export const wake = (sessionId: string): void => {
  if (!(sessionId in snoozes)) return;
  const { [sessionId]: _gone, ...rest } = snoozes;
  write(rest);
};

/** The soonest wake among `entries` still in the future, for arming a precise re-render timer. */
export const nextWakeAt = (entries: Snoozes, now: number): number | null => {
  let soonest: number | null = null;
  for (const entry of Object.values(entries)) {
    const until = Date.parse(entry.until);
    if (Number.isNaN(until) || until <= now) continue;
    if (soonest === null || until < soonest) soonest = until;
  }
  return soonest;
};
