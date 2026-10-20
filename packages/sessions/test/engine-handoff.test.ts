import * as fs from "node:fs";
import * as path from "node:path";

import { ProjectId } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { skippedFreshen, Store, type AdmittedHandoff } from "@mend/store";
import { buildHandoffBundle, sh } from "@mend/store/testing";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Result } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { setup, withEngine, type World } from "./engine/fixture.ts";

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
      start: { kind: "handoff", admitted, ownerUserId: owner },
      ownerUserId: owner,
    }),
  );

const checkpointsOf = (world: World, worktreeId: string) =>
  world.checkpoints
    .filter((checkpoint) => checkpoint.worktreeId === worktreeId)
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .map((checkpoint) => [checkpoint.ordinal, checkpoint.sha]);

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
          world.sessions.delete(first.id);
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
          if (Result.isFailure(refused) && refused.failure._tag === "GitError") {
            expect(refused.failure.stderr).toMatch(/already exists/);
          } else {
            expect.unreachable("the taken name was not refused with a GitError");
          }
          expect([...world.worktrees.values()].map((worktree) => worktree.id)).toEqual([taken.id]);
          expect(world.worktrees.get(taken.id)?.handoff).toBeNull();
          expect(world.sessions.size).toBe(0);
        }),
      { captured: makeMemoryCaptureStore() },
    );
  });
});
