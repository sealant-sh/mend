import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { ProjectId } from "@mend/domain";
import { Session } from "@mend/domain/workbench";
import { SessionEngine, startFromBase } from "@mend/sessions";
import { BlobStore, skippedFreshen, Store, type AdmittedHandoff } from "@mend/store";
import { buildHandoffBundle, sh } from "@mend/store/testing";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import {
  freeLaunchSlot,
  sealantLaunchLayer,
  setup,
  withEngine,
  type World,
} from "./engine/fixture.ts";

const checkoutIn = (tmp: string) => {
  const checkout = path.join(tmp, "checkout");
  sh(tmp, ["clone", "-q", path.join(tmp, "origin"), checkout]);
  sh(checkout, ["checkout", "-q", "-b", "fix/login"]);
  fs.writeFileSync(path.join(checkout, "login.ts"), "export const login = () => true;\n");
  sh(checkout, ["add", "-A"]);
  sh(checkout, ["commit", "-q", "-m", "login"]);
  fs.writeFileSync(path.join(checkout, "notes.txt"), "untracked\n");
  return checkout;
};

const admitIn = (storePath: string, bytes: Uint8Array) =>
  Effect.flatMap(Store, (store) =>
    store.admitHandoff(storePath, "main", bytes, {
      freshen: Effect.succeed(skippedFreshen("no credential in this test")),
      fileBytes: 0,
    }),
  );

const provisionHandoff = (
  projectId: string,
  name: string,
  admitted: AdmittedHandoff,
  owner = "user-fixture",
) =>
  Effect.flatMap(SessionEngine, (engine) =>
    engine.provision({
      projectId: ProjectId.make(projectId),
      harness: "codex",
      label: null,
      name,
      start: { kind: "handoff", admitted, ownerUserId: owner, previous: null },
      ownerUserId: owner,
    }),
  );

const checkpointsOf = (world: World, worktreeId: string) =>
  world.checkpoints
    .filter((checkpoint) => checkpoint.worktreeId === worktreeId)
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .map((checkpoint) => [checkpoint.ordinal, checkpoint.sha]);

/** What a crash right after the worktree row leaves: the row, and nothing it should own. */
const crashAfterRow = (world: World, memory: MemoryCaptureStore, session: Session) => {
  const worktreeId = session.worktreeId;
  world.sessions.delete(session.id);
  world.checkpoints.splice(
    0,
    world.checkpoints.length,
    ...world.checkpoints.filter((checkpoint) => checkpoint.worktreeId !== worktreeId),
  );
  for (const [id, change] of world.changes) {
    if (change.worktreeId === worktreeId) world.changes.delete(id);
  }
  memory.chains.delete(worktreeId);
  memory.leases.delete(worktreeId);
  for (const [id, capture] of memory.captures) {
    if (capture.worktreeId === worktreeId) memory.captures.delete(id);
  }
};

/** Blobs whose next manifest put, once `armed`, waits on `go` after saying so on `held`. */
const holdingManifests =
  (
    armed: () => boolean,
    arm: (held: boolean) => void,
    held: Deferred.Deferred<void>,
    go: Deferred.Deferred<void>,
  ) =>
  (base: Layer.Layer<BlobStore>): Layer.Layer<BlobStore> =>
    Layer.effect(
      BlobStore,
      Effect.gen(function* () {
        const inner = yield* BlobStore;
        return {
          ...inner,
          put: (key, bytes, options) =>
            Effect.suspend(() => {
              if (!armed() || !key.includes("/manifests/")) return inner.put(key, bytes, options);
              arm(false);
              return Deferred.succeed(held, undefined).pipe(
                Effect.andThen(Deferred.await(go)),
                Effect.andThen(inner.put(key, bytes, options)),
              );
            }),
        };
      }),
    ).pipe(Layer.provide(base));

