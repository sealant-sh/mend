import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { gitCapped } from "../src/git.ts";

/**
 * Git blocked on a FIFO it reads: it prints nothing and never exits until the test writes the
 * FIFO, so only the deadline can stop it. The write end opens once git holds the read end, which
 * is how the test knows git is running.
 */
const blockedGit = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-git-capped-"));
    const fifo = path.join(dir, "input");
    execFileSync("mkfifo", [fifo]);
    return { dir, fifo };
  }),
  ({ dir }) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
);

const writeEnd = (fifo: string) =>
  Effect.acquireRelease(
    Effect.promise(() => fs.promises.open(fifo, "w")),
    (handle) => Effect.promise(() => handle.close()),
  );

describe("gitCapped deadline", () => {
  it.effect("git still running at the deadline is stopped, and what it printed answers cut", () =>
    Effect.gen(function* () {
      const { dir, fifo } = yield* blockedGit;
      const run = yield* gitCapped(["hash-object", fifo], dir, 1024, 10_000).pipe(Effect.forkChild);
      yield* writeEnd(fifo);
      yield* TestClock.adjust(10_000);
      expect(yield* Fiber.join(run)).toEqual({ stdout: "", cut: true });
    }),
  );

  it.effect("git that finishes a millisecond before the deadline answers whole", () =>
    Effect.gen(function* () {
      const { dir, fifo } = yield* blockedGit;
      const run = yield* gitCapped(["hash-object", fifo], dir, 1024, 10_000).pipe(Effect.forkChild);
      const input = yield* writeEnd(fifo);
      yield* TestClock.adjust(9_999);
      yield* Effect.promise(async () => {
        await input.writeFile("bytes git hashes");
        await input.close();
      });
      const expected = execFileSync("git", ["hash-object", "--stdin"], {
        input: "bytes git hashes",
        encoding: "utf8",
      }).trim();
      expect(yield* Fiber.join(run)).toEqual({ stdout: expected, cut: false });
    }),
  );
});
