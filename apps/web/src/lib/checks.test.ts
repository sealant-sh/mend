import type { AgentItemDto } from "@mend/agent-conversation";
import { describe, expect, it } from "vitest";

import { observedChecks } from "./checks.ts";

let seq = 0;
const command = (
  text: string,
  at: string,
  extra: Partial<AgentItemDto> & { readonly exitCode?: number } = {},
): AgentItemDto => {
  seq += 1;
  const { exitCode, ...rest } = extra;
  return {
    id: `i-${seq}`,
    seq,
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

describe("observedChecks", () => {
  it("keeps the latest run of each check, newest first, and leaves other commands out", () => {
    const checks = observedChecks([
      command("pnpm test", "2026-11-18T10:00:00Z", { exitCode: 1 }),
      command("ls -la", "2026-11-18T10:01:00Z", { exitCode: 0 }),
      command("pnpm typecheck", "2026-11-18T10:02:00Z", { exitCode: 0 }),
      command("pnpm test", "2026-11-18T10:03:00Z", { exitCode: 0 }),
    ]);
    expect(checks.map((check) => [check.command, check.result])).toEqual([
      ["pnpm test", "passed"],
      ["pnpm typecheck", "passed"],
    ]);
  });

  it("reads a run with no exit code as unknown, a failed step as failed, and one in progress as running", () => {
    const checks = observedChecks([
      command("vitest run", "2026-11-18T10:00:00Z"),
      command("pnpm lint", "2026-11-18T10:01:00Z", { status: "failed" }),
      command("cargo clippy", "2026-11-18T10:02:00Z", { status: "in-progress" }),
    ]);
    expect(checks.map((check) => check.result)).toEqual(["running", "failed", "unknown"]);
  });

  it("leaves out a declined command and anything that isn't a command step", () => {
    expect(
      observedChecks([
        command("pnpm test", "2026-11-18T10:00:00Z", { status: "declined" }),
        command("pnpm test", "2026-11-18T10:01:00Z", { kind: "file-change" }),
      ]),
    ).toEqual([]);
  });
});
