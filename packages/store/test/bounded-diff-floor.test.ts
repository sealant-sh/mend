import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Effect, Fiber, Layer, type Scope } from "effect";

import { type DiffFileFactsListing, Store, StoreConfig } from "../src/store.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 10_000;

type Scenario = "wide" | "renames" | "move" | "special" | "bytes" | "long" | "flat" | "directory";

/** Which git calls the shim holds on a FIFO, beside the whole listings it always holds. */
type Held = "none" | "ls-tree" | "by-path";

/**
 * A range whose whole listing never prints: a `git` in front of the real one holds a range
 * listing with no pathspec (`git diff --name-status …`, `--numstat` too) on a FIFO nobody writes,
 * as git itself does while it walks a range too wide to finish within the deadline (it prints a
 * range's files only after walking all of it). Every other git call runs for real. The FIFO's
 * write end opens once a held git holds the read end, which is how a test knows it is running.
 * A held call runs `cat` as a child of the shim's shell and records both pids, as git's own
 * children would hold the output pipes: the deadline has to stop the group, not one process.
 */
const repository = (scenario: Scenario, held: Held = "none") =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-bounded-floor-"));
      const root = path.join(dir, "repo");
      const shims = path.join(dir, "bin");
      const listingFifo = path.join(dir, "listing");
      const heldFifo = path.join(dir, "held");
      const pids = path.join(dir, "pids");
      const ends = path.join(dir, "ends");
      fs.mkdirSync(root);
      fs.mkdirSync(shims);
      execFileSync("mkfifo", [listingFifo, heldFifo]);
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const git = (...args: ReadonlyArray<string>) =>
        execFileSync(realGit, ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
          cwd: root,
          encoding: "utf8",
        }).trim();
      const write = (name: string | Buffer, body: string | Buffer) => {
        const file =
          typeof name === "string"
            ? path.join(root, name)
            : Buffer.concat([Buffer.from(`${root}/`), name]);
        fs.mkdirSync(path.dirname(file.toString()), { recursive: true });
        fs.writeFileSync(file, body);
      };
      const long = ["d".repeat(240), "e".repeat(240), "f".repeat(240)].join("/");
      git("init", "-qb", "main");
      write("kept.txt", "kept\n");
      if (scenario === "renames") {
        for (let file = 0; file < 100; file++) write(`a-old-${pad(file)}`, `unique ${file}\n`);
      }
      if (scenario === "long") {
        for (let file = 0; file < 100; file++) {
          write(`a/${long}/f${pad(file)}`, `unique ${file}\n`);
        }
      }
      if (scenario === "move") write("z-source.txt", "one\ntwo\nthree\n");
      if (scenario === "special") write("a deleted\nfile.txt", "old\n");
      git("add", "--all");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      switch (scenario) {
        case "wide":
          for (const directory of ["a", "b", "c"]) {
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
            Buffer.concat([Buffer.from("a-"), Buffer.from([0x80]), Buffer.from(".txt")]),
            "bytes\n",
          );
          write("a-Z.txt", "sibling\n");
          write("b*.txt", "star\n");
          break;
        case "long":
          // 100 moves and 200 additions under paths of about 730 bytes: 400 paths, far past
          // what one command line holds one by one.
          for (let file = 0; file < 100; file++) {
            fs.mkdirSync(path.join(root, "b", long), { recursive: true });
            fs.renameSync(
              path.join(root, "a", long, `f${pad(file)}`),
              path.join(root, "b", long, `f${pad(file)}`),
            );
          }
          for (let file = 0; file < 200; file++)
            write(`c/${long}/f${pad(file)}`, `added ${file}\n`);
          break;
        case "flat":
          // 2,000 files of 200-byte names in one directory: selected one by one, they pass the
          // command line's bound.
          for (let file = 0; file < 2_000; file++) {
            write(`flat/f${String(file).padStart(4, "0")}${"x".repeat(190)}`, `flat ${file}\n`);
          }
          break;
        case "directory":
          write("0-first.txt", "first\n");
          write("a/f.txt", "new\n");
          break;
      }
      git("add", "--all");
      if (scenario === "special") {
        git("update-index", "--add", "--cacheinfo", `160000,${base},d-submodule`);
      }
      git("commit", "-qm", "top");
      const top = git("rev-parse", "HEAD");
      // Whole listing: `git diff …` with no pathspec. Floor listing: `git --no-literal-pathspecs
      // diff … -- <pathspecs>`. A held call keeps the output pipe open from a child of its shell.
      const hold = (fifo: string) =>
        `{ cat ${JSON.stringify(fifo)} & echo "$$ $!" >> ${JSON.stringify(pids)}; wait; exit 0; }`;
      fs.writeFileSync(
        path.join(shims, "git"),
        [
          "#!/bin/sh",
          `[ "$1" = diff ] && ${hold(listingFifo)}`,
          ...(held === "ls-tree" ? [`[ "$1" = ls-tree ] && ${hold(heldFifo)}`] : []),
          ...(held === "by-path" ? [`[ "$1" = --no-literal-pathspecs ] && ${hold(heldFifo)}`] : []),
          // A floor listing that runs for real records its end, after its output pipe closes.
          `[ "$1" = --no-literal-pathspecs ] && { ${JSON.stringify(realGit)} "$@"; s=$?; echo end >> ${JSON.stringify(ends)}; exit $s; }`,
          `exec ${JSON.stringify(realGit)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const hostPath = process.env["PATH"];
      return { dir, root, shims, listingFifo, heldFifo, pids, ends, base, top, hostPath };
    }),
    ({ dir, pids, hostPath }) =>
      Effect.sync(() => {
        if (hostPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = hostPath;
        for (const pid of recordedPids(pids)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone, as the deadline left it.
          }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }),
  );

const pad = (index: number) => String(index).padStart(3, "0");

const recordedPids = (file: string): ReadonlyArray<number> =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .flatMap((line) => line.split(" ").map(Number))
    : [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const writeEnd = (fifo: string) =>
  Effect.acquireRelease(
    Effect.promise(() => fs.promises.open(fifo, "w")),
    (handle) => Effect.promise(() => handle.close()),
  );

/** Waits for a condition real work meets, while virtual time stands still. */
const until = (condition: () => boolean) =>
  Effect.promise(async () => {
    while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
  });

/**
 * The whole listing by the real git, then the same range with its listing held: the floor runs
 * from half the deadline, its real git work finishes while virtual time stands still (every
 * deadline sleep but the held listings' is cancelled), then the deadline cuts the listing.
 * `sequence` takes the test between the floor's start and the deadline.
 */
const wholeThenCut = (
  scenario: Scenario,
  minFiles: number,
  options: {
    readonly held?: Held;
    /** How many times the floor lists by path before it is satisfied: one, unless moves pair. */
    readonly rounds?: number;
    readonly sequence?: (fixture: {
      heldFifo: string;
      pids: string;
    }) => Effect.Effect<void, never, Scope.Scope>;
  } = {},
) =>
  Effect.gen(function* () {
    const held = options.held ?? "none";
    const fixture = yield* repository(scenario, held);
    const { root, shims, listingFifo, pids, ends } = fixture;
    const store = yield* Store.pipe(
      Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root)))),
    );
    const whole = yield* store.diffFileFactsBounded(root, fixture.base, fixture.top, {
      maxBytes: MAX_BYTES,
    });
    process.env["PATH"] = `${shims}${path.delimiter}${process.env["PATH"] ?? ""}`;
    const testClock = yield* Clock.clockWith(Effect.succeed);
    const sleeping = new Set<symbol>();
    const counted: Clock.Clock = {
      ...testClock,
      sleep: (duration) =>
        Effect.suspend(() => {
          const token = Symbol();
          sleeping.add(token);
          return testClock
            .sleep(duration)
            .pipe(Effect.ensuring(Effect.sync(() => sleeping.delete(token))));
        }),
    };
    const running = yield* store
      .diffFileFactsBounded(root, fixture.base, fixture.top, {
        maxBytes: MAX_BYTES,
        deadlineMs: DEADLINE_MS,
        minFiles,
      })
      .pipe(Effect.provideService(Clock.Clock, counted), Effect.forkChild);
    yield* writeEnd(listingFifo);
    yield* until(() => recordedPids(pids).length === 4);
    yield* TestClock.adjust(DEADLINE_MS / 2);
    yield* (options.sequence ?? (() => Effect.void))(fixture);
    // The floor's own git work is done: its listings by path have ended (two a round), and only
    // the held calls' deadlines still sleep, two for the whole listings and two more for a held
    // listing by path.
    const endsExpected = held === "by-path" ? 0 : 2 * (options.rounds ?? 1);
    yield* until(
      () => recordedLines(ends) === endsExpected && sleeping.size === (held === "by-path" ? 4 : 2),
    );
    expect(running.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(DEADLINE_MS - (yield* Clock.currentTimeMillis));
    const cut = yield* Fiber.join(running);
    const at = yield* Clock.currentTimeMillis;
    return { whole, cut, at, pids };
  });

const recordedLines = (file: string) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0;

const newPaths = (listing: DiffFileFactsListing) => listing.facts.map((fact) => fact.newPath);

describe("a listing the deadline cuts before git printed a file", () => {
  it.effect(
    "answers the range's first files in git's order, cut, never none, at the deadline",
    () =>
      Effect.gen(function* () {
        const { whole, cut, at } = yield* wholeThenCut("wide", 150);
        expect(whole.cut).toBe(false);
        expect(whole.facts).toHaveLength(301);
        expect(at).toBe(DEADLINE_MS);
        expect(cut.cut).toBe(true);
        // a/ whole, then half of b/; c/ and kept.txt past them.
        expect(cut.facts).toEqual(whole.facts.slice(0, 150));
        expect(newPaths(cut)[0]).toBe("a/f000.txt");
        expect(newPaths(cut)[149]).toBe("b/f049.txt");
      }),
  );

  it.effect(
    "counts facts, not paths: moves pair into one fact each and the floor fills past them",
    () =>
      Effect.gen(function* () {
        const { whole, cut } = yield* wholeThenCut("renames", 200, { rounds: 2 });
        expect(whole.facts).toHaveLength(300);
        expect(whole.facts.filter((fact) => fact.status === "renamed")).toHaveLength(100);
        // 200 paths were 100 moves: the walk went on until 200 facts, and the range ran out first.
        expect(cut).toEqual(whole);
      }),
  );

  it.effect("pairs moves under long paths: directories taken whole are one pathspec each", () =>
    Effect.gen(function* () {
      const { whole, cut } = yield* wholeThenCut("long", 200, { rounds: 2 });
      expect(whole.facts).toHaveLength(300);
      expect(whole.facts.filter((fact) => fact.status === "renamed")).toHaveLength(100);
      expect(cut).toEqual(whole);
    }),
  );

  it.effect("shortens a selection past the command line's bound, never splits it", () =>
    Effect.gen(function* () {
      const { whole, cut } = yield* wholeThenCut("flat", 1_500);
      expect(whole.facts).toHaveLength(2_000);
      expect(cut.cut).toBe(true);
      // 1,500 names of 200 bytes pass 256 KiB: the first that fit were listed, whole.
      expect(cut.facts.length).toBeGreaterThan(1_000);
      expect(cut.facts.length).toBeLessThan(1_500);
      expect(cut.facts).toEqual(whole.facts.slice(0, cut.facts.length));
    }),
  );

  it.effect("pairs a move whose sides are both within the first files", () =>
    Effect.gen(function* () {
      const { whole, cut } = yield* wholeThenCut("move", 4);
      expect(whole.facts[0]).toMatchObject({ status: "renamed", oldPath: "z-source.txt" });
      expect(cut).toEqual({ facts: whole.facts, cut: false });
    }),
  );

  it.effect("lists a move whose source lies past the first files as the addition it is there", () =>
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

  it.effect(
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

  it.effect("reaches a name of bytes that are not UTF-8, and a wildcard in a name, literally", () =>
    Effect.gen(function* () {
      const { whole, cut } = yield* wholeThenCut("bytes", 200);
      expect(newPaths(whole)).toEqual(["a-Z.txt", "a-�.txt", "b*.txt"]);
      expect(cut).toEqual({ facts: whole.facts, cut: false });
    }),
  );

  it.effect(
    "answers at the deadline with the files it found when a directory read never returns",
    () =>
      Effect.gen(function* () {
        const { whole, cut, at, pids } = yield* wholeThenCut("directory", 200, {
          held: "ls-tree",
          sequence: ({ heldFifo }) =>
            Effect.gen(function* () {
              yield* writeEnd(heldFifo);
              // The walk's share of the budget ends: the held directory read is stopped, and the
              // root's file, found before it, is listed by path for real.
              yield* TestClock.adjust(DEADLINE_MS / 4);
            }),
        });
        expect(newPaths(whole)).toEqual(["0-first.txt", "a/f.txt"]);
        expect(at).toBe(DEADLINE_MS);
        expect(cut).toEqual({ facts: whole.facts.slice(0, 1), cut: true });
        // Stopped at the deadline: gone once reaped, moments later; one left running stays.
        yield* until(() => recordedPids(pids).every((pid) => !alive(pid)));
      }),
  );

  it.effect(
    "answers at the deadline, with no git left running, when the listing by path never returns",
    () =>
      Effect.gen(function* () {
        const { cut, at, pids } = yield* wholeThenCut("wide", 150, {
          held: "by-path",
          sequence: (held) =>
            Effect.gen(function* () {
              yield* writeEnd(held.heldFifo);
              yield* until(() => recordedPids(held.pids).length === 8);
            }),
        });
        expect(at).toBe(DEADLINE_MS);
        expect(cut).toEqual({ facts: [], cut: true });
        // Each held call was a shell and its child: the deadline stopped both, as one group.
        expect(recordedPids(pids)).toHaveLength(8);
        // Stopped at the deadline: gone once reaped, moments later; one left running stays.
        yield* until(() => recordedPids(pids).every((pid) => !alive(pid)));
      }),
  );
});
