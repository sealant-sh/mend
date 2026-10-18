import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo, WorktreesRepo, WorktreeNotFoundError, type CaptureRow } from "@mend/db";
import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import { Worktree } from "@mend/domain/workbench";
import {
  CaptureRuntimeLive,
  SessionRepository,
  SessionRepositoryCapturedLive,
  WorktreeReadsCapturedLive,
  WorktreeReads,
  CaptureChannel,
  stampOf,
  WORKTREE_STAMP,
} from "@mend/sessions";
import {
  makeCaptureWorld,
  newWorktreeId,
  packEditedTree,
  worktreeRowFor,
  sh,
  makeMemoryCaptureStore,
} from "@mend/sessions/testing";
import {
  BlobStore,
  BlobNotFoundError,
  BlobStoreError,
  WORKTREE_TREE_REF,
  changeSummaryKey,
  decodeChangeSummary,
  decodeManifest,
  observedChangeSummaryKey,
  type ChangeSummary,
} from "@mend/store";
import { buildManifest, uploadObjects } from "@mend/store/testing";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { SummaryObserver, SummaryObserverLive } from "../src/summary-observe.ts";

/**
 * The observed pass (ADR-0002 "Review"): a posted summary is `claimed` until a runner recomputes
 * it from the head capture's git class. Agreement stamps it; disagreement replaces it with what
 * the runner observed and stamps that.
 */
