import { describe, expect, it } from "vitest";

import { postureOf } from "./posture";
import { initialsOf, railSessions } from "./rail";
import { splitIdsOf, splitParam, withoutSession, withSession } from "./split";

describe("postureOf", () => {
  it("keeps a phone, and a foldable's cover screen, to one pane", () => {
    expect(postureOf({ width: 393, height: 852 })).toBe("compact");
    expect(postureOf({ width: 852, height: 393 })).toBe("compact");
    // Galaxy Z Fold 8, folded: 1248 × 1972 px at 2.625.
    expect(postureOf({ width: 475, height: 751 })).toBe("compact");
  });

  it("splits a foldable's inner screen side by side open flat, one above the other upright", () => {
    // Galaxy Z Fold 8, open: 2448 × 1848 px at 2.625.
    expect(postureOf({ width: 933, height: 704 })).toBe("landscape");
    expect(postureOf({ width: 704, height: 933 })).toBe("upright");
  });

  it("reads a square window as upright", () => {
    expect(postureOf({ width: 800, height: 800 })).toBe("upright");
  });
});

describe("split ids", () => {
  it("reads the route parameter in order, without blanks or repeats, two at most", () => {
    expect(splitIdsOf(undefined)).toEqual([]);
    expect(splitIdsOf("")).toEqual([]);
    expect(splitIdsOf("a")).toEqual(["a"]);
    expect(splitIdsOf("a, b")).toEqual(["a", "b"]);
    expect(splitIdsOf("a,a,b")).toEqual(["a", "b"]);
    expect(splitIdsOf("a,b,c")).toEqual(["a", "b"]);
    expect(splitIdsOf(["a", "b,c"])).toEqual(["a", "b"]);
  });

  it("adds a session once, and a full split trades its last for the new one", () => {
    expect(withSession([], "a")).toEqual(["a"]);
    expect(withSession(["a"], "a")).toEqual(["a"]);
    expect(withSession(["a"], "b")).toEqual(["a", "b"]);
    expect(withSession(["a", "b"], "c")).toEqual(["a", "c"]);
  });

  it("removes one session and writes the parameter back", () => {
    expect(withoutSession(["a", "b"], "a")).toEqual(["b"]);
    expect(splitParam(["a", "b"])).toBe("a,b");
  });
});

const session = (id: string, status: string, label: string | null = null) => ({
  id,
  status,
  label,
  harness: "claude",
});

describe("the session rail", () => {
  it("lists the sessions waiting on you, then the live ones, then the one on screen", () => {
    const sessions = [
      session("done", "completed"),
      session("live", "running"),
      session("asks", "waiting"),
      session("other-done", "failed"),
    ];
    expect(railSessions(sessions, "done").map((s) => s.id)).toEqual(["asks", "live", "done"]);
    expect(railSessions(sessions, "live").map((s) => s.id)).toEqual(["asks", "live"]);
  });

  it("takes two letters from the label's first two words, else from the harness", () => {
    expect(initialsOf({ label: "iPhone nav header scroll", harness: "claude" })).toBe("IN");
    expect(initialsOf({ label: "test-latency", harness: "codex" })).toBe("TL");
    expect(initialsOf({ label: "configs", harness: "codex" })).toBe("CO");
    expect(initialsOf({ label: null, harness: "codex" })).toBe("CO");
  });
});
