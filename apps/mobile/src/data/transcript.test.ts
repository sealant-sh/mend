import { describe, expect, it, vi } from "vitest";

import { readTranscript } from "./transcript";

vi.mock("@/data/live", () => ({ api: vi.fn() }));

const PAGE_WIRE = {
  id: "page-1",
  sessionId: "session-1",
  title: "Slowest queries",
  height: 240,
  publishedAt: "2026-10-29T12:05:00.000Z",
};
const event = (kind: string, fields: object = {}) => ({
  kind,
  text: null,
  name: null,
  command: null,
  output: null,
  ...fields,
});

describe("a terminal session's transcript", () => {
  it("carries each event as sent, with the page a page event published decoded in place", () => {
    const transcript = readTranscript({
      sourceHarness: "claude",
      events: [
        event("user", { text: "Which queries are slowest?" }),
        event("page", { page: PAGE_WIRE }),
        event("page", { page: { ...PAGE_WIRE, height: "tall" } }),
        event("tool", { name: "Bash", command: "ls", page: PAGE_WIRE }),
      ],
    });
    expect(transcript.sourceHarness).toBe("claude");
    expect(transcript.events.map((entry) => [entry.kind, entry.page?.title ?? null])).toEqual([
      ["user", null],
      ["page", "Slowest queries"],
      ["page", null],
      ["tool", null],
    ]);
    expect(transcript.events[0]?.text).toBe("Which queries are slowest?");
    expect(transcript.events[3]).toMatchObject({ name: "Bash", command: "ls" });
    expect(transcript.events[1]?.page?.publishedAt).toEqual(new Date(PAGE_WIRE.publishedAt));
  });
});
