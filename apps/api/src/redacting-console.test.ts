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
        // Whitespace inside userinfo, punctuation before the scheme (review 2 of mend#640, N4).
        yield* Effect.logWarning("fetch: https://user:WHITE TOKEN-SECRET@w.example/r.git");
        yield* Effect.logWarning("failure ...https://user:TOKEN-SECRET@p.example/r.git");
        yield* Effect.logWarning("-https://user:TOKEN\u00a0SECRET@d.example/r.git");
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
    expect(log).toContain("fetch: https://w.example/r.git");
    expect(log).toContain("failure ...https://p.example/r.git");
    expect(log).toContain("-https://d.example/r.git");
    expect(log).not.toContain("SECRET");
  });
});
