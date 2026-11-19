import type { AgentItemDto } from "@mend/agent-conversation";
import { describe, expect, it } from "vitest";

import {
  checkpointBefore,
  checksFact,
  checkTitle,
  editsSinceChecks,
  observedChecks,
  tookWords,
} from "./checks.ts";

let seq = 0;
const item = (kind: string, at: string, extra: Partial<AgentItemDto> = {}): AgentItemDto => {
  seq += 1;
  return {
    id: `i-${seq}`,
    seq,
    turnId: "t-1",
    kind,
    status: "completed",
    title: null,
    text: null,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
};

// Claude's adapter records the `tool_use` block itself: the tool's name is the title and the
// command sits in `input.command`. No exit code reaches the item.
const claudeTest = item("command-execution", "2026-11-02T10:00:00.000Z", {
  title: "Bash",
  data: {
    type: "tool_use",
    id: "toolu_01XbQ8Vn3sL2kZ9wR4yT7mPq",
    name: "Bash",
    input: { command: "pnpm --filter @mend/web test", description: "Run the web tests" },
  },
});
// Codex's app server records its `commandExecution` thread item, exit code and all.
const codexTypecheck = item("command-execution", "2026-11-02T10:03:00.000Z", {
  title: "pnpm exec turbo typecheck --force",
  data: {
    type: "commandExecution",
    id: "call_7Hk2",
    command: "pnpm exec turbo typecheck --force",
    cwd: "/workspace/repo",
    status: "completed",
    aggregatedOutput: "Tasks: 31 successful, 32 total",
    exitCode: 2,
    durationMs: 19104,
  },
});
const codexLint = item("command-execution", "2026-11-02T10:04:00.000Z", {
  title: "pnpm exec turbo lint",
  data: { type: "commandExecution", command: "pnpm exec turbo lint", exitCode: 0 },
});
const notACheck = item("command-execution", "2026-11-02T10:05:00.000Z", {
  title: "Bash",
  data: { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
});

describe("observed checks", () => {
  it("reads Claude's command from its tool call, and leaves its outcome unknown", () => {
    const [check] = observedChecks([claudeTest]);
    expect(check).toEqual({
      command: "pnpm --filter @mend/web test",
      kind: "tests",
      result: "unknown",
      exitCode: null,
      durationMs: null,
      at: "2026-11-02T10:00:00.000Z",
    });
  });

  it("reads Codex's exit code and duration, newest check first, and skips what checks nothing", () => {
    const checks = observedChecks([claudeTest, codexTypecheck, codexLint, notACheck]);
    expect(
      checks.map((check) => [check.command, check.kind, check.result, check.exitCode]),
    ).toEqual([
      ["pnpm exec turbo lint", "lint", "passed", 0],
      ["pnpm exec turbo typecheck --force", "typecheck", "failed", 2],
      ["pnpm --filter @mend/web test", "tests", "unknown", null],
    ]);
    expect(checks[1]?.durationMs).toBe(19104);
  });

  it("keeps the latest run of a command", () => {
    const again = {
      ...codexTypecheck,
      id: "again",
      updatedAt: "2026-11-02T10:09:00.000Z",
      data: { command: "pnpm exec turbo typecheck --force", exitCode: 0 },
    };
    expect(observedChecks([codexTypecheck, again])[0]?.result).toBe("passed");
  });

  it("reads a step still running as running, and a declined one not at all", () => {
    const running = {
      ...codexLint,
      id: "run",
      status: "in-progress",
      data: { command: "cargo build" },
    };
    const declined = {
      ...codexLint,
      id: "no",
      status: "declined",
      data: { command: "go vet ./..." },
    };
    expect(observedChecks([running, declined]).map((check) => [check.kind, check.result])).toEqual([
      ["build", "running"],
    ]);
  });
});

describe("a check inside the shell a harness records", () => {
  it("reads a command wrapped in quotes, and still skips a word inside another", () => {
    const wrapped = (command: string) =>
      item("command-execution", "2026-11-02T11:00:00.000Z", {
        title: command,
        data: { command, exitCode: 0 },
      });
    const checks = observedChecks([
      wrapped("/bin/bash -lc 'pnpm test'"),
      wrapped('zsh -c "cargo clippy"'),
      wrapped("bash -lc 'git log --oneline; cat latest.txt'"),
      wrapped("bash -lc 'cat attest.md'"),
    ]);
    expect(checks.map((check) => [check.command, check.kind])).toEqual([
      ["/bin/bash -lc 'pnpm test'", "tests"],
      ['zsh -c "cargo clippy"', "lint"],
    ]);
  });
});

describe("a check's words", () => {
  const [lint, typecheck, test] = observedChecks([claudeTest, codexTypecheck, codexLint]);

  it("names the sort of check, how it ended and the checkpoint before it", () => {
    expect(lint && checkTitle(lint, 5)).toBe("Lint passed after checkpoint 5");
    expect(typecheck && checkTitle(typecheck, null)).toBe("Type check failed");
    expect(test && checkTitle(test, 2)).toBe("Tests ran after checkpoint 2");
  });

  it("says how long a check took", () => {
    expect(tookWords(41_200)).toBe("Took 41s.");
    expect(tookWords(124_000)).toBe("Took 2m 4s.");
    expect(tookWords(120_000)).toBe("Took 2m.");
  });

  it("finds the newest checkpoint taken before a check", () => {
    const checkpoints = [
      { ordinal: 0, createdAt: "2026-11-02T09:00:00.000Z" },
      { ordinal: 2, createdAt: "2026-11-02T10:02:00.000Z" },
      { ordinal: 1, createdAt: "2026-11-02T09:30:00.000Z" },
      { ordinal: 3, createdAt: "2026-11-02T10:30:00.000Z" },
    ];
    expect(checkpointBefore(checkpoints, "2026-11-02T10:03:00.000Z")).toBe(2);
    expect(checkpointBefore(checkpoints, "2026-11-02T08:00:00.000Z")).toBeNull();
  });

  it("counts edits made after the newest check that finished", () => {
    const checks = observedChecks([claudeTest, codexTypecheck, codexLint]);
    const before = item("file-change", "2026-11-02T10:01:00.000Z");
    const after = item("file-change", "2026-11-02T10:06:00.000Z");
    const afterToo = item("file-change", "2026-11-02T10:07:00.000Z");
    expect(editsSinceChecks([before, after, afterToo], checks)).toBe(2);
    expect(editsSinceChecks([before, after], [])).toBe(0);
  });

  it("puts a failure first in the tab's fact", () => {
    const checks = observedChecks([claudeTest, codexTypecheck, codexLint]);
    expect(checksFact(checks)).toBe("1 failed");
    expect(checksFact(checks.filter((check) => check.result !== "failed"))).toBe("1 passed");
    expect(checksFact(observedChecks([claudeTest]))).toBeUndefined();
    expect(checksFact([])).toBeUndefined();
  });
});

const step = (
  text: string,
  at: string,
  extra: Partial<AgentItemDto> & { readonly exitCode?: number } = {},
): AgentItemDto => {
  const { exitCode, ...rest } = extra;
  return {
    id: `step-${text}-${at}`,
    seq: 0,
    turnId: "t-1",
    kind: "command-execution",
    status: "completed",
    title: "Bash",
    text: null,
    createdAt: at,
    updatedAt: at,
    data: exitCode === undefined ? { input: { command: text } } : { command: text, exitCode },
    ...rest,
  };
};

describe("observed checks, as the Details view reads them", () => {
  it("keeps the latest run of each check, newest first, and leaves other commands out", () => {
    const checks = observedChecks([
      step("pnpm test", "2026-11-18T10:00:00Z", { exitCode: 1 }),
      step("ls -la", "2026-11-18T10:01:00Z", { exitCode: 0 }),
      step("pnpm typecheck", "2026-11-18T10:02:00Z", { exitCode: 0 }),
      step("pnpm test", "2026-11-18T10:03:00Z", { exitCode: 0 }),
    ]);
    expect(checks.map((check) => [check.command, check.result])).toEqual([
      ["pnpm test", "passed"],
      ["pnpm typecheck", "passed"],
    ]);
  });

  it("reads a run with no exit code as unknown, a failed step as failed, and one in progress as running", () => {
    const checks = observedChecks([
      step("vitest run", "2026-11-18T10:00:00Z"),
      step("pnpm lint", "2026-11-18T10:01:00Z", { status: "failed" }),
      step("cargo clippy", "2026-11-18T10:02:00Z", { status: "in-progress" }),
    ]);
    expect(checks.map((check) => check.result)).toEqual(["running", "failed", "unknown"]);
  });

  it("leaves out a declined command and anything that isn't a command step", () => {
    expect(
      observedChecks([
        step("pnpm test", "2026-11-18T10:00:00Z", { status: "declined" }),
        step("pnpm test", "2026-11-18T10:01:00Z", { kind: "file-change" }),
      ]),
    ).toEqual([]);
  });
});
