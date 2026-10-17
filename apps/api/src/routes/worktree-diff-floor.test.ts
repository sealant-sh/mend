import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { WorktreeRangeDiff } from "@mend/api-contracts";
import { CheckpointId, SequenceNumber, Sha, WorktreeId } from "@mend/domain";
import { Checkpoint } from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import { Store, StoreConfig } from "@mend/store";
import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Effect, Fiber, Layer, Schema, type Scope } from "effect";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * The range diff route over the real store, its whole listings held as git holds them while it
 * walks a range too wide for the listing deadline (10 s), and one more call held: the root's
 * read, a directory's read, or the floor's listing by path. Each answers at the listing
 * deadline, on the TestClock, never at the route's 20 s: the files found so far with their
 * patches, and no git left running. `worktree-diff.test.ts` covers the byte cap on a real wide
 * range; `worktree-diff-deadline.test.ts` the route's own deadlines over reads that never answer.
 */
const WORKTREE = ids("private-alice").worktree;
const LISTING_DEADLINE_MS = 10_000;
type Held = "diff-tree" | "ls-tree" | "by-path";

const stamped = <A>(value: A) => ({ value, stamp: WORKTREE_STAMP });

const repository = (held: Held) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-diff-floor-"));
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
      git("init", "-qb", "main");
      fs.writeFileSync(path.join(root, "kept.txt"), "kept\n");
      git("add", "--all");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      fs.writeFileSync(path.join(root, "0-first.txt"), "first\n");
      fs.mkdirSync(path.join(root, "a"));
      fs.writeFileSync(path.join(root, "a", "f.txt"), "new\n");
      git("add", "--all");
      git("commit", "-qm", "top");
      const top = git("rev-parse", "HEAD");
      // Whole listing: `git diff …`. Floor listing: `git --no-literal-pathspecs diff … -- …`.
      // The render is `git --literal-pathspecs diff … -- …` and runs for real. A held call keeps
      // the output pipe open from a child of its shell, as git's own children would.
      const hold = (fifo: string) =>
        `{ cat ${JSON.stringify(fifo)} & echo "$$ $!" >> ${JSON.stringify(pids)}; wait; exit 0; }`;
      const heldFlag = held === "by-path" ? "--no-literal-pathspecs" : held;
      fs.writeFileSync(
        path.join(shims, "git"),
        [
          "#!/bin/sh",
          `[ "$1" = diff ] && ${hold(listingFifo)}`,
          `[ "$1" = ${heldFlag} ] && ${hold(heldFifo)}`,
          // A floor listing that runs for real records its end, after its output pipe closes.
          `[ "$1" = --no-literal-pathspecs ] && { ${JSON.stringify(realGit)} "$@"; s=$?; echo end >> ${JSON.stringify(ends)}; exit $s; }`,
          `exec ${JSON.stringify(realGit)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const hostPath = process.env["PATH"];
      process.env["PATH"] = `${shims}${path.delimiter}${hostPath ?? ""}`;
      return { dir, root, listingFifo, heldFifo, pids, ends, base, top, hostPath };
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

const recordedPids = (file: string): ReadonlyArray<number> =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .flatMap((line) => line.split(" ").map(Number))
    : [];

const recordedLines = (file: string) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0;

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

const checkpoint = (ordinal: number, sha: string) =>
  new Checkpoint({
    id: CheckpointId.make(`floor-${ordinal}`),
    worktreeId: WorktreeId.make(WORKTREE),
    sessionId: null,
    ordinal,
    ref: `refs/mend/checkpoints/${WORKTREE}/${ordinal}`,
    sha: Sha.make(sha),
    sealantRunId: null,
    seq: SequenceNumber.make(BigInt(ordinal)),
    trigger: "turn-boundary",
    createdAt: new Date(0),
  });

/**
 * Drives the route with `held` held beside the whole listings. Between the floor's start (half
 * the deadline) and the deadline, `sequence` runs the held call's part; then the harness waits
 * until only the held calls' deadline sleeps remain, so the floor's real git work is done, and
 * advances to the deadline.
 */
const drive = (
  held: Held,
  sequence: (heldFifo: string, pids: string) => Effect.Effect<void, never, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const { root, listingFifo, heldFifo, pids, ends, base, top } = yield* repository(held);
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
    const store = yield* Store.pipe(
      Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root)))),
    );
    const chain = [checkpoint(0, base), checkpoint(1, top)];
    const api = yield* Effect.acquireRelease(
      Effect.promise(() =>
        createTenancyApi(
          {},
          {
            effectClock: counted,
            implement: {
              checkpoints: { listForWorktree: () => Effect.succeed(chain) },
              reads: {
                diffFileFactsBounded: (_project, _worktree, a, b, options) =>
                  store.diffFileFactsBounded(root, a, b, options).pipe(Effect.map(stamped)),
                diffRange: (_project, _worktree, a, b, options) =>
                  store.diffRange(root, a, b, options).pipe(Effect.map(stamped)),
              },
            },
          },
        ),
      ),
      (fixture) => Effect.promise(() => fixture.dispose()),
    );
    const request = yield* Effect.promise(() =>
      api.request("alice", "GET", `/api/worktrees/${WORKTREE}/diff?from=floor-0&to=floor-1`),
    ).pipe(Effect.forkChild);
    yield* writeEnd(listingFifo);
    yield* until(() => recordedPids(pids).length === 4);
    yield* TestClock.adjust(LISTING_DEADLINE_MS / 2);
    yield* sequence(heldFifo, pids);
    // The floor's listings by path have ended (both, when the walk found a file to list), and
    // only the held calls' deadlines still sleep beside the route's own 20 s: the two whole
    // listings', and a held listing by path's two.
    const endsExpected = held === "ls-tree" ? 2 : 0;
    yield* until(
      () => recordedLines(ends) === endsExpected && sleeping.size === (held === "by-path" ? 5 : 3),
    );
    expect(request.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(LISTING_DEADLINE_MS - (yield* Clock.currentTimeMillis));
    const response = yield* Fiber.join(request);
    const at = yield* Clock.currentTimeMillis;
    expect(response.status).toBe(200);
    const answer = Schema.decodeUnknownSync(WorktreeRangeDiff)(
      yield* Effect.promise(() => response.json()),
    );
    // The render ran for real after the listing; the clock did not move for it.
    expect(at).toBe(LISTING_DEADLINE_MS);
    // Stopped at the deadline: gone once reaped, moments later; one left running stays.
    yield* until(() => recordedPids(pids).every((pid) => !alive(pid)));
    return answer;
  });

describe("the range diff route over a store whose listing the deadline cuts", () => {
  it.effect(
    "answers the files found before a directory read stalled, with their patches, at the listing deadline",
    () =>
      Effect.gen(function* () {
        const answer = yield* drive("ls-tree", (heldFifo) =>
          Effect.gen(function* () {
            yield* writeEnd(heldFifo);
            // The walk's share of the budget ends: the held read is stopped, the root's file listed.
            yield* TestClock.adjust(LISTING_DEADLINE_MS / 4);
          }),
        );
        expect(answer.files.map((file) => file.newPath)).toEqual(["0-first.txt"]);
        expect(answer.diff).toContain("+++ b/0-first.txt");
        expect(answer).toMatchObject({ listingCut: true, truncated: true, omitted: [] });
      }),
  );

  it.effect("answers no files at the listing deadline when the root's own read stalls", () =>
    Effect.gen(function* () {
      const answer = yield* drive("diff-tree", (heldFifo) =>
        Effect.gen(function* () {
          yield* writeEnd(heldFifo);
          yield* TestClock.adjust(LISTING_DEADLINE_MS / 4);
        }),
      );
      expect(answer).toMatchObject({ files: [], diff: "", listingCut: true, truncated: true });
    }),
  );

  it.effect(
    "answers at the listing deadline, with no git left running, when the listing by path stalls",
    () =>
      Effect.gen(function* () {
        const answer = yield* drive("by-path", (heldFifo, pids) =>
          Effect.gen(function* () {
            yield* writeEnd(heldFifo);
            yield* until(() => recordedPids(pids).length === 8);
          }),
        );
        expect(answer).toMatchObject({ files: [], diff: "", listingCut: true, truncated: true });
      }),
  );
});
