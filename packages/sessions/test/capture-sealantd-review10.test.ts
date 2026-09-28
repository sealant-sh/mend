import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { WorktreeId } from "@mend/domain";
import {
  type CaptureManifest,
  encodeDirObject,
  isWideTime,
  listCaptureDir,
  sha256Hex,
  verifyWorktreeMeta,
} from "@mend/store";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { CaptureChannel, MANIFEST_FEATURES } from "../src/capture-channel.ts";
import { CaptureSeals, CaptureSealsStoreLive } from "../src/capture-seals.ts";
import { makeCaptureWorld } from "./capture-world.ts";

// sealantd round 10 (4c94bd4; cross-repo decision 29, review 2026-09-28 (10) #1–#2, review 9 #3):
// stores the daemon itself wrote (`fixtures/sealantd-review10`, its generator beside them), each a
// completed, sealed final flush. Mend registers each through the channel's real register — the
// git section verified on the runner, every section walked, the worktree metadata checked against
// the restore's namespace — and the seal stands. The wide-time stores keep every `mtime` exactly,
// and are planned only to an executor that says it reads `wide_times`.
const FIXTURES = path.join(import.meta.dirname, "fixtures", "sealantd-review10");

/** 10,000,000,000 s + 123,456,789 ns after the epoch (2286), and as far before it (1653). */
const AFTER_2262 = 10_000_000_000_123_456_789n;
const BEFORE_1677 = -10_000_000_000_123_456_789n;

const worlds: Array<ReturnType<typeof makeCaptureWorld>> = [];
afterAll(() => {
  for (const world of worlds) fs.rmSync(world.scratch, { recursive: true, force: true });
});

const filesUnder = (root: string): Array<string> =>
  fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? filesUnder(path.join(root, entry.name)) : [path.join(root, entry.name)],
    );

