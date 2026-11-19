import { describe, expect, it } from "vitest";

import {
  clearedWords,
  dopplerChooser,
  dopplerRow,
  dopplerSaveProblem,
  type MemoryNote,
  noteFacts,
  notesLine,
  noteText,
  whenWords,
} from "./only-you.ts";

const now = new Date(2026, 10, 19, 9, 30);
const note = (name: string, updatedAt: Date, updatedBySession: string | null): MemoryNote => ({
  path: `.claude/projects/-workspace-repo/memory/${name}`,
  harness: "claude",
  name,
  bytes: 1_200,
  updatedAt,
  updatedBySession,
});

describe("whenWords", () => {
  it("says today, yesterday, or the day", () => {
    expect(whenWords(new Date(2026, 10, 19, 8, 5), now)).toBe("today at 08:05");
    expect(whenWords(new Date(2026, 10, 18, 16, 20), now)).toBe("yesterday at 16:20");
    expect(whenWords(new Date(2026, 2, 2, 12, 0), now)).toBe("on 2 March");
    expect(whenWords(new Date(2025, 2, 2, 12, 0), now)).toBe("on 2 March 2025");
  });
});

describe("notesLine", () => {
  it("counts the notes and says who last changed one, from the newest", () => {
    const notes = [
      note("MEMORY.md", new Date(2026, 10, 10, 9, 0), null),
      note("tests.md", new Date(2026, 10, 18, 16, 20), "5c1f9e2a-0000-4000-8000-000000000000"),
    ];
    expect(notesLine(notes, "checkout-api", now)).toBe(
      "2 notes. The agent last changed one yesterday at 16:20.",
    );
  });

  it("says an import when nobody's session wrote the newest", () => {
    expect(notesLine([note("MEMORY.md", new Date(2026, 10, 19, 8, 0), null)], "api", now)).toBe(
      "1 note. You last imported one today at 08:00.",
    );
  });

  it("says how memory fills when it is empty", () => {
    expect(notesLine([], "checkout-api", now)).toMatch(/^No notes yet\. .*checkout-api/);
  });
});

describe("noteFacts", () => {
  it("names the agent, the size and what last changed it", () => {
    expect(noteFacts(note("tests.md", new Date(2026, 10, 18, 16, 20), "5c1f9e2a-xyz"), now)).toBe(
      "Claude Code · 1.2 KB · changed by session 5c1f9e2a yesterday at 16:20",
    );
  });
});

describe("clearedWords", () => {
  it("says it cleared every note", () => {
    expect(clearedWords({ removed: [{ name: "a" }, { name: "b" }], failed: [] })).toEqual({
      done: true,
      words: "Cleared 2 notes.",
    });
  });

  it("names the notes it couldn't remove, and why", () => {
    expect(
      clearedWords({
        removed: [{ name: "a" }],
        failed: [{ name: "tests.md", message: "The project is being removed." }],
      }),
    ).toEqual({
      done: false,
      words:
        "Mend removed 1 note but not 1 note: tests.md (The project is being removed). Try again.",
    });
  });
});

describe("noteText", () => {
  it("shows text and nothing for a file that isn't", () => {
    expect(noteText({ encoding: "utf8", contents: "- run the tests\n" })).toBe("- run the tests\n");
    expect(noteText({ encoding: "base64", contents: "AAEC" })).toBeNull();
  });
});

describe("Doppler", () => {
  // Recorded `doppler.status` answers, as the API sends them.
  const connected = {
    connected: true,
    mappings: [
      { projectId: "p1", dopplerProject: "checkout", config: "dev_personal", projectName: "api" },
    ],
  };

  it("reads the row from the person's status: not connected, nothing picked, or the config", () => {
    expect(dopplerRow({ connected: false, mappings: [] }, "p1")).toEqual({ kind: "not-connected" });
    expect(dopplerRow(connected, "p2")).toEqual({ kind: "none" });
    expect(dopplerRow(connected, "p1")).toEqual({
      kind: "picked",
      dopplerProject: "checkout",
      config: "dev_personal",
    });
  });

  it("picks from Doppler's lists, and types the names when Doppler won't list them", () => {
    expect(dopplerChooser("pending", "idle")).toEqual({ kind: "loading" });
    expect(dopplerChooser("success", "success")).toEqual({ kind: "pick" });
    expect(dopplerChooser("error", "idle")).toEqual({ kind: "type-both" });
    expect(dopplerChooser("success", "error")).toEqual({ kind: "type-config" });
  });

  it("holds the server's naming rule before it sends", () => {
    expect(dopplerSaveProblem("checkout", "dev_personal")).toBeNull();
    expect(dopplerSaveProblem("checkout", " ")).toBe("Pick a Doppler project and a config.");
    expect(dopplerSaveProblem("check out", "dev")).toMatch(/letters, digits, underscores/);
  });
});
