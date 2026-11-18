import { describe, expect, it } from "vitest";

import { noRunWords } from "#/lib/session-record";

describe("noRunWords", () => {
  it("says a failed launch failed, never that recording was off (fresh install 2026-10-10)", () => {
    const words = noRunWords("failed");
    expect(words.note).toContain("the launch failed before the session's run started");
    expect(words.header).toBe("no record — the launch failed before a run started");
    expect(`${words.note} ${words.header}`).not.toMatch(/recording: off|not supervised/);
  });

  it("says no run started for any other settled session", () => {
    for (const status of ["stopped", "completed"]) {
      const words = noRunWords(status);
      expect(words.header).toBe("no record — no run started for this session");
      expect(words.note).not.toMatch(/recording: off|not supervised|failed/);
    }
  });
});
