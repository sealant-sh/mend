import { describe, expect, it } from "vitest";

import type { WorkbenchEventDto } from "#/lib/api";
import { LINGER_MS, makeWorkbenchStream, type WorkbenchStreamMember } from "#/lib/workbench-events";

/** A stand-in for the browser's EventSource: what was opened, closed, and a way to speak. */
const world = () => {
  const sources: Array<{ closed: boolean; readonly say: (event: WorkbenchEventDto) => void }> = [];
  const timers = new Map<number, { readonly run: () => void; readonly ms: number }>();
  let nextTimer = 1;
  const stream = makeWorkbenchStream({
    connect: (on) => {
      const entry = {
        closed: false,
        say: (event: WorkbenchEventDto) => on.message(JSON.stringify(event)),
      };
      sources.push(entry);
      return {
        closed: () => entry.closed,
        close: () => {
          entry.closed = true;
        },
      };
    },
    later: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { run, ms });
      return id;
    },
    cancel: (handle) => void timers.delete(handle),
    onFocus: () => () => undefined,
  });
  const elapse = () => {
    for (const [id, timer] of Array.from(timers)) {
      timers.delete(id);
      timer.run();
    }
  };
  return { stream, sources, timers, elapse };
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
});
