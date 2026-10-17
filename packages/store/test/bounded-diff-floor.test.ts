import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Effect, Fiber, Layer } from "effect";

import { Store, StoreConfig } from "../src/store.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 10_000;

/**
 * A range of a few hundred files whose whole listing never prints: a `git` in front of the real
 * one blocks `git diff --name-status …` with no pathspec on a FIFO nobody writes, as git itself
 * does while it walks a range too wide to finish within the deadline (it prints a range's files
 * only after walking all of it). Every other git call runs for real. The write end opens once the
 * blocked git holds the read end, which is how the test knows the listing is running.
 */
const blockedListing = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-bounded-floor-"));
    const root = path.join(dir, "repo");
    const shims = path.join(dir, "bin");
    const fifo = path.join(dir, "listing");
    fs.mkdirSync(root);
    fs.mkdirSync(shims);
    execFileSync("mkfifo", [fifo]);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      path.join(shims, "git"),
      [
        "#!/bin/sh",
        `[ "$1" = diff ] && [ "$2" = --name-status ] && exec cat ${JSON.stringify(fifo)}`,
        `exec ${JSON.stringify(realGit)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const git = (...args: ReadonlyArray<string>) =>
      execFileSync(realGit, ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
        cwd: root,
        encoding: "utf8",
      }).trim();
    git("init", "-qb", "main");
    fs.writeFileSync(path.join(root, "kept.txt"), "kept\n");
    git("add", "--all");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    for (const directory of ["a", "b", "c"]) {
      fs.mkdirSync(path.join(root, directory));
      for (let file = 0; file < 100; file++) {
        const name = `${directory}/f${String(file).padStart(3, "0")}.txt`;
        fs.writeFileSync(path.join(root, name), `${name}\n`);
      }
    }
    fs.writeFileSync(path.join(root, "kept.txt"), "kept\nchanged\n");
    git("add", "--all");
    git("commit", "-qm", "wide");
    const top = git("rev-parse", "HEAD");
    // The oracle: the whole listing's paths in git's order, read by the real git.
    const whole = git("diff", "--name-status", "-z", "--find-renames", base, top)
      .split("\0")
      .filter((_, index) => index % 2 === 1);
    const hostPath = process.env["PATH"];
    process.env["PATH"] = `${shims}${path.delimiter}${hostPath ?? ""}`;
    return { dir, root, fifo, base, top, whole, hostPath };
  }),
  ({ dir, hostPath }) =>
    Effect.sync(() => {
      if (hostPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = hostPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }),
);

const writeEnd = (fifo: string) =>
  Effect.acquireRelease(
    Effect.promise(() => fs.promises.open(fifo, "w")),
    (handle) => Effect.promise(() => handle.close()),
  );

describe("a listing the deadline cuts before git printed a file", () => {
  it.effect("answers the range's first files, cut, never none", () =>
    Effect.gen(function* () {
      const { root, fifo, base, top, whole } = yield* blockedListing;
      const store = yield* Store.pipe(
        Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root)))),
      );
      const listing = yield* store
        .diffFileFactsBounded(root, base, top, {
          maxBytes: MAX_BYTES,
          deadlineMs: DEADLINE_MS,
          minFiles: 150,
        })
        .pipe(Effect.forkChild);
      yield* writeEnd(fifo);
      yield* TestClock.adjust(DEADLINE_MS);
      const cut = yield* Fiber.join(listing);
      expect(cut.cut).toBe(true);
      // The first files in git's own order: a/ whole, then half of b/; c/ and kept.txt past them.
      const paths = cut.facts.map((fact) => fact.newPath);
      expect(paths).toHaveLength(150);
      expect(paths).toEqual(whole.slice(0, 150));
      expect(paths[0]).toBe("a/f000.txt");
      expect(paths[149]).toBe("b/f049.txt");
      expect(cut.facts[0]).toEqual({
        oldPath: null,
        newPath: "a/f000.txt",
        status: "added",
        additions: 1,
        deletions: 0,
        binary: false,
      });
    }),
  );
});
