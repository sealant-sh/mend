import { describe, expect, it } from "vitest";

import { createSseParser, eventFamilies } from "./workbench-events.ts";

describe("sse frames", () => {
  it("yields data payloads and swallows heartbeat comments", () => {
    const parser = createSseParser();
    expect(parser.push(': ping\n\ndata: {"type":"session"}\n\n')).toEqual(['{"type":"session"}']);
  });

  it("holds an incomplete frame until the rest arrives", () => {
    const parser = createSseParser();
    expect(parser.push('data: {"ty')).toEqual([]);
    expect(parser.push('pe":"project"}\n\n')).toEqual(['{"type":"project"}']);
  });

  it("joins multi-line data the way the SSE spec reads it", () => {
    const parser = createSseParser();
    expect(parser.push("data: one\ndata: two\n\n")).toEqual(["one\ntwo"]);
  });

  it("handles several frames in one chunk", () => {
    const parser = createSseParser();
    expect(parser.push("data: a\n\n: ping\n\ndata: b\n\n")).toEqual(["a", "b"]);
  });
});

describe("what an event stales", () => {
  it("routes pointer events to their families", () => {
    expect(eventFamilies('{"type":"project"}')).toEqual(["workbench"]);
    expect(eventFamilies('{"type":"session-process"}')).toEqual(["workbench"]);
    // A session's status and its turns also move the detail pane's read-only
    // output preview, which reads the same conversation record.
    expect(eventFamilies('{"type":"session"}')).toEqual(["workbench", "review", "transcript"]);
    expect(eventFamilies('{"type":"agent-conversation"}')).toEqual(["workbench", "review"]);
    expect(eventFamilies('{"type":"agent-conversation","kind":"item"}')).not.toContain(
      "transcript",
    );
    expect(eventFamilies('{"type":"session-change"}')).toEqual(["workbench", "review"]);
    expect(eventFamilies('{"type":"worktree"}')).toEqual(["workbench"]);
    expect(eventFamilies('{"type":"review-comment"}')).toEqual(["workbench", "review"]);
  });

  it("ignores per-record-line progress, queue-era types, and noise", () => {
    // Per-line progress would otherwise refetch the preview on a 250ms loop.
    expect(eventFamilies('{"type":"session-progress","line":"…"}')).toEqual([]);
    expect(eventFamilies('{"type":"brief"}')).toEqual([]);
    expect(eventFamilies("not json")).toEqual([]);
    expect(eventFamilies("{}")).toEqual([]);
  });
});
