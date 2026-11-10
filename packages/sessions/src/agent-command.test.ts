import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { mapAgentCommand, promptCommandOf, withPrompt } from "./agent-command.ts";

const PRINT_ARGV = ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--"];

const run = (argv: ReadonlyArray<string>) => {
  const result = spawnSync(argv[0] ?? "sh", argv.slice(1), { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

describe("withPrompt", () => {
  it("runs the command with the exact prompt as its last argument", () => {
    for (const prompt of [
      "fix the build",
      "  leading and trailing  \n\n",
      `quotes ' " and $(echo no) \`echo no\` $HOME`,
      "é ✓ 🚀",
      "x".repeat(100_000),
    ]) {
      expect(run(withPrompt([process.execPath, ...PRINT_ARGV, "--model", "opus"], prompt))).toEqual(
        ["--model", "opus", prompt],
      );
    }
  });

  it("keeps the command a trailing vector a later step can change", () => {
    const argv = withPrompt(["claude", "--model", "opus"], "a".repeat(130_000));
    expect(promptCommandOf(argv)).toEqual(["claude", "--model", "opus"]);
    const changed = mapAgentCommand(argv, (command) => [...command, "--extra"]);
    expect(promptCommandOf(changed)).toEqual(["claude", "--model", "opus", "--extra"]);
    expect(changed.slice(0, -1)).toEqual(argv);
  });

  it("reaches the command through env assignments, and leaves other commands alone", () => {
    const argv = withPrompt(["env", "OPENCODE_PERMISSION={}", "opencode", "--prompt"], "go");
    expect(promptCommandOf(mapAgentCommand(argv, (command) => [`<${command[0]}>`]))).toEqual([
      "env",
      "OPENCODE_PERMISSION={}",
      "<opencode>",
    ]);
    for (const other of [["sh", "-c", "exec codex"], ["bash", "-l"], []]) {
      expect(promptCommandOf(other)).toEqual(other);
      expect(mapAgentCommand(other, (command) => command)).toEqual(other);
    }
  });
});
