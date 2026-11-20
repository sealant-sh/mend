import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { INBOX_GROUPS, type InboxGroup, type InboxRow } from "./inbox.ts";

/**
 * How a sidebar row moves between groups (frame "Session states · moving between groups"): a row
 * never jumps. Its glyph and words change first, in place; then its old place closes as its new
 * one opens, and it stays lit a moment so the eye can find it. Into a folded group, the heading
 * lights instead. A row whose menu is open, or that is being pressed, waits until it is let go.
 * With reduced motion, the glyph and words change and the row lands lit, with no slide.
 *
 * The row's words and glyph come from the new facts at once; only where it is listed lags.
 */

/** The glyph and words change in place, before the row leaves. */
export const CHANGE_MS = 160;
/** The old place closes (height and opacity). */
export const CLOSE_MS = 200;
/** The new place opens, at the top of its group, starting with the close. */
export const OPEN_MS = 240;
/** The moved row, or a folded group's heading, stays lit, then fades. */
export const LIT_MS = 1_500;
/** How often a held row is asked again whether it is let go. */
const HELD_RETRY_MS = 100;

/** One row as a group lists it while rows move. */
export interface ShownRow {
  readonly row: InboxRow;
  /** `entering`: its new place opens; `leaving`: the place it left closes; `still` otherwise. */
  readonly phase: "still" | "entering" | "leaving";
  /** Lit after landing here. */
  readonly lit: boolean;
}

/** A move under way: the group the row is still listed in, at the index it had there. */
interface Pending {
  readonly from: InboxGroup;
  readonly to: InboxGroup;
  readonly index: number;
}

/** A place a row left, closing, at the index it had. */
interface Leaving {
  readonly row: InboxRow;
  readonly group: InboxGroup;
  readonly index: number;
  readonly until: number;
}

/** What the sidebar knows of moves at one moment; `shownGroups` builds what it lists from it. */
export interface MoveState {
  /** Rows held in the group they are leaving, by session id. */
  readonly pending: ReadonlyMap<string, Pending>;
  readonly leaving: ReadonlyArray<Leaving>;
  /** Rows lit after landing, until when. */
  readonly lit: ReadonlyMap<string, number>;
  /** Rows whose new place is opening, until when. */
  readonly entering: ReadonlyMap<string, number>;
  /** Folded groups whose heading is lit, until when. */
  readonly litGroups: ReadonlyMap<InboxGroup, number>;
}

export const NO_MOVES: MoveState = {
  pending: new Map(),
  leaving: [],
  lit: new Map(),
  entering: new Map(),
  litGroups: new Map(),
};

/**
 * What each group lists now: its rows; the rows still held in it on their way out, at the index
 * they had; and the closing places rows left, at theirs.
 */
export const shownGroups = (
  groups: Readonly<Record<InboxGroup, ReadonlyArray<InboxRow>>>,
  state: MoveState,
  now: number,
): Readonly<Record<InboxGroup, ReadonlyArray<ShownRow>>> => {
  const inserts = new Map<
    InboxGroup,
    Array<{ readonly index: number; readonly shown: ShownRow }>
  >();
  const insert = (group: InboxGroup, index: number, shown: ShownRow) =>
    inserts.set(group, [...(inserts.get(group) ?? []), { index, shown }]);
  for (const { group } of INBOX_GROUPS)
    for (const row of groups[group]) {
      const pending = state.pending.get(row.session.id);
      if (pending !== undefined)
        insert(pending.from, pending.index, { row, phase: "still", lit: false });
    }
  for (const left of state.leaving)
    if (left.until > now)
      insert(left.group, left.index, { row: left.row, phase: "leaving", lit: false });
  const shown = (group: InboxGroup): ReadonlyArray<ShownRow> => {
    const list: Array<ShownRow> = groups[group]
      .filter((row) => !state.pending.has(row.session.id))
      .map((row) => ({
        row,
        phase: (state.entering.get(row.session.id) ?? 0) > now ? "entering" : "still",
        lit: (state.lit.get(row.session.id) ?? 0) > now,
      }));
    for (const { index, shown: each } of (inserts.get(group) ?? []).toSorted(
      (a, b) => a.index - b.index,
    ))
      list.splice(Math.min(index, list.length), 0, each);
    return list;
  };
  return {
    waiting: shown("waiting"),
    review: shown("review"),
    running: shown("running"),
    snoozed: shown("snoozed"),
    done: shown("done"),
  };
};

/** The rows that changed group since `before`: new rows and rows gone aren't moves. */
export const movesBetween = (
  before: ReadonlyMap<string, InboxGroup>,
  groups: Readonly<Record<InboxGroup, ReadonlyArray<InboxRow>>>,
): ReadonlyArray<{ readonly id: string; readonly from: InboxGroup; readonly to: InboxGroup }> =>
  INBOX_GROUPS.flatMap(({ group }) =>
    groups[group].flatMap((row) => {
      const from = before.get(row.session.id);
      return from === undefined || from === group ? [] : [{ id: row.session.id, from, to: group }];
    }),
  );

