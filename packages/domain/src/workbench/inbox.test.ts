import { describe, expect, it } from "vitest";

import { sessionAsk } from "./inbox.ts";

const request = (
  kind: Parameters<typeof sessionAsk>[0]["kind"],
  title: string | null,
  detail: unknown,
  questions: Parameters<typeof sessionAsk>[0]["questions"] = null,
) => sessionAsk({ kind, title, detail, questions });

describe("why a waiting session waits", () => {
  it("names the question a person is asked", () => {
    expect(
      request("user-input", "AskUserQuestion", { toolName: "AskUserQuestion" }, [
        {
          id: "q1",
          header: null,
          question: "Which backoff cap should I use?\nPick one.",
          options: [],
          multiSelect: false,
        },
      ]),
    ).toEqual({ kind: "question", subject: "Which backoff cap should I use?" });
  });

  it("names the command Codex wants to run, written as words or as argv", () => {
    expect(
      request("command-approval", "pnpm test", { command: ["pnpm", "test"], cwd: "/w" }),
    ).toEqual({ kind: "command", subject: "pnpm test" });
    expect(request("command-approval", "cargo build", {})).toEqual({
      kind: "command",
      subject: "cargo build",
    });
  });

  it("reads Claude's tool permission as a command, an edit, or the tool", () => {
    expect(
      request("tool-permission", "Bash", { toolName: "Bash", command: "rm -rf dist" }),
    ).toEqual({ kind: "command", subject: "rm -rf dist" });
    expect(
      request("tool-permission", "Edit", { toolName: "Edit", file_path: "worker/retry.ts" }),
    ).toEqual({ kind: "edit", subject: "worker/retry.ts" });
    expect(request("tool-permission", "WebFetch", { toolName: "WebFetch" })).toEqual({
      kind: "tool",
      subject: "WebFetch",
    });
  });

  it("says an edit without a path, and a decision it cannot read, without inventing words", () => {
    expect(request("file-change-approval", null, { reason: "write outside root" })).toEqual({
      kind: "edit",
      subject: null,
    });
    expect(request("unknown", null, null)).toEqual({ kind: "decision", subject: null });
  });

  it("cuts a long subject to one line", () => {
    const ask = request("command-approval", null, { command: "x".repeat(200) });
    expect(ask.subject).toHaveLength(80);
    expect(ask.subject?.endsWith("…")).toBe(true);
  });
});