describe("summary-observe", () => {
  const world = makeCaptureWorld();
  const runtime = CaptureRuntimeLive.pipe(Layer.provide(world.layer));
  const reads = WorktreeReadsCapturedLive.pipe(Layer.provide(world.layer));
  const layer = Layer.mergeAll(
    SummaryObserverLive.pipe(
      Layer.provide(runtime),
      Layer.provide(reads),
      Layer.provide(world.layer),
    ),
    SessionRepositoryCapturedLive.pipe(Layer.provide(world.layer)),
    reads,
    world.layer,
  );
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      SummaryObserver | SessionRepository | CaptureStoreRepo | BlobStore | WorktreeReads
    >,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
  afterAll(() => {
    fs.rmSync(world.scratch, { recursive: true, force: true });
  });

  it("stamps an agreeing summary observed, replaces a disagreeing one, and skips a stale capture", async () => {
    const worktreeId = newWorktreeId();
    const branch = `mend/wt/${worktreeId}`;
    world.worktrees.set(worktreeId, worktreeRowFor(world, worktreeId, branch));
    // Capture 0, then an executor capture with one edit and a posted summary for it.
    const epoch = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRepository;
        yield* repo.createWorktree(
          world.project.id,
          { directory: worktreeId, branch },
          { kind: "base", base: null },
          null,
        );
        yield* repo.attachWorktree!(world.project.id, worktreeId);
        const captures = yield* CaptureStoreRepo;
        return (yield* captures.claim(worktreeId, "executor")).epoch;
      }),
    );
    const cap0 = world.memory.chains.get(worktreeId)?.headCapture ?? "";
    const row0 = world.memory.captures.get(cap0);
    if (row0 === undefined) throw new Error("capture zero must exist");
    const manifest0 = await Effect.runPromise(
      decodeManifest(
        row0.manifestKey,
        fs.readFileSync(path.join(world.blobRoot, row0.manifestKey)),
      ),
    );
    const basePack = manifest0.sections.git.packs[0];
    if (basePack === undefined) throw new Error("capture zero must include its base pack");
    const edited = packEditedTree(world.work, worktreeId, epoch, world.baseSha, (dir) => {
      fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    });
    const cap1 = buildManifest({
      worktreeId,
      n: 1,
      parent: cap0,
      epoch,
      seq: 5,
      kind: "checkpoint",
      git: {
        packs: [basePack, edited.key],
        refs: { [`refs/heads/${branch}`]: world.baseSha, [WORKTREE_TREE_REF]: edited.tree },
        head: `refs/heads/${branch}`,
        fsck: "verified",
      },
    });
    const expected = {
      base_sha: world.baseSha,
      files: [{ path: "a.txt", additions: 1, deletions: 0 }],
      diff: sh(world.work, [
        "-c",
        "color.ui=false",
        "diff",
        "--no-ext-diff",
        world.baseSha,
        edited.tree,
      ]),
    };
    const postSummary = (summary: unknown) =>
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        const key = changeSummaryKey(worktreeId, 1);
        yield* blobs.put(key, new Uint8Array(Buffer.from(JSON.stringify(summary), "utf8")));
        const captures = yield* CaptureStoreRepo;
        yield* captures.acceptSummary(worktreeId, cap1.id, key);
        return key;
      });
    const observedDiff = await run(
      Effect.gen(function* () {
        yield* uploadObjects(new Map([...edited.objects, [cap1.key, cap1.bytes]]));
        const captures = yield* CaptureStoreRepo;
        yield* captures.register({
          worktreeId,
          id: cap1.id,
          n: 1,
          parent: cap0,
          epoch,
          seq: 5n,
          kind: "checkpoint",
          manifestKey: cap1.key,
          sections: cap1.manifest.sections,
          gitFsck: "verified",
        });
        // A wrong claim first: the executor said it also touched keep.md.
        yield* postSummary({
          base_sha: world.baseSha,
          files: [
            { path: "a.txt", additions: 1, deletions: 0 },
            { path: "keep.md", additions: 3, deletions: 0 },
          ],
          diff: "not what the runner sees",
        });
        const observer = yield* SummaryObserver;
        const outcome = yield* observer.observe({ worktreeId, captureId: cap1.id });
        expect(outcome).toEqual({ outcome: "observed", agreed: false });
        const blobs = yield* BlobStore;
        const summary = yield* captures.summaryOf(cap1.id);
        if (summary === null) throw new Error("published summary row must exist");
        const expectedBytes = new Uint8Array(Buffer.from(JSON.stringify(expected)));
        expect(summary.key).toBe(observedChangeSummaryKey(worktreeId, 1, expectedBytes));
        expect(yield* blobs.get(summary.key)).toEqual(expectedBytes);
        const stored = yield* decodeChangeSummary(
          JSON.parse(Buffer.from(yield* blobs.get(summary.key)).toString("utf8")),
        );
        return stored;
      }),
    );
    expect(world.memory.summaries.get(cap1.id)?.state).toBe("observed");
    expect(observedDiff).toEqual(expected);
    // An agreeing claim still gets an immutable observed object; its canonical bytes stay intact.
    const agreed = await run(
      Effect.gen(function* () {
        yield* postSummary(expected);
        expect(world.memory.summaries.get(cap1.id)?.state).toBe("claimed");
        const observer = yield* SummaryObserver;
        return yield* observer.observe({ worktreeId, captureId: cap1.id });
      }),
    );
    expect(agreed).toEqual({ outcome: "observed", agreed: true });
    expect(world.memory.summaries.get(cap1.id)?.state).toBe("observed");
    // A summary for a capture that is no longer the head is left alone.
    const stale = await run(
      Effect.gen(function* () {
        const observer = yield* SummaryObserver;
        return yield* observer.observe({ worktreeId, captureId: cap0 });
      }),
    );
    expect(stale).toEqual({
      outcome: "skipped",
      reason: "the capture is no longer the chain head",
    });
    await run(
      Effect.gen(function* () {
        const captures = yield* CaptureStoreRepo;
        yield* captures.setGitFsck(cap1.id, "failed");
        const postedKey = yield* postSummary(expected);
        const reader = yield* WorktreeReads;
        const oldDiff = yield* reader.diffWorktree(world.project.id, worktreeId, world.baseSha);
        const oldFiles = yield* reader.changedFiles(world.project.id, worktreeId, world.baseSha);
        expect(oldDiff.stamp.captureId).toBe(cap0);
        expect(oldFiles.stamp.captureId).toBe(cap0);
        expect(oldDiff.value).toBe("");
        expect(oldFiles.value).toEqual([]);
        expect(yield* (yield* SummaryObserver).observe({ worktreeId, captureId: cap1.id })).toEqual(
          { outcome: "skipped", reason: "the capture's Git section failed verification" },
        );
        expect(yield* captures.summaryOf(cap1.id)).toMatchObject({
          key: postedKey,
          state: "claimed",
        });
        expect(yield* (yield* BlobStore).get(postedKey)).toEqual(
          new Uint8Array(Buffer.from(JSON.stringify(expected))),
        );
      }),
    );
  });
});

const unusedChannel = () => {
  throw new Error("summary observation never uses the executor channel");
};

