import { describe, expect, it } from "vitest";

import type { WorkbenchEventDto } from "#/lib/api";
import { LINGER_MS, makeWorkbenchStream, type WorkbenchStreamMember } from "#/lib/workbench-events";

/** A stand-in for the browser's EventSource: what was opened, closed, and a way to speak. */
const world = () => {
  const sources: Array<{
    closed: boolean;
    closes: number;
    readonly open: () => void;
    readonly error: () => void;
    readonly fail: (closed: boolean) => void;
    readonly say: (event: WorkbenchEventDto) => void;
  }> = [];
  const timers = new Map<
    number,
    { readonly run: () => void; readonly ms: number; readonly at: number }
  >();
  const cancelled: Array<number> = [];
  const focusListeners = new Set<() => void>();
  const focusCallbacks: Array<() => void> = [];
  let clock = 0;
  let nextTimer = 1;
  const stream = makeWorkbenchStream({
    connect: (on) => {
      const entry = {
        closed: false,
        closes: 0,
        open: on.open,
        error: on.error,
        fail: (closed: boolean) => {
          entry.closed = closed;
          on.error();
        },
        say: (event: WorkbenchEventDto) => on.message(JSON.stringify(event)),
      };
      sources.push(entry);
      return {
        closed: () => entry.closed,
        close: () => {
          entry.closed = true;
          entry.closes += 1;
        },
      };
    },
    later: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { run, ms, at: clock + ms });
      return id;
    },
    cancel: (handle) => {
      cancelled.push(handle);
      timers.delete(handle);
    },
    onFocus: (run) => {
      focusListeners.add(run);
      focusCallbacks.push(run);
      return () => void focusListeners.delete(run);
    },
  });
  const advance = (ms: number) => {
    const until = clock + ms;
    while (true) {
      const next = [...timers]
        .filter(([, timer]) => timer.at <= until)
        .toSorted((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (next === undefined) break;
      const [id, timer] = next;
      clock = timer.at;
      timers.delete(id);
      timer.run();
    }
    clock = until;
  };
  const elapse = () =>
    advance(Math.max(0, ...[...timers.values()].map((timer) => timer.at - clock)));
  const focus = () => {
    for (const run of focusListeners) run();
  };
  return {
    stream,
    sources,
    timers,
    cancelled,
    focusListeners,
    focusCallbacks,
    advance,
    elapse,
    focus,
  };
};

const member = (log: Array<string>, name: string): WorkbenchStreamMember => ({
  apply: (event) => void log.push(`apply:${name}:${event.type}`),
  reconnected: () => void log.push(`reconnected:${name}`),
  onEvent: (event) => void log.push(`event:${name}:${event.type}`),
});

const ACCESS: WorkbenchEventDto = { type: "user", userId: "carol", facet: "access" };

describe("the tab's one event stream", () => {
  it("is one connection for the shell and the page, re-reading once per event and telling each", () => {
    const { stream, sources } = world();
    const log: Array<string> = [];
    stream.join(member(log, "shell"));
    stream.join(member(log, "page"));
    expect(sources).toHaveLength(1);
    sources[0]?.say({ type: "project", projectId: "p1" });
    expect(log).toEqual(["apply:shell:project", "event:shell:project", "event:page:project"]);
  });

  it("reaches a page with no listener of its own through the shell, Settings among them", () => {
    const { stream, sources } = world();
    const heard: Array<WorkbenchEventDto> = [];
    // The shell's member is the only one on Settings; its apply walks to sign-in with the reason.
    stream.join({
      apply: (event) => void heard.push(event),
      reconnected: () => {},
      onEvent: undefined,
    });
    sources[0]?.say(ACCESS);
    expect(heard).toEqual([ACCESS]);
    // Nothing more is said to a removed account: the stream ends.
    expect(sources[0]?.closed).toBe(true);
  });

  it("outlives a navigation, and closes a beat after its last member leaves", () => {
    const { stream, sources, timers, elapse } = world();
    const log: Array<string> = [];
    const leave = stream.join(member(log, "old"));
    leave();
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([LINGER_MS]);
    stream.join(member(log, "new"));
    elapse();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.closed).toBe(false);
    const leaveLast = stream.join(member(log, "other"));
    leaveLast();
    expect(sources[0]?.closed).toBe(false);
  });

  it("closes when nobody joins again within the beat", () => {
    const { stream, sources, elapse } = world();
    const leave = stream.join(member([], "only"));
    leave();
    elapse();
    expect(sources[0]?.closed).toBe(true);
  });

  it("re-reads once for each reconnect, never the first open, across shared members", () => {
    const { stream, sources, timers } = world();
    const log: Array<string> = [];
    const leaveShell = stream.join(member(log, "shell"));
    stream.join(member(log, "page"));
    expect(sources).toHaveLength(1);
    sources[0]?.open();
    expect(log).toEqual([]);

    sources[0]?.fail(false);
    expect(timers.size).toBe(0);
    expect(sources[0]?.closes).toBe(0);
    sources[0]?.open();
    expect(log).toEqual(["reconnected:shell"]);

    leaveShell();
    sources[0]?.fail(false);
    sources[0]?.open();
    expect(log).toEqual(["reconnected:shell", "reconnected:page"]);
    expect(sources).toHaveLength(1);
    expect(timers.size).toBe(0);
  });

  it("replaces CLOSED sources on the bounded ladder and resets it after a successful open", () => {
    const { stream, sources, timers, advance } = world();
    const log: Array<string> = [];
    stream.join(member(log, "shell"));
    stream.join(member(log, "page"));
    sources[0]?.open();

    for (const [index, delay] of [3_000, 4_000, 8_000, 16_000, 16_000].entries()) {
      sources[index]?.fail(true);
      expect(sources[index]?.closes).toBe(1);
      expect([...timers.values()].map((timer) => timer.ms)).toEqual([delay]);
      advance(delay - 1);
      expect(sources).toHaveLength(index + 1);
      advance(1);
      expect(sources).toHaveLength(index + 2);
      expect(timers.size).toBe(0);
    }

    sources[5]?.open();
    expect(log).toEqual(["reconnected:shell"]);
    sources[5]?.fail(true);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([3_000]);
    advance(3_000);
    sources[6]?.open();
    expect(log).toEqual(["reconnected:shell", "reconnected:shell"]);

    // A callback already queued by a replaced source cannot affect its successor.
    sources[0]?.open();
    sources[0]?.error();
    expect(log).toEqual(["reconnected:shell", "reconnected:shell"]);
    expect(timers.size).toBe(0);
    expect(sources).toHaveLength(7);
  });

  it("ignores focus on a healthy stream and replaces a CLOSED source immediately", () => {
    const { stream, sources, timers, cancelled, focusListeners, advance, focus } = world();
    const log: Array<string> = [];
    stream.join(member(log, "shell"));
    stream.join(member(log, "page"));
    expect(focusListeners.size).toBe(1);
    sources[0]?.open();
    focus();
    expect(sources).toHaveLength(1);
    expect(log).toEqual([]);

    sources[0]?.fail(true);
    const [retry] = timers.keys();
    expect(retry).toBeDefined();
    advance(100);
    focus();
    expect(cancelled).toEqual([retry]);
    expect(timers.size).toBe(0);
    expect(sources).toHaveLength(2);
    sources[1]?.open();
    expect(log).toEqual(["reconnected:shell"]);
    advance(3_000);
    expect(sources).toHaveLength(2);

    sources[1]?.fail(true);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([3_000]);
  });

  it("cancels backoff and focus after the last unsubscribe, ignoring queued old callbacks", () => {
    const { stream, sources, timers, cancelled, focusListeners, focusCallbacks, advance, focus } =
      world();
    const log: Array<string> = [];
    const leave = stream.join(member(log, "departed"));
    sources[0]?.open();
    sources[0]?.fail(true);
    const [retry] = timers.keys();
    expect(retry).toBeDefined();
    leave();
    advance(LINGER_MS - 1);
    expect(focusListeners.size).toBe(1);
    advance(1);
    expect(cancelled).toEqual([retry]);
    expect(timers.size).toBe(0);
    expect(focusListeners.size).toBe(0);
    expect(sources[0]?.closed).toBe(true);

    sources[0]?.open();
    sources[0]?.error();
    focusCallbacks[0]?.();
    focus();
    advance(16_000);
    expect(sources).toHaveLength(1);
    expect(timers.size).toBe(0);
    expect(log).toEqual([]);

    const leaveNew = stream.join(member(log, "new"));
    expect(sources).toHaveLength(2);
    expect(focusListeners.size).toBe(1);
    sources[1]?.open();
    // A fresh subscription starts with its own first open, not a reconnect of the departed member.
    expect(log).toEqual([]);
    sources[0]?.open();
    sources[0]?.error();
    expect(log).toEqual([]);
    expect(timers.size).toBe(0);
    leaveNew();
    advance(LINGER_MS);
    expect(sources[1]?.closed).toBe(true);
    expect(focusListeners.size).toBe(0);
  });

  it("focus resets the retry ladder before the replacement has successfully opened", () => {
    const { stream, sources, timers, advance, focus } = world();
    stream.join(member([], "shell"));
    sources[0]?.fail(true);
    advance(3_000);
    sources[1]?.fail(true);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([4_000]);

    focus();
    expect(sources).toHaveLength(3);
    expect(timers.size).toBe(0);
    // No open event reset the counter: focus itself starts the next ladder at its first rung.
    sources[2]?.fail(true);
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([3_000]);
    advance(3_000);
    expect(sources).toHaveLength(4);
    advance(1_000);
    expect(sources).toHaveLength(4);
  });
});