/** Register the fixture's head capture through a fresh world's channel, as its executor. */
const registered = async (name: string) => {
  const root = path.join(FIXTURES, name);
  const head: { readonly manifest_key: string } = JSON.parse(
    fs.readFileSync(path.join(root, "head.json"), "utf8"),
  );
  const bytes = fs.readFileSync(path.join(root, "store", head.manifest_key));
  const manifest: CaptureManifest & {
    readonly final_seal: { readonly executor: string };
  } = JSON.parse(bytes.toString("utf8"));
  const world = makeCaptureWorld();
  worlds.push(world);
  for (const file of filesUnder(path.join(root, "store"))) {
    const key = path.relative(path.join(root, "store"), file);
    const target = path.join(world.blobRoot, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }
  const worktreeId = WorktreeId.make(manifest.worktree_id);
  const executor = manifest.final_seal.executor;
  world.memory.chains.set(worktreeId, {
    headCapture: manifest.parent,
    headN: manifest.n - 1,
    headEpoch: manifest.epoch,
    guard: 0,
  });
  world.memory.leases.set(worktreeId, {
    executorId: executor,
    launchId: executor,
    epoch: manifest.epoch,
    expiresAt: Date.now() + 300_000,
  });
  const scope = Scope.makeUnsafe();
  const context = await Effect.runPromise(
    Layer.build(
      Layer.mergeAll(world.layer, CaptureSealsStoreLive.pipe(Layer.provide(world.layer))),
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof world.layer> | CaptureSeals>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(context)));
  const captureId = sha256Hex(bytes);
  const outcome = await run(
    Effect.gen(function* () {
      const channel = yield* CaptureChannel;
      const api = channel.apiFor({
        worktreeId,
        projectId: world.project.id,
        executorId: executor,
        launchId: executor,
        footprintBytes: 0,
      });
      const answer = yield* api.register({
        worktree_id: worktreeId,
        epoch: manifest.epoch,
        n: manifest.n,
        parent: manifest.parent,
        capture_id: captureId,
        manifest_key: head.manifest_key,
        manifest,
      });
      const row = yield* (yield* CaptureStoreRepo).captureById(captureId);
      const standing = yield* (yield* CaptureSeals).sealedCompletion(
        worktreeId,
        executor,
        manifest.epoch,
      );
      return { answer, gitFsck: row?.gitFsck ?? null, standing };
    }),
  );
  return { world, run, scope, manifest, captureId, worktreeId, outcome };
};

describe("sealantd round 10 stores register and stand", () => {
  for (const name of ["nested-linked-worktree", "nested-alternate", "wide-after", "wide-before"]) {
    it(`${name}: recorded, verified, standing`, async () => {
      const { outcome, captureId, manifest, scope } = await registered(name);
      try {
        expect(outcome.answer.head_n).toBe(manifest.n);
        expect(outcome.answer.seal).toEqual({ state: "recorded" });
        expect(outcome.gitFsck).toBe("verified");
        expect(outcome.standing?.captureId).toBe(captureId);
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
    });
  }

  it("a linked worktree's admin rides the workspace class, its index included", async () => {
    const { run, manifest, scope } = await registered("nested-linked-worktree");
    try {
      const admin = await run(listCaptureDir(manifest, "workspace", ".git/worktrees/child"));
      expect(admin?.map((entry) => entry.name)).toEqual(expect.arrayContaining(["HEAD", "index"]));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});

describe("wide times (sealantd `wide_times`)", () => {
  for (const [name, at] of [
    ["wide-after", AFTER_2262],
    ["wide-before", BEFORE_1677],
  ] as const) {
    it(`${name}: every mtime is kept exactly, and the head is planned only to an executor that reads wide_times`, async () => {
      const { world, run, manifest, worktreeId, captureId, scope } = await registered(name);
      try {
        const read = await run(
          Effect.gen(function* () {
            const ignored = yield* listCaptureDir(manifest, "workspace", "tree/ignored");
            const bulk = yield* listCaptureDir(manifest, "bulk", "node_modules/pkg");
            const meta = yield* verifyWorktreeMeta(manifest.sections.workspace);
            return { ignored, bulk, meta };
          }),
        );
        const future = read.ignored?.find((entry) => entry.name === "future.txt");
        const dir = read.ignored?.find((entry) => entry.name === "dir");
        const bulk = read.bulk?.find((entry) => entry.name === "index.js");
        const tracked = read.meta?.entries.find((entry) => entry.path === "a");
        for (const entry of [future, dir, bulk, tracked]) {
          expect(entry?.mtime).toBe(at);
          expect(isWideTime(entry?.mtime ?? 0)).toBe(true);
        }
        // Written back as the same digits: never a double, never clamped.
        expect(Buffer.from(encodeDirObject(read.ignored ?? [])).toString()).toContain(
          `"mtime":${at.toString()}`,
        );
        // Planned: refused to an executor that does not list `wide_times`, before any claim;
        // answered to one that does.
        const plans = await run(
          Effect.gen(function* () {
            const repo = yield* CaptureStoreRepo;
            yield* repo.release(worktreeId, manifest.epoch);
            const reader = (yield* CaptureChannel).apiFor({
              worktreeId,
              projectId: world.project.id,
              executorId: "reader",
              launchId: "reader",
              footprintBytes: 0,
            });
            const refused = yield* reader
              .planGet({
                epoch: 0,
                manifest_format: 2,
                manifest_features: MANIFEST_FEATURES.filter((feature) => feature !== "wide_times"),
              })
              .pipe(Effect.flip);
            const lease = yield* repo.leaseOf(worktreeId);
            const plan = yield* reader.planGet({
              epoch: 0,
              manifest_format: 2,
              manifest_features: [...MANIFEST_FEATURES],
            });
            return { refused, lease, plan };
          }),
        );
        expect(plans.refused.status).toBe(409);
        expect(plans.refused.reason).toBe("manifest-features");
        expect(plans.refused.missing).toEqual(["wide_times"]);
        expect(plans.lease?.live).toBe(false);
        expect(plans.plan.head?.capture_id).toBe(captureId);
        expect(plans.plan.manifest_features).toEqual(MANIFEST_FEATURES);
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }
    });
  }

  it("the signed 64-bit edges are not wide; one past them is", () => {
    const max = 2n ** 63n - 1n;
    const min = -(2n ** 63n);
    expect([max, min, 0n].map(isWideTime)).toEqual([false, false, false]);
    expect([max + 1n, min - 1n].map(isWideTime)).toEqual([true, true]);
  });
});