/** Mutable external pointers are faithful; only the Git read answers are scripted. */
const observationHarness = () => {
  const worktree = new Worktree({
    id: WorktreeId.make("summary-worktree"),
    projectId: ProjectId.make("summary-project"),
    name: "summary",
    directory: "summary",
    branch: "mend/summary",
    baseSha: Sha.make("a".repeat(40)),
    baseRef: "main",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const state = {
    base: worktree.baseSha,
    gone: false,
    afterDiff: () => {},
    afterFiles: () => {},
    beforePut: () => {},
    failPut: false,
  };
  const memory = makeMemoryCaptureStore(() => (state.gone ? null : state.base));
  const row: CaptureRow = {
    id: "capture-1",
    worktreeId: worktree.id,
    n: 1,
    parent: null,
    epoch: 1,
    seq: 5n,
    kind: "checkpoint",
    manifestKey: "manifest",
    sections: {},
    gitFsck: "verified",
    createdAt: new Date(0),
  };
  memory.captures.set(row.id, row);
  memory.chains.set(worktree.id, { headCapture: row.id, headN: row.n, headEpoch: row.epoch });
  const expected: ChangeSummary = {
    base_sha: worktree.baseSha,
    files: [{ path: "source.ts", additions: 2, deletions: 1 }],
    diff: "-previous\n+observed\n+evidence\n",
  };
  const bucket = new Map<string, Uint8Array>();
  const canonical = changeSummaryKey(worktree.id, row.n);
  const post = (summary: ChangeSummary) => {
    bucket.set(canonical, new Uint8Array(Buffer.from(JSON.stringify(summary))));
    memory.summaries.set(row.id, {
      captureId: row.id,
      worktreeId: worktree.id,
      key: canonical,
      state: "claimed",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  };
  post(expected);
  const stamps = { diff: stampOf(row), files: stampOf(row) };
  const reads: string[] = [];
  const writes: Array<{ key: string; bytes: Uint8Array; ifAbsent: boolean }> = [];
  const bytesAtPublication: Array<Uint8Array | undefined> = [];
  const publications: Array<{
    input: Parameters<CaptureStoreRepo["Service"]["publishObservedSummary"]>[0];
    accepted: boolean;
  }> = [];
  const repo = Layer.effect(
    CaptureStoreRepo,
    Effect.map(CaptureStoreRepo, (underlying) => ({
      ...underlying,
      publishObservedSummary: (
        input: Parameters<CaptureStoreRepo["Service"]["publishObservedSummary"]>[0],
      ) =>
        Effect.suspend(() => {
          const bytes = bucket.get(input.key);
          bytesAtPublication.push(bytes === undefined ? undefined : new Uint8Array(bytes));
          return underlying.publishObservedSummary(input);
        }).pipe(
          Effect.tap((accepted) =>
            Effect.sync(() => {
              publications.push({ input, accepted });
            }),
          ),
        ),
    })),
  ).pipe(Layer.provide(memory.layer));
  const blobs = Layer.mock(BlobStore, {
    identity: "summary-observe-test",
    get: (key) =>
      Effect.suspend(() => {
        const bytes = bucket.get(key);
        return bytes === undefined
          ? Effect.fail(new BlobNotFoundError({ key }))
          : Effect.succeed(new Uint8Array(bytes));
      }),
    put: (key, body, options) =>
      Effect.suspend((): Effect.Effect<{ written: boolean }, BlobStoreError> => {
        if (!(body instanceof Uint8Array)) return Effect.die("summary put must supply bytes");
        state.beforePut();
        if (state.failPut)
          return Effect.fail(
            new BlobStoreError({ operation: "put", key, cause: "injected outage" }),
          );
        writes.push({ key, bytes: new Uint8Array(body), ifAbsent: options?.ifAbsent === true });
        if (options?.ifAbsent === true && bucket.has(key))
          return Effect.succeed({ written: false });
        bucket.set(key, new Uint8Array(body));
        return Effect.succeed({ written: true });
      }),
  });
  const runtime = CaptureRuntimeLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        repo,
        blobs,
        Layer.mock(CaptureChannel, {
          apiFor: unusedChannel,
          standbyApiFor: unusedChannel,
          publish: unusedChannel,
        }),
      ),
    ),
  );
  const layer = SummaryObserverLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtime,
        Layer.mock(WorktreesRepo, {
          byId: () =>
            state.gone
              ? Effect.fail(new WorktreeNotFoundError({ id: worktree.id }))
              : Effect.succeed(worktree),
        }),
        Layer.mock(WorktreeReads, {
          diffWorktree: () =>
            Effect.sync(() => {
              reads.push("diff");
              const value = { value: expected.diff, stamp: { ...stamps.diff } };
              state.afterDiff();
              return value;
            }),
          changedFiles: () =>
            Effect.sync(() => {
              reads.push("files");
              const value = { value: expected.files, stamp: { ...stamps.files } };
              state.afterFiles();
              return value;
            }),
        }),
      ),
    ),
  );
  const observe = () =>
    Effect.runPromise(
      Effect.flatMap(SummaryObserver, (observer) =>
        observer.observe({ worktreeId: worktree.id, captureId: row.id }),
      ).pipe(Effect.provide(layer)),
    );
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(expected)));
  const key = `changes/${worktree.id}/1/observed-${createHash("sha256").update(bytes).digest("hex")}.json`;
  return {
    worktree,
    state,
    memory,
    row,
    expected,
    bucket,
    canonical,
    post,
    stamps,
    reads,
    writes,
    publications,
    bytesAtPublication,
    observe,
    layer,
    bytes,
    key,
  };
};

