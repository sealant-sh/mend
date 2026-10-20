import { describe, expect, it } from "vitest";

import type { SessionDetail, SessionProcess } from "../types.js";
import { pasteIntoAgent, type PasteEffects } from "./agent-paste.js";
import { session } from "./test-fixtures.js";

const process = (id: string, kind: string, exited = false): SessionProcess => ({
  id,
  kind,
  harness: kind === "shell" ? null : "claude",
  status: exited ? "exited" : "running",
  exitedAt: exited ? "2026-10-19T10:30:00.000Z" : null,
  providerSessionId: null,
  label: null,
  waiting: null,
});

const detail = (processes: ReadonlyArray<SessionProcess>): SessionDetail => ({
  session: session("s1"),
  processes,
  currentAgent: processes.find((one) => one.kind === "agent-pty") ?? null,
  changeId: "change-1",
});

/**
 * One window: Mend's answers in turn, the tab Answer attaches (by the process it is attached to),
 * and every paste made.
 */
const world = (
  answers: ReadonlyArray<ReadonlyArray<SessionProcess>>,
  attached: string,
): PasteEffects<string> & { readonly pasted: Array<[string, string]> } => {
  let read = 0;
  const pasted: Array<[string, string]> = [];
  return {
    pasted,
    detail: async () => detail(answers[Math.min(read++, answers.length - 1)] ?? []),
    answer: async () => undefined,
    activeTab: () => `tab of ${attached}`,
    processOf: (tab) => tab.replace("tab of ", ""),
    paste: async (tab, text) => {
      pasted.push([tab, text]);
      return true;
    },
    sleep: async () => undefined,
  };
};

const CLAUDE = process("agent-1", "agent-pty");
const SHELL = process("shell-1", "shell");

describe("the review pasted into claude's terminal (G12 fallback)", () => {
  it("goes into claude's own terminal while Mend lists it live", async () => {
    const effects = world([[CLAUDE, SHELL]], "agent-1");
    expect(await pasteIntoAgent(effects, "s1", "agent-1", "the review")).toBe("pasted");
    expect(effects.pasted).toEqual([["tab of agent-1", "the review"]]);
  });

  it("goes nowhere once claude exited and Answer attached the supporting shell", async () => {
    // Mend held the review for claude; by the paste claude is gone and the shell is the session's.
    const effects = world(
      [
        [CLAUDE, SHELL],
        [process("agent-1", "agent-pty", true), SHELL],
      ],
      "shell-1",
    );
    expect(await pasteIntoAgent(effects, "s1", "agent-1", "the review")).toBe("agent-gone");
    expect(effects.pasted).toEqual([]);
  });

  it("goes nowhere when claude exits between attaching its terminal and the paste", async () => {
    const effects = world(
      [
        [CLAUDE, SHELL],
        [process("agent-1", "agent-pty", true), SHELL],
      ],
      "agent-1",
    );
    expect(await pasteIntoAgent(effects, "s1", "agent-1", "the review")).toBe("agent-gone");
    expect(effects.pasted).toEqual([]);
  });

  it("goes nowhere, and attaches nothing, when claude is already gone", async () => {
    const effects = world([[process("agent-1", "agent-pty", true), SHELL]], "shell-1");
    expect(await pasteIntoAgent(effects, "s1", "agent-1", "the review")).toBe("agent-gone");
    expect(effects.pasted).toEqual([]);
  });
});

describe("a paste while claude still runs", () => {
  it("goes nowhere when the tab Answer showed is the supporting shell's", async () => {
    const effects = world([[CLAUDE, SHELL]], "shell-1");
    expect(await pasteIntoAgent(effects, "s1", "agent-1", "the review")).toBe("not-attached");
    expect(effects.pasted).toEqual([]);
  });
});
