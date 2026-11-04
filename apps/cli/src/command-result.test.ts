import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { writeCommandResult, type CommandResult } from "./command-result.ts";

describe("agent command wire contract", () => {
  const error = { code: "example", message: "A fact was observed.", fix: "Run the named command." };
  it.each<{ result: CommandResult<unknown>; exit: number }>([
    { result: { status: "done", data: { id: "project" } }, exit: 0 },
    { result: { status: "failed", error }, exit: 1 },
    { result: { status: "usage", error }, exit: 2 },
    { result: { status: "waiting", url: "https://mend.example/authorize", error }, exit: 3 },
    { result: { status: "not_ready", data: {}, items: [], error }, exit: 4 },
    { result: { status: "timeout", error }, exit: 124 },
  ])("$result.status writes one versioned value and exits $exit", ({ result, exit }) => {
    let stdout = "";
    expect(
      writeCommandResult(result, (text) => {
        stdout += text;
      }),
    ).toBe(exit);
    expect(stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(stdout)).toEqual({ v: 1, ...result });
  });

  it("preserves JSON for arbitrary display strings while removing sensitive fields", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        let stdout = "";
        writeCommandResult(
          {
            status: "done",
            data: {
              text,
              password: "private-sentinel",
              nested: { accessToken: "private-sentinel" },
            },
          },
          (line) => {
            stdout += line;
          },
        );
        expect(() => JSON.parse(stdout)).not.toThrow();
        expect(stdout).not.toContain("private-sentinel");
      }),
    );
  });
});