describe("summary observation provenance and publication", () => {
  for (const mismatch of ["base", "files", "path", "additions", "deletions", "diff"]) {
    it(`replaces a ${mismatch}-only disagreement with exact immutable recomputed bytes`, async () => {
      const h = observationHarness();
      const claimed = { ...h.expected, files: [...h.expected.files] };
      if (mismatch === "base") claimed.base_sha = "wrong-base";
      if (mismatch === "files") claimed.files = [];
      if (mismatch === "path") claimed.files = [{ path: "other.ts", additions: 2, deletions: 1 }];
      if (mismatch === "additions")
        claimed.files = [{ path: "source.ts", additions: 3, deletions: 1 }];
      if (mismatch === "deletions")
        claimed.files = [{ path: "source.ts", additions: 2, deletions: 2 }];
      if (mismatch === "diff") claimed.diff = "+different\n";
      h.post(claimed);
      const claimedBytes = h.bucket.get(h.canonical);
      expect(await h.observe()).toEqual({ outcome: "observed", agreed: false });
      expect(h.reads).toEqual(["diff", "files"]);
      expect(h.writes).toEqual([{ key: h.key, bytes: h.bytes, ifAbsent: true }]);
      expect(h.publications).toEqual([
        {
          input: {
            worktreeId: h.worktree.id,
            captureId: h.row.id,
            baseSha: h.worktree.baseSha,
            key: h.key,
          },
          accepted: true,
        },
      ]);
      expect(h.memory.summaries.get(h.row.id)).toMatchObject({ key: h.key, state: "observed" });
      expect(h.bytesAtPublication).toEqual([h.bytes]);
      expect(h.bucket.get(h.key)).toEqual(h.bytes);
      expect(h.bucket.get(h.canonical)).toEqual(claimedBytes);
    });
  }

  for (const kind of ["verified", "unverified", "partial-auto"]) {
    it(`observes matching ${kind} capture reads without promoting a full-fsck claim`, async () => {
      const h = observationHarness();
      const row: CaptureRow = {
        ...h.row,
        gitFsck: kind === "unverified" ? "unverified" : "verified",
        kind: kind === "partial-auto" ? "auto" : "checkpoint",
      };
      h.memory.captures.set(row.id, row);
      h.stamps.diff = stampOf(row);
      h.stamps.files = stampOf(row);
      expect(await h.observe()).toEqual({ outcome: "observed", agreed: true });
      expect(h.reads).toEqual(["diff", "files"]);
      expect(h.bytesAtPublication).toEqual([h.bytes]);
      expect(h.bucket.get(h.key)).toEqual(h.bytes);
      expect(h.memory.summaries.get(row.id)).toMatchObject({ key: h.key, state: "observed" });
      expect(h.memory.captures.get(row.id)?.gitFsck).toBe(row.gitFsck);
    });
  }

  for (const changed of [
    "older",
    "newer",
    "mixed",
    "live",
    "mixed-live",
    "n",
    "seq",
    "kind",
    "partial",
    "time",
  ]) {
    it(`leaves claimed bytes alone for ${changed} read provenance`, async () => {
      const h = observationHarness();
      if (changed === "older")
        h.stamps.diff = h.stamps.files = { ...stampOf(h.row), captureId: "capture-0", captureN: 0 };
      if (changed === "newer")
        h.stamps.diff = h.stamps.files = { ...stampOf(h.row), captureId: "capture-2", captureN: 2 };
      if (changed === "mixed")
        h.state.afterDiff = () => {
          h.stamps.files = { ...stampOf(h.row), captureId: "capture-2", captureN: 2 };
        };
      if (changed === "live") h.stamps.diff = h.stamps.files = WORKTREE_STAMP;
      if (changed === "mixed-live") h.stamps.files = WORKTREE_STAMP;
      if (changed === "n") h.stamps.files = { ...stampOf(h.row), captureN: 99 };
      if (changed === "seq") h.stamps.files = { ...stampOf(h.row), seq: "99" };
      if (changed === "kind") h.stamps.files = { ...stampOf(h.row), kind: "final" };
      if (changed === "partial") h.stamps.files = { ...stampOf(h.row), partial: true };
      if (changed === "time")
        h.stamps.files = { ...stampOf(h.row), observedAt: new Date(1).toISOString() };
      expect(await h.observe()).toEqual({
        outcome: "skipped",
        reason: "the reads do not belong to the job capture",
      });
      expect(h.reads).toEqual(["diff", "files"]);
      expect(h.writes).toEqual([]);
      expect(h.publications).toEqual([]);
      expect(h.memory.summaries.get(h.row.id)).toMatchObject({
        key: h.canonical,
        state: "claimed",
      });
      expect(h.bucket.get(h.canonical)).toEqual(h.bytes);
    });
  }

  for (const changed of [
    "head",
    "fsck",
    "base",
    "summary-gone",
    "worktree-gone",
    "another-publisher",
  ]) {
    it(`reports skipped when ${changed} invalidates publication after matching reads`, async () => {
      const h = observationHarness();
      h.state.beforePut = () => {
        if (changed === "head")
          h.memory.chains.set(h.worktree.id, { headCapture: "capture-2", headN: 2, headEpoch: 1 });
        if (changed === "fsck") h.memory.captures.set(h.row.id, { ...h.row, gitFsck: "failed" });
        if (changed === "base") h.state.base = Sha.make("b".repeat(40));
        if (changed === "summary-gone") h.memory.summaries.delete(h.row.id);
        if (changed === "worktree-gone") h.state.gone = true;
        if (changed === "another-publisher") {
          const row = h.memory.summaries.get(h.row.id);
          if (row === undefined) throw new Error("claim missing");
          h.memory.summaries.set(h.row.id, { ...row, state: "observed", key: "winner" });
        }
      };
      expect(await h.observe()).toEqual({
        outcome: "skipped",
        reason: "the summary changed before publication",
      });
      expect(h.reads).toEqual(["diff", "files"]);
      expect(h.publications).toEqual([
        {
          input: {
            worktreeId: h.worktree.id,
            captureId: h.row.id,
            baseSha: h.worktree.baseSha,
            key: h.key,
          },
          accepted: false,
        },
      ]);
      expect(h.bucket.get(h.canonical)).toEqual(h.bytes);
      expect(h.bytesAtPublication).toEqual([h.bytes]);
      expect(h.bucket.get(h.key)).toEqual(h.bytes);
      if (changed === "summary-gone") expect(h.memory.summaries.get(h.row.id)).toBeUndefined();
      else
        expect(h.memory.summaries.get(h.row.id)).toMatchObject({
          key: changed === "another-publisher" ? "winner" : h.canonical,
          state: changed === "another-publisher" ? "observed" : "claimed",
        });
    });
  }

  it("keeps a concurrently reposted claim separate from observed bytes, including after publication", async () => {
    const h = observationHarness();
    const repost = { ...h.expected, diff: "+not recomputed\n" };
    h.state.afterFiles = () => h.post(repost);
    expect(await h.observe()).toEqual({ outcome: "observed", agreed: true });
    expect(h.memory.summaries.get(h.row.id)).toMatchObject({ key: h.key, state: "observed" });
    expect(h.bucket.get(h.key)).toEqual(h.bytes);
    expect(h.bucket.get(h.canonical)).toEqual(new Uint8Array(Buffer.from(JSON.stringify(repost))));
    h.post({ ...repost, diff: "+later claim\n" });
    expect(h.memory.summaries.get(h.row.id)).toMatchObject({ key: h.canonical, state: "claimed" });
    expect(h.bucket.get(h.key)).toEqual(h.bytes);
  });

  it("never publishes observed state when persisting immutable bytes fails", async () => {
    const h = observationHarness();
    h.state.failPut = true;
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.flatMap(SummaryObserver, (observer) =>
          observer.observe({ worktreeId: h.worktree.id, captureId: h.row.id }),
        ),
      ).pipe(Effect.provide(h.layer)),
    );
    if (!Exit.isFailure(exit)) throw new Error("failed persistence must fail the job");
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(h.publications).toEqual([]);
    expect(h.memory.summaries.get(h.row.id)).toMatchObject({ key: h.canonical, state: "claimed" });
    expect(h.bucket.get(h.canonical)).toEqual(h.bytes);
    expect(h.bucket.has(h.key)).toBe(false);
  });
});
