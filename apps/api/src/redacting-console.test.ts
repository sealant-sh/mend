import { Console, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { redactingConsole } from "./redacting-console.ts";

/** A console that keeps what it was asked to write. */
const recording = () => {
  const lines: Array<string> = [];
  const keep = (...args: ReadonlyArray<unknown>) => {
    lines.push(args.map(String).join(" "));
  };
  const target: Console.Console = {
    ...globalThis.console,
    debug: keep,
    error: keep,
    info: keep,
    log: keep,
    trace: keep,
    warn: keep,
  };
  return { lines, target };
};

describe("redactingConsole", () => {
  it("keeps a token in a log message, an annotation or an error's text out of the log", async () => {
    const { lines, target } = recording();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logWarning(
          "clone failed: https://oauth2:TOKEN-SECRET@gitlab.com/org/repo.git",
        ).pipe(
          Effect.annotateLogs({
            source: "https://ghp_TOKEN-SECRET@github.com/org/repo.git",
            remote: "ssh://git:TOKEN-SECRET@host.example/srv/repo.git",
          }),
        );
        yield* Effect.logError(
          "adopt failed",
          new Error("git clone -- https://u:TOKEN-SECRET@h.example/r.git"),
        );
      }).pipe(Effect.provideService(Console.Console, redactingConsole(target))),
    );
    const log = lines.join("\n");
    expect(log).not.toContain("TOKEN-SECRET");
    expect(log).toContain("https://gitlab.com/org/repo.git");
    expect(log).toContain("https://github.com/org/repo.git");
    expect(log).toContain("ssh://git@host.example/srv/repo.git");
    expect(log).toContain("https://h.example/r.git");
  });
});
