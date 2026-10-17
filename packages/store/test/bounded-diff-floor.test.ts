import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";

import { type DiffFileFactsListing, Store, StoreConfig } from "../src/store.ts";

const MAX_BYTES = 8 * 1024 * 1024;
/** The test's own deadline: the listing it blocks ends there, the floor is found long before. */
const DEADLINE_MS = 2_000;

type Scenario = "wide" | "renames" | "move" | "special" | "bytes" | "directory";

/**
 * A range whose whole listing never prints: a `git` in front of the real one holds a range
 * listing with no pathspec (`git diff --name-status …`, `--numstat` too) as git itself does while
 * it walks a range too wide to finish within the deadline (it prints a range's files only after
 * walking all of it). Every other git call runs for real, so these tests run on the live clock:
 * the floor is real git work the TestClock cannot step, and the deadline is the test's own.
 * `directory` also holds every directory read (`ls-tree`), so the walk cannot get past the root.
 */
const repository = (scenario: Scenario) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-bounded-floor-"));
      const root = path.join(dir, "repo");
      const shims = path.join(dir, "bin");
      fs.mkdirSync(root);
      fs.mkdirSync(shims);
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const git = (...args: ReadonlyArray<string>) =>
        execFileSync(realGit, ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
          cwd: root,
          encoding: "utf8",
        }).trim();
      const write = (name: string | Buffer, body: string | Buffer) =>
        fs.writeFileSync(
          typeof name === "string"
            ? path.join(root, name)
            : Buffer.concat([Buffer.from(`${root}/`), name]),
          body,
        );
      git("init", "-qb", "main");
      write("kept.txt", "kept\n");
      if (scenario === "renames") {
        for (let file = 0; file < 100; file++) write(`a-old-${pad(file)}`, `unique ${file}\n`);
      }
      if (scenario === "move") write("z-source.txt", "one\ntwo\nthree\n");
      if (scenario === "special") write("a deleted\nfile.txt", "old\n");
      git("add", "--all");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      switch (scenario) {
        case "wide":
          for (const directory of ["a", "b", "c"]) {
            fs.mkdirSync(path.join(root, directory));
            for (let file = 0; file < 100; file++) {
              const name = `${directory}/f${pad(file)}.txt`;
              write(name, `${name}\n`);
            }
          }
          write("kept.txt", "kept\nchanged\n");
          break;
        case "renames":
          // 100 moves pair into 100 facts; 200 additions follow them.
          for (let file = 0; file < 100; file++) {
            fs.renameSync(
              path.join(root, `a-old-${pad(file)}`),
              path.join(root, `b-new-${pad(file)}`),
            );
          }
          for (let file = 0; file < 200; file++) write(`c-added-${pad(file)}`, `added ${file}\n`);
          break;
        case "move":
          // The move's target is the range's first path, its source the last.
          fs.renameSync(path.join(root, "z-source.txt"), path.join(root, "0-target.txt"));
          write("m.txt", "middle\n");
          break;
        case "special":
          fs.unlinkSync(path.join(root, "a deleted\nfile.txt"));
          write("b binary.dat", Buffer.from([0, 1, 2]));
          write("c new\nfile.txt", "line1\nline2\n");
          break;
        case "bytes":
          write(
            Buffer.concat([Buffer.from("a-"), Buffer.from([255]), Buffer.from(".txt")]),
            "bytes\n",
          );
          write("b.txt", "after\n");
          break;
        case "directory":
          write("0-first.txt", "first\n");
          fs.mkdirSync(path.join(root, "a"));
          write("a/f.txt", "new\n");
          break;
      }
      git("add", "--all");
      if (scenario === "special") {
        git("update-index", "--add", "--cacheinfo", `160000,${base},d-submodule`);
      }
      git("commit", "-qm", "top");
      const top = git("rev-parse", "HEAD");
      fs.writeFileSync(
        path.join(shims, "git"),
        [
          "#!/bin/sh",
          `[ "$1" = diff ] && exec sleep 600`,
          ...(scenario === "directory" ? [`[ "$1" = ls-tree ] && exec sleep 600`] : []),
          `exec ${JSON.stringify(realGit)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const hostPath = process.env["PATH"];
      return { dir, root, shims, base, top, hostPath };
    }),
    ({ dir, hostPath }) =>
      Effect.sync(() => {
        if (hostPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = hostPath;
        fs.rmSync(dir, { recursive: true, force: true });
      }),
  );

const pad = (index: number) => String(index).padStart(3, "0");

/** The whole listing by the real git, then the same range with its listing held, cut by the deadline. */
const wholeThenCut = (scenario: Scenario, minFiles: number) =>
  Effect.gen(function* () {
    const { root, shims, base, top } = yield* repository(scenario);
    const store = yield* Store.pipe(
      Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root)))),
    );
    const whole = yield* store.diffFileFactsBounded(root, base, top, { maxBytes: MAX_BYTES });
    process.env["PATH"] = `${shims}${path.delimiter}${process.env["PATH"] ?? ""}`;
    const startedAt = performance.now();
    const cut = yield* store.diffFileFactsBounded(root, base, top, {
      maxBytes: MAX_BYTES,
      deadlineMs: DEADLINE_MS,
      minFiles,
    });
    return { whole, cut, elapsedMs: performance.now() - startedAt };
  });

const newPaths = (listing: DiffFileFactsListing) => listing.facts.map((fact) => fact.newPath);

describe("a listing the deadline cuts before git printed a file", () => {
  it.live("answers the range's first files in git's order, cut, never none", () =>
    Effect.gen(function* () {
      const { whole, cut } = yield* wholeThenCut("wide", 150);
      expect(whole.cut).toBe(false);
      expect(whole.facts).toHaveLength(301);
      expect(cut.cut).toBe(true);
      // a/ whole, then half of b/; c/ and kept.txt past them.
      expect(cut.facts).toEqual(whole.facts.slice(0, 150));
      expect(newPaths(cut)[0]).toBe("a/f000.txt");
      expect(newPaths(cut)[149]).toBe("b/f049.txt");
    }),
  );

  it.live(
    "counts facts, not paths: moves pair into one fact each and the floor fills past them",
    () =>
      Effect.gen(function* () {
        const { whole, cut } = yield* wholeThenCut("renames", 200);
        expect(whole.facts).toHaveLength(300);
        expect(whole.facts.filter((fact) => fact.status === "renamed")).toHaveLength(100);
        // 200 paths were 100 moves: the walk went on until 200 facts, and the range ran out first.
        expect(cut).toEqual(whole);
      }),
  );

  it.live("pairs a move whose sides are both within the first files", () =>
    Effect.gen(function* () {
      const { whole, cut } = yield* wholeThenCut("move", 4);
      expect(whole.facts[0]).toMatchObject({ status: "renamed", oldPath: "z-source.txt" });
      expect(cut).toEqual({ facts: whole.facts, cut: false });
    }),
  );

  it.live("lists a move whose source lies past the first files as the addition it is there", () =>
    Effect.gen(function* () {
      const { whole, cut } = yield* wholeThenCut("move", 1);
      const target = whole.facts[0];
      expect(target).toMatchObject({ newPath: "0-target.txt", additions: 0, deletions: 0 });
      expect(cut.cut).toBe(true);
      expect(cut.facts).toEqual([
        { ...target, status: "added", oldPath: null, additions: 3, deletions: 0 },
      ]);
    }),
  );

  it.live(
    "lists names with spaces and newlines, a binary file and a gitlink as the whole listing does",
    () =>
      Effect.gen(function* () {
        const { whole, cut } = yield* wholeThenCut("special", 200);
        expect(whole.facts).toHaveLength(4);
        expect(whole.facts.map((fact) => fact.status)).toEqual([
          "deleted",
          "added",
          "added",
          "added",
        ]);
        // Every file was found and listed: nothing is missing, so the listing is not cut.
        expect(cut).toEqual({ facts: whole.facts, cut: false });
      }),
  );

  it.live("keeps a name's bytes that are not UTF-8 through to git", () =>
    Effect.gen(function* () {
      const { whole, cut } = yield* wholeThenCut("bytes", 200);
      expect(newPaths(whole)).toEqual(["a-�.txt", "b.txt"]);
      expect(cut).toEqual({ facts: whole.facts, cut: false });
    }),
  );

  it.live(
    "answers by the deadline with the files it found when a directory read never returns",
    () =>
      Effect.gen(function* () {
        const { whole, cut, elapsedMs } = yield* wholeThenCut("directory", 200);
        expect(newPaths(whole)).toEqual(["0-first.txt", "a/f.txt"]);
        // The root's own file was listed; the directory below it was not read within the deadline.
        expect(cut).toEqual({ facts: whole.facts.slice(0, 1), cut: true });
        expect(elapsedMs).toBeGreaterThanOrEqual(DEADLINE_MS);
        expect(elapsedMs).toBeLessThan(2 * DEADLINE_MS);
      }),
  );
});