describe("SessionEngine handoff", () => {
  it("anchors Review at the base: ordinal 0 is M, the session-start and the next checkpoint are W, the change's base is M", async () => {
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const bundle = buildHandoffBundle(checkoutIn(tmp));
          const admitted = yield* admitIn(project.storePath, bundle.bytes);
          const session = yield* provisionHandoff(project.id, "fix-login", admitted);
          const engine = yield* SessionEngine;
          const opened = yield* engine.checkpointNow(session.id, "review-open");
          expect(checkpointsOf(world, session.worktreeId)).toEqual([
            [0, bundle.mergeBase],
            [1, bundle.checkpoint],
            [2, bundle.checkpoint],
          ]);
          expect(opened.sha).toBe(bundle.checkpoint);
          const change = [...world.changes.values()].find(
            (candidate) => candidate.worktreeId === session.worktreeId,
          );
          expect(change?.baseSha).toBe(bundle.mergeBase);
          expect(memory.chains.get(session.worktreeId)?.headN).toBe(0);
        }),
      { captured: memory },
    );
  });

  it("finishes, once, a creation that died after its row when the next session is provisioned in it", async () => {
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const bundle = buildHandoffBundle(checkoutIn(tmp));
          const admitted = yield* admitIn(project.storePath, bundle.bytes);
          const first = yield* provisionHandoff(project.id, "fix-login", admitted);
          const worktreeId = first.worktreeId;
          crashAfterRow(world, memory, first);
          const engine = yield* SessionEngine;
          const replayed = yield* engine.provisionSessionIn(worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(replayed.worktreeId).toBe(worktreeId);
          expect(memory.chains.get(worktreeId)?.headN).toBe(0);
          expect(checkpointsOf(world, worktreeId)).toEqual([
            [0, bundle.mergeBase],
            [1, bundle.checkpoint],
          ]);
          const changes = [...world.changes.values()].filter(
            (change) => change.worktreeId === worktreeId,
          );
          expect(changes.map((change) => change.baseSha)).toEqual([bundle.mergeBase]);
          yield* engine.provisionSessionIn(worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(checkpointsOf(world, worktreeId)).toEqual([
            [0, bundle.mergeBase],
            [1, bundle.checkpoint],
            [2, bundle.checkpoint],
          ]);
          expect(
            [...world.changes.values()].filter((change) => change.worktreeId === worktreeId),
          ).toHaveLength(1);
        }),
      { captured: memory },
    );
  });

  it("finishes a creation that died after its row when a named join (`mend claude --worktree <name>`) is the next session in it", async () => {
    const memory = makeMemoryCaptureStore();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const bundle = buildHandoffBundle(checkoutIn(tmp));
          const admitted = yield* admitIn(project.storePath, bundle.bytes);
          const first = yield* provisionHandoff(project.id, "fix-login", admitted);
          crashAfterRow(world, memory, first);
          const engine = yield* SessionEngine;
          const joined = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "fix-login",
            start: startFromBase(null),
            ownerUserId: "user-fixture",
          });
          expect(joined.worktreeId).toBe(first.worktreeId);
          expect(memory.chains.get(first.worktreeId)?.headN).toBe(0);
          expect(checkpointsOf(world, first.worktreeId)).toEqual([
            [0, bundle.mergeBase],
            [1, bundle.checkpoint],
          ]);
          expect(
            [...world.changes.values()]
              .filter((change) => change.worktreeId === first.worktreeId)
              .map((change) => change.baseSha),
          ).toEqual([bundle.mergeBase]);
        }),
      { captured: memory },
    );
  });

  it("finishes a creation two callers race to finish once: capture 0, checkpoint 0 and the change are made once, and both get a session", async () => {
    const memory = makeMemoryCaptureStore();
    const manifestHeld = Effect.runSync(Deferred.make<void>());
    const manifestGo = Effect.runSync(Deferred.make<void>());
    let holdManifest = false;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const bundle = buildHandoffBundle(checkoutIn(tmp));
          const admitted = yield* admitIn(project.storePath, bundle.bytes);
          const first = yield* provisionHandoff(project.id, "fix-login", admitted);
          const worktreeId = first.worktreeId;
          crashAfterRow(world, memory, first);
          const engine = yield* SessionEngine;
          const next = engine.provisionSessionIn(worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          holdManifest = true;
          const creator = yield* Effect.forkChild(next);
          yield* Deferred.await(manifestHeld);
          const joiner = yield* Effect.forkChild(next);
          yield* Effect.sleep("200 millis");
          yield* Deferred.succeed(manifestGo, undefined);
          expect((yield* Fiber.join(creator)).worktreeId).toBe(worktreeId);
          expect((yield* Fiber.join(joiner)).worktreeId).toBe(worktreeId);
          expect(memory.chains.get(worktreeId)?.headN).toBe(0);
          expect(
            [...memory.captures.values()].filter((capture) => capture.worktreeId === worktreeId),
          ).toHaveLength(1);
          expect(checkpointsOf(world, worktreeId)).toEqual([
            [0, bundle.mergeBase],
            [1, bundle.checkpoint],
            [2, bundle.checkpoint],
          ]);
          expect(
            [...world.changes.values()].filter((change) => change.worktreeId === worktreeId),
          ).toHaveLength(1);
        }),
      {
        captured: memory,
        transformBlobs: holdingManifests(
          () => holdManifest,
          (held) => {
            holdManifest = held;
          },
          manifestHeld,
          manifestGo,
        ),
      },
    );
  });

  it("finishes a creation whose capture 0 another caller's claim holds once that claim ends, instead of failing the session", async () => {
    const memory = makeMemoryCaptureStore();
    const claimRefused = Effect.runSync(Deferred.make<void>());
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const bundle = buildHandoffBundle(checkoutIn(tmp));
          const admitted = yield* admitIn(project.storePath, bundle.bytes);
          const first = yield* provisionHandoff(project.id, "fix-login", admitted);
          const worktreeId = first.worktreeId;
          crashAfterRow(world, memory, first);
          memory.chains.set(worktreeId, { headCapture: null, headN: -1, headEpoch: 1 });
          memory.leases.set(worktreeId, {
            executorId: `mend:${worktreeId}`,
            epoch: 1,
            expiresAt: memory.clock.now() + 30_000,
          });
          const engine = yield* SessionEngine;
          const joining = yield* Effect.forkChild(
            engine.provisionSessionIn(worktreeId, {
              harness: "codex",
              label: null,
              ownerUserId: "user-fixture",
            }),
          );
          yield* Deferred.await(claimRefused);
          // The other caller gives its claim back without capture 0 (a request that died).
          const held = memory.leases.get(worktreeId);
          if (held !== undefined) {
            held.executorId = null;
            held.expiresAt = memory.clock.now();
          }
          expect((yield* Fiber.join(joining)).worktreeId).toBe(worktreeId);
          expect(memory.chains.get(worktreeId)?.headN).toBe(0);
          expect(checkpointsOf(world, worktreeId)).toEqual([
            [0, bundle.mergeBase],
            [1, bundle.checkpoint],
          ]);
        }),
      {
        captured: {
          ...memory,
          layer: Layer.effect(
            CaptureStoreRepo,
            Effect.gen(function* () {
              const inner = yield* CaptureStoreRepo;
              return {
                ...inner,
                claim: (worktreeId, executorId, ttlSeconds, launchId) =>
                  inner
                    .claim(worktreeId, executorId, ttlSeconds, launchId)
                    .pipe(Effect.tapError(() => Deferred.succeed(claimRefused, undefined))),
              };
            }),
          ).pipe(Layer.provide(memory.layer)),
        },
      },
    );
  });

  it("leaves a worktree made before captures to its launch: a session joining it uploads no base pack, and its launch attaches capture 0", async () => {
    const memory = makeMemoryCaptureStore();
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const legacy = yield* engine.ensureWorktree(
            project.id,
            { name: "older", start: startFromBase(null) },
            "user-fixture",
          );
          memory.chains.delete(legacy.id);
          memory.leases.delete(legacy.id);
          for (const [id, capture] of memory.captures) {
            if (capture.worktreeId === legacy.id) memory.captures.delete(id);
          }
          const joined = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: "older",
            start: startFromBase(null),
            ownerUserId: "user-fixture",
          });
          expect(joined.worktreeId).toBe(legacy.id);
          expect(memory.chains.get(legacy.id)?.headCapture ?? null).toBeNull();
          yield* engine.launch(joined.id, ["codex"]);
          expect(memory.chains.get(legacy.id)?.headN).toBe(0);
        }),
      { captured: memory, sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("recovers a handed-off session whose harness never ran by launching it, not by resuming it", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const bundle = buildHandoffBundle(checkoutIn(tmp));
          const admitted = yield* admitIn(project.storePath, bundle.bytes);
          const engine = yield* SessionEngine;
          const refused = yield* provisionHandoff(project.id, "fix-login", admitted);
          world.sessions.set(
            refused.id,
            new Session({
              ...refused,
              status: "failed",
              settledAt: world.clock.now(),
              summary:
                "launch failed: budget reached · 4 launches starting at once for one account",
            }),
          );
          const resumed = yield* engine.resumeSession(refused.id, null).pipe(Effect.result);
          if (Result.isFailure(resumed) && resumed.failure._tag === "HarnessStateNotFoundError") {
            expect(resumed.failure.message).toBe(
              `Saved harness state is missing for session ${refused.id}.`,
            );
          } else {
            expect.unreachable("resume started a session whose harness never ran");
          }
          const launched = yield* engine.launch(refused.id, ["codex", "finish the tests"]);
          expect(launched.status).toBe("running");

          const held = yield* engine.holdWorkspace(
            (yield* provisionHandoff(
              project.id,
              "fix-login-2",
              yield* admitIn(
                project.storePath,
                buildHandoffBundle(path.join(tmp, "checkout"), {
                  cutAt: "2026-10-18T09:00:00.000Z",
                }).bytes,
              ),
            )).id,
            freeLaunchSlot,
          );
          expect(held.status).toBe("idle");
          const agent = yield* engine.launch(held.id, ["codex", "finish the tests"]);
          expect(agent.status).toBe("running");
          expect(
            [...world.processes.values()]
              .filter((process) => process.sessionId === held.id && process.exitedAt === null)
              .map((process) => process.kind),
          ).toContain("agent-pty");
        }),
      { captured: makeMemoryCaptureStore(), sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("recovers a handed-off session whose hold failed with a shell resume, as the CLI prints it: a shell in a new workspace", async () => {
    const created: CreateOptions[] = [];
    let opens = 0;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const bundle = buildHandoffBundle(checkoutIn(tmp));
          const session = yield* provisionHandoff(
            project.id,
            "fix-login",
            yield* admitIn(project.storePath, bundle.bytes),
          );
          const hold = yield* engine.holdWorkspace(session.id, freeLaunchSlot).pipe(Effect.result);
          expect(Result.isFailure(hold)).toBe(true);
          expect(world.sessions.get(session.id)?.status).toBe("failed");
          // `POST /sessions/:id/resume {harness: "shell"}`.
          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          expect(
            [...world.processes.values()]
              .filter((process) => process.sessionId === session.id && process.exitedAt === null)
              .map((process) => [process.kind, process.harness]),
          ).toEqual([["agent-pty", "shell"]]);
          expect(checkpointsOf(world, session.worktreeId)[0]).toEqual([0, bundle.mergeBase]);
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { openFails: () => opens++ === 0 },
        ),
      },
    );
  });

  it("recovers a handoff whose prompt launch did not start with the person's harness on the prompt in its worktree, as `mend codex --worktree fix-login --project` sends it", async () => {
    const created: CreateOptions[] = [];
    let opens = 0;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const bundle = buildHandoffBundle(checkoutIn(tmp));
          const handedOff = yield* provisionHandoff(
            project.id,
            "fix-login",
            yield* admitIn(project.storePath, bundle.bytes),
          );
          const first = yield* engine
            .launch(handedOff.id, ["codex", "finish the tests"])
            .pipe(Effect.result);
          expect(Result.isFailure(first)).toBe(true);
          expect(world.sessions.get(handedOff.id)?.status).toBe("failed");
          // `POST /projects/:id/sessions {harness, name: "fix-login", base: null}`, then
          // `POST /sessions/:id/launch {prompt}`.
          const again = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: "fix-login",
            start: startFromBase(null),
            ownerUserId: "user-fixture",
          });
          expect(again.worktreeId).toBe(handedOff.worktreeId);
          const launched = yield* engine.launch(again.id, ["codex", "finish the tests"]);
          expect(launched.status).toBe("running");
          expect(
            [...world.processes.values()]
              .filter((process) => process.sessionId === again.id && process.exitedAt === null)
              .map((process) => [process.kind, process.harness]),
          ).toEqual([["agent-pty", "codex"]]);
          expect(checkpointsOf(world, handedOff.worktreeId)[0]).toEqual([0, bundle.mergeBase]);
          const change = [...world.changes.values()].filter(
            (candidate) => candidate.worktreeId === handedOff.worktreeId,
          );
          expect(change.map((candidate) => candidate.baseSha)).toEqual([bundle.mergeBase]);
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { openFails: () => opens++ === 0 },
        ),
      },
    );
  });

  it("refuses a handoff under a taken worktree name: no join, no second worktree, no session", async () => {
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const bundle = buildHandoffBundle(checkoutIn(tmp));
          const admitted = yield* admitIn(project.storePath, bundle.bytes);
          const taken = yield* engine.ensureWorktree(
            project.id,
            { name: "fix-login", start: { kind: "base", base: null } },
            "user-fixture",
          );
          const refused = yield* provisionHandoff(project.id, "fix-login", admitted).pipe(
            Effect.result,
          );
          if (Result.isFailure(refused) && refused.failure._tag === "WorktreeNameTakenError") {
            expect(refused.failure.branch).toBe("mend/fix-login");
          } else {
            expect.unreachable("the taken name was not refused as taken");
          }
          expect([...world.worktrees.values()].map((worktree) => worktree.id)).toEqual([taken.id]);
          expect(world.worktrees.get(taken.id)?.handoff).toBeNull();
          expect(world.sessions.size).toBe(0);
        }),
      { captured: makeMemoryCaptureStore() },
    );
  });
});