/** Where each row is listed, by session id. */
export const placesOf = (
  groups: Readonly<Record<InboxGroup, ReadonlyArray<InboxRow>>>,
): ReadonlyMap<string, InboxGroup> =>
  new Map(
    INBOX_GROUPS.flatMap(({ group }) =>
      groups[group].map((row) => [row.session.id, group] as const),
    ),
  );

const subscribeToMotion = (onChange: () => void) => {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** Whether the person asked for less motion; false on the server. */
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(
    subscribeToMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );

/**
 * A row is held while its menu is open or a pointer presses it: it doesn't move from under the
 * person's hand. The rows carry `data-row-id`; Base UI marks an open menu's trigger
 * `data-popup-open`.
 */
const isHeld = (id: string): boolean => {
  const element = document.querySelector(`[data-row-id="${CSS.escape(id)}"]`);
  return (
    element !== null &&
    (element.matches("[data-popup-open], :active") ||
      element.querySelector("[data-popup-open]") !== null)
  );
};

/**
 * The sidebar's groups as they move. Following the inbox's live rows in time is what this is
 * for, so timers drive it: each move is held `CHANGE_MS` (longer while the row is held), then
 * lands. `open` says which groups are open, so a move into a folded one lights its heading.
 */
export const useSidebarMoves = (
  groups: Readonly<Record<InboxGroup, ReadonlyArray<InboxRow>>>,
  open: Readonly<Record<InboxGroup, boolean>>,
): {
  readonly groups: Readonly<Record<InboxGroup, ReadonlyArray<ShownRow>>>;
  readonly litGroups: ReadonlySet<InboxGroup>;
} => {
  const reduced = useReducedMotion();
  const [state, setState] = useState<MoveState>(NO_MOVES);
  const [now, setNow] = useState(() => Date.now());
  const latest = useRef({ groups, open, reduced, state });
  const previous = useRef<Readonly<Record<InboxGroup, ReadonlyArray<InboxRow>>> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  // Each timer outlives later renders (a move must land though other rows change meanwhile);
  // they all stop with the sidebar.
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running) clearTimeout(timer);
    };
  }, []);

  // Following the inbox as its rows change group: compare with where they were listed, and start
  // the timers of each move.
  useEffect(() => {
    latest.current = { groups, open, reduced, state };
  });
  useEffect(() => {
    const before = previous.current;
    previous.current = groups;
    if (before === null) return;
    const later = (ms: number, then: () => void) => {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        then();
      }, ms);
      timers.current.add(timer);
    };
    const tick = () => setNow(Date.now());
    const land = (id: string, to: InboxGroup) => {
      const current = latest.current.state;
      const pending = current.pending.get(id);
      if (pending === undefined || pending.to !== to) return;
      if (isHeld(id)) return later(HELD_RETRY_MS, () => land(id, to));
      const at = Date.now();
      const rest = new Map(current.pending);
      rest.delete(id);
      const row = latest.current.groups[to].find((each) => each.session.id === id);
      const still = latest.current.reduced;
      const next: MoveState = {
        pending: rest,
        leaving:
          still || row === undefined || !latest.current.open[pending.from]
            ? current.leaving
            : [
                ...current.leaving,
                { row, group: pending.from, index: pending.index, until: at + CLOSE_MS },
              ],
        lit: new Map(current.lit).set(id, at + LIT_MS),
        entering: still ? current.entering : new Map(current.entering).set(id, at + OPEN_MS),
        litGroups: !latest.current.open[to]
          ? new Map(current.litGroups).set(to, at + LIT_MS)
          : current.litGroups,
      };
      latest.current = { ...latest.current, state: next };
      setState(next);
      setNow(at);
      // Draw again as the close, the open and the light end, so their marks come off.
      later(CLOSE_MS, tick);
      later(OPEN_MS, tick);
      later(LIT_MS, tick);
    };
    const current = latest.current.state;
    const pending = new Map(current.pending);
    const landing: Array<{ readonly id: string; readonly to: InboxGroup }> = [];
    const listedBefore = shownGroups(before, current, Date.now());
    for (const move of movesBetween(placesOf(before), groups)) {
      const already = pending.get(move.id);
      if (already?.to === move.to) continue;
      // Back where it was before it left: it never moved.
      if (already?.from === move.to) {
        pending.delete(move.id);
        continue;
      }
      const index = Math.max(
        0,
        listedBefore[already?.from ?? move.from].findIndex(
          (each) => each.row.session.id === move.id,
        ),
      );
      pending.set(move.id, { from: already?.from ?? move.from, to: move.to, index });
      landing.push({ id: move.id, to: move.to });
    }
    if (pending.size === current.pending.size && landing.length === 0) return;
    const next = { ...current, pending };
    latest.current = { ...latest.current, state: next };
    setState(next);
    // With reduced motion too the words change before the row lands, so it never lands ahead
    // of what it says.
    for (const move of landing) later(CHANGE_MS, () => land(move.id, move.to));
  }, [groups]);

  const shown = shownGroups(groups, state, now);
  const litGroups = new Set(
    [...state.litGroups].flatMap(([group, until]) => (until > now ? [group] : [])),
  );
  return { groups: shown, litGroups };
};
