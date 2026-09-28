import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import { BlobStoreFsLive, captureKeys } from "@mend/store";
import { buildManifest, sectionOf, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  CaptureChannel,
  CaptureChannelLive,
  type CaptureRouteError,
  CaptureUploadPolicy,
  resolveCaptureUploadPolicy,
} from "../src/capture-channel.ts";
import { CaptureRemotesOff } from "../src/capture-remotes.ts";
import { CaptureSourcesOff } from "../src/capture-sources.ts";
import { CaptureGitVerifierOff } from "../src/capture-verify.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";

// Review 2026-09-28 (10) #6, cross-repo decision 30: the byte quota limits new work only. Saving
// what an executor already holds — while its session drains, keeps or recovers it, and the
// register of a `final` capture — is never refused for budget; and a new launch starts a ledger
// of its own. A 4,096-byte floor stands in for the 8 GiB one.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-preservation-quota-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const world = (name: string) => {
  const memory = makeMemoryCaptureStore();
  const blobs = BlobStoreFsLive(path.join(scratch, name));
  const channel = CaptureChannelLive.pipe(
    Layer.provide(memory.layer),
    Layer.provide(blobs),
    Layer.provide(CaptureGitVerifierOff),
    Layer.provide(CaptureSourcesOff),
    Layer.provide(CaptureRemotesOff),
    Layer.provide(
      Layer.succeed(CaptureUploadPolicy, {
        ...resolveCaptureUploadPolicy({}),
        byteQuotaFloorBytes: 4_096,
      }),
    ),
  );
  return { memory, layer: Layer.mergeAll(channel, memory.layer, blobs) };
};

/** A route's answer as status and quota fields: 200 when it answered. */
const answer = <A, R>(effect: Effect.Effect<A, CaptureRouteError, R>) =>
  effect.pipe(
    Effect.map(() => ({ status: 200, reason: "ok", used: null, requested: null })),
    Effect.catch((error) =>
      Effect.succeed({
        status: error.status,
        reason: error.reason,
        used: error.used ?? null,
        requested: error.requested ?? null,
      }),
    ),
  );

describe("review 10 #6 byte quotas never refuse preservation", () => {
  it("a drain's upload.urls past the budget is answered, and a new launch starts a ledger of its own", async () => {
    const wt = WorktreeId.make("quota-draining");
    const w = world("cumulative");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CaptureStoreRepo;
        const channel = yield* CaptureChannel;
        yield* repo.init(wt);
        const first = yield* repo.claim(wt, "session", 300, "launch-one");
        const api = (launchId: string, unmetered: boolean) =>
          channel.apiFor({
            worktreeId: wt,
            projectId: ProjectId.make("p"),
            executorId: "session",
            launchId,
            unmetered,
            footprintBytes: 0,
          });
        const ask = (
          launchId: string,
          unmetered: boolean,
          epoch: number,
          key: string,
          size: number,
        ) =>
          answer(
            api(launchId, unmetered).uploadUrls({
              worktree_id: wt,
              epoch,
              keys: [key],
              sizes: { [key]: size },
            }),
          );
        const keys = captureKeys(wt, first.epoch);
        const initial = yield* ask(
          "launch-one",
          false,
          first.epoch,
          keys.pack("a".repeat(64)),
          4_096,
        );
        // New work over the budget is still refused …
        const metered = yield* ask("launch-one", false, first.epoch, keys.pack("b".repeat(64)), 1);
        // … saving what the executor holds is not.
        const drain = yield* ask("launch-one", true, first.epoch, keys.pack("b".repeat(64)), 1);
        const drainMore = yield* ask(
          "launch-one",
          true,
          first.epoch,
          keys.pack("d".repeat(64)),
          50_000,
        );
        yield* repo.release(wt, first.epoch);
        const next = yield* repo.claim(wt, "session", 300, "launch-two");
        const nextKeys = captureKeys(wt, next.epoch);
        // A new launch's new work is priced against its own budget.
        const newLaunch = yield* ask(
          "launch-two",
          false,
          next.epoch,
          nextKeys.pack("c".repeat(64)),
          1,
        );
        const recovering = yield* ask(
          "launch-two",
          true,
          next.epoch,
          nextKeys.pack("e".repeat(64)),
          50_000,
        );
        return { initial, metered, drain, drainMore, newLaunch, recovering };
      }).pipe(Effect.provide(w.layer)),
    );
    expect(result.initial.status).toBe(200);
    expect(result.metered).toEqual({
      status: 413,
      reason: "byte-quota",
      used: 4_096,
      requested: 1,
    });
    expect(result.drain.status).toBe(200);
    expect(result.drainMore.status).toBe(200);
    expect(result.newLaunch.status).toBe(200);
    expect(result.recovering.status).toBe(200);
  });

  it("a final capture over the budget registers, drained or not; a metered turn capture is still refused", async () => {
    const source = path.join(scratch, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "user-generated-work.bin"), crypto.randomBytes(5_000));
    const registerOne = (name: string, kind: "final" | "turn", unmetered: boolean) => {
      const wt = WorktreeId.make(`quota-${name}`);
      const w = world(name);
      return Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* CaptureStoreRepo;
          const channel = yield* CaptureChannel;
          yield* repo.init(wt);
          const held = yield* repo.claim(wt, "session-final", 300, "launch-final");
          const snapshot = snapshotDirectory(source, captureKeys(wt, held.epoch), { format: 2 });
          const built = buildManifest({
            worktreeId: wt,
            epoch: held.epoch,
            n: 0,
            parent: null,
            kind,
            workspace: sectionOf(snapshot),
          });
          yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]]));
          const api = channel.apiFor({
            worktreeId: wt,
            projectId: ProjectId.make("p"),
            executorId: "session-final",
            launchId: "launch-final",
            unmetered,
            footprintBytes: 0,
          });
          const register = yield* answer(
            api.register({
              worktree_id: wt,
              epoch: held.epoch,
              n: 0,
              parent: null,
              capture_id: built.id,
              manifest_key: built.key,
              manifest: built.manifest,
            }),
          );
          const head = yield* repo.headOf(wt);
          return {
            register,
            head: head?.head?.id ?? null,
            id: built.id,
            packRows: w.memory.packs.size,
          };
        }).pipe(Effect.provide(w.layer)),
      );
    };
    const drained = await registerOne("final-drained", "final", true);
    expect(drained.register.status).toBe(200);
    expect(drained.head).toBe(drained.id);
    expect(drained.packRows).toBeGreaterThan(0);
    const undrained = await registerOne("final-undrained", "final", false);
    expect(undrained.register.status).toBe(200);
    expect(undrained.head).toBe(undrained.id);
    const turn = await registerOne("turn-metered", "turn", false);
    expect(turn.register).toMatchObject({ status: 409, reason: "byte-quota" });
    expect(turn.head).toBeNull();
  });
});
