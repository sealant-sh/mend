import { describe, expect, it } from "vitest";

import { agentActivity, sessionAsk } from "./inbox.ts";

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

describe("what a running agent is doing", () => {
  const item = (
    kind: Parameters<typeof agentActivity>[0]["kind"],
    title: string | null,
    data: unknown,
  ) => agentActivity({ kind, title, data });

  it("names Codex's command and file from the item's title", () => {
    expect(item("command-execution", "pnpm test", { command: "pnpm test" })).toEqual({
      kind: "command",
      subject: "pnpm test",
    });
    expect(item("file-change", "src/checkout.ts", null)).toEqual({
      kind: "edit",
      subject: "src/checkout.ts",
    });
  });

  it("names Claude's command and file from the tool's input, never the tool's name", () => {
    expect(
      item("command-execution", "Bash", { name: "Bash", input: { command: "pnpm test" } }),
    ).toEqual({ kind: "command", subject: "pnpm test" });
    expect(
      item("file-change", "Edit", { name: "Edit", input: { file_path: "src/retry.ts" } }),
    ).toEqual({ kind: "edit", subject: "src/retry.ts" });
    expect(item("web-search", "WebSearch", { name: "WebSearch", input: {} })).toEqual({
      kind: "search",
      subject: null,
    });
  });

  it("says nothing for an item that isn't work under way", () => {
    expect(item("user-message", null, null)).toBeNull();
    expect(item("error", "boom", null)).toBeNull();
  });
});
