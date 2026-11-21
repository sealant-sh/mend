import { describe, expect, it } from "vitest";

import { memoryLimitWords, memorySizeWords } from "./memory-limit.ts";

describe("memoryLimitWords", () => {
  it("says the agent was stopped, with the limit", () => {
    expect(
      memoryLimitWords({ limitBytes: 4 * 1024 ** 3, stopped: "agent", agent: "Claude Code" }),
    ).toBe("The workspace reached its memory limit of 4 GiB, and the kernel stopped Claude Code.");
  });

  it("says a process was stopped and the agent goes on", () => {
    expect(
      memoryLimitWords({ limitBytes: 1.5 * 1024 ** 3, stopped: "process", agent: "Codex" }),
    ).toBe(
      "The workspace reached its memory limit of 1.5 GiB, and the kernel stopped a process in it, most likely a command Codex ran. Codex is still running.",
    );
    expect(memoryLimitWords({ limitBytes: null, stopped: "process", agent: "the agent" })).toBe(
      "The workspace ran out of memory, and the kernel stopped a process in it, most likely a command the agent ran. The agent is still running.",
    );
  });

  it("writes sizes in binary units", () => {
    expect(memorySizeWords(512 * 1024 ** 2)).toBe("512 MiB");
    expect(memorySizeWords(16 * 1024 ** 3)).toBe("16 GiB");
  });
});
