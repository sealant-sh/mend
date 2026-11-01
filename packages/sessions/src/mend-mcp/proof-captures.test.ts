import { createHash } from "node:crypto";

import { AgentConversationRepo, ProofArtifactsRepo, WorktreeChangesRepo } from "@mend/db";
import {
  ChangeId,
  CheckpointId,
  ProjectId,
  ProofArtifactId,
  ScreenFrameId,
  ScreenId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Change, Checkpoint, DisplayNumber, type ProofArtifact } from "@mend/domain/workbench";
import { BlobStore, BlobNotFoundError, GitError } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { SessionEngine } from "../engine.ts";
import { ScreenStartError } from "../screen/screen-host.ts";
import { Screens, type ScreenCallAnswer, type ScreenRefusal } from "../screen/screens.ts";
import type { Caller } from "./caller.ts";
import { ProofCaptures, ProofCapturesLive } from "./proof-captures.ts";

const SESSION = SessionId.make("proof-session");
const SCREEN = ScreenId.make("proof-screen");
const caller: Caller = {
  sessionId: SESSION,
  accountId: "alice",
  agentProcess: { _tag: "Current", id: SessionProcessId.make("proof-process") },
  callKey: "call",
};
const base = Sha.make("abcdef123");
const change = new Change({
  id: ChangeId.make("change"),
  worktreeId: WorktreeId.make("tree"),
  projectId: ProjectId.make("project"),
  sessionId: SESSION,
  baseSha: base,
  branch: "mend/tree",
  headSha: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const checkpoint = new Checkpoint({
  id: CheckpointId.make("checkpoint"),
  worktreeId: change.worktreeId,
  sessionId: SESSION,
  ordinal: 4,
  ref: "refs/mend/checkpoints/tree/4",
  sha: Sha.make("1234567"),
  sealantRunId: null,
  seq: 0n,
  trigger: "proof-capture",
  createdAt: new Date(),
});
const png = new Uint8Array([137, 80, 78, 71, 1, 2]);
const digest = createHash("sha256").update(png).digest("hex");
const params = {
  title: "Task board",
  caption: "A completed task",
  side: "before",
} satisfies Parameters<ProofCaptures["Service"]["screenshot"]>[1];

const fixture = (
  options: {
    readonly refusal?: ScreenRefusal;
    readonly look?: Effect.Effect<ScreenCallAnswer, ScreenStartError>;
    readonly checkpointFailed?: boolean;
    readonly frameNotStored?: boolean;
  } = {},
) => {
  const artifacts = new Map<ProofArtifactId, ProofArtifact>();
  const calls = new Map<string, ProofArtifact>();
  const blobs = new Map<string, Uint8Array>([[`screen-frames/${SCREEN}/${digest}.png`, png]]);
  const copied: Array<string> = [];
  let looks = 0;
  let checkpoints = 0;
  const layer = ProofCapturesLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProofArtifactsRepo, {
          byCall: (sessionId, key) => Effect.sync(() => calls.get(`${sessionId}:${key}`) ?? null),
          insert: (artifact, key) =>
            Effect.sync(() => {
              artifacts.set(artifact.id, artifact);
              calls.set(`${artifact.sessionId}:${key}`, artifact);
              return artifact;
            }),
        }),
        Layer.mock(WorktreeChangesRepo, { bySession: () => Effect.succeed(change) }),
        Layer.mock(AgentConversationRepo, { listTurns: () => Effect.succeed([]) }),
        Layer.mock(SessionEngine, {
          launchUnderWay: () => false,
          checkpointNow: (_, trigger) =>
            Effect.suspend(() => {
              checkpoints += 1;
              expect(trigger).toBe("proof-capture");
              return options.checkpointFailed
                ? Effect.fail(
                    new GitError({ args: [], cwd: "/repo", exitCode: 1, stderr: "unavailable" }),
                  )
                : Effect.succeed(checkpoint);
            }),
        }),
        Layer.mock(Screens, {
          authorize: (who) =>
            Effect.succeed(
              options.refusal ??
                (who.agentProcess?._tag !== "Current" || who.callKey === null
                  ? "unattributed_caller"
                  : who.accountId !== "alice"
                    ? "owner_only"
                    : null),
            ),
          state: () =>
            Effect.succeed({
              screen: {
                id: SCREEN,
                sessionId: SESSION,
                workspaceId: SealantWorkspaceId.make("workspace"),
                display: DisplayNumber.make(12),
                processId: null,
                life: { _tag: "Live", degraded: null, browserSandboxOff: false },
                input: { _tag: "Agent", epoch: 0 },
              },
              takenAt: null,
            }),
          look: (who) =>
            Effect.suspend(() => {
              looks += 1;
              return (
                options.look ??
                Effect.succeed<ScreenCallAnswer>({
                  _tag: "Answered",
                  outcome: "applied",
                  receipt: { screenId: SCREEN, seq: 7, callKey: who.callKey ?? "" },
                  png,
                  observedAt: new Date("2026-11-01T14:02:00Z"),
                  frameId: options.frameNotStored
                    ? null
                    : ScreenFrameId.make(`${SCREEN}.${digest}`),
                  actions: [],
                  sinceLastLook: [],
                })
              );
            }),
        }),
        Layer.mock(BlobStore, {
          identity: "memory:proof",
          get: (key) =>
            Effect.suspend(() => {
              const bytes = blobs.get(key);
              return bytes === undefined
                ? Effect.fail(new BlobNotFoundError({ key }))
                : Effect.succeed(bytes);
            }),
          copy: (from, to) =>
            Effect.suspend(() => {
              const bytes = blobs.get(from);
              if (bytes === undefined) return Effect.fail(new BlobNotFoundError({ key: from }));
              blobs.set(to, bytes.slice());
              copied.push(to);
              return Effect.void;
            }),
          put: (key, body) =>
            Effect.sync(() => {
              if (!(body instanceof Uint8Array)) throw new Error("expected PNG");
              blobs.set(key, body.slice());
              return { written: true };
            }),
        }),
      ),
    ),
  );
  return { layer, artifacts, blobs, copied, looks: () => looks, checkpoints: () => checkpoints };
};

const run = <A>(
  world: ReturnType<typeof fixture>,
  body: (captures: ProofCaptures["Service"]) => Effect.Effect<A>,
) => Effect.runPromise(Effect.flatMap(ProofCaptures, body).pipe(Effect.provide(world.layer)));

describe("proof captures on the session's screen", () => {
  it("records before from the base, keeps its own PNG, and retries without another look", async () => {
    const world = fixture();
    await run(world, (captures) =>
      Effect.gen(function* () {
        const first = yield* captures.screenshot(caller, params);
        const retry = yield* captures.screenshot(caller, { ...params, title: "Ignored retry" });
        expect(retry).toEqual(first);
        expect(first.structuredContent).toBeUndefined();
        expect(first.content[0]).toMatchObject({ type: "image", data: png, mimeType: "image/png" });
        expect(world.looks()).toBe(1);
        expect(world.checkpoints()).toBe(0);
        const stored = [...world.artifacts.values()][0];
        expect(stored?.source).toEqual({ _tag: "Base", commit: base });
        expect(stored?.capture).toMatchObject({
          _tag: "Screenshot",
          moment: { screenId: SCREEN, seq: 7 },
        });
        if (stored?.capture._tag !== "Screenshot") throw new Error("missing screenshot");
        expect(world.copied).toEqual([stored.capture.media.blobKey]);
        world.blobs.delete(`screen-frames/${SCREEN}/${digest}.png`);
        expect(world.blobs.get(stored.capture.media.blobKey)).toEqual(png);
        expect(yield* captures.screenshot(caller, params)).toEqual(first);
        expect(stored.observedFrom.toISOString()).toBe("2026-11-01T14:02:00.000Z");
      }),
    );
  });
  it("pins after to a checkpoint, and concurrent retries keep one artifact", async () => {
    const world = fixture();
    await run(world, (captures) =>
      Effect.gen(function* () {
        const replies = yield* Effect.all(
          [
            captures.screenshot(caller, { ...params, side: "after" }),
            captures.screenshot(caller, { ...params, side: "after" }),
          ],
          { concurrency: "unbounded" },
        );
        expect(replies[0]).toEqual(replies[1]);
        expect(world.artifacts.size).toBe(1);
        expect(world.looks()).toBe(1);
        expect(world.checkpoints()).toBe(1);
        expect([...world.artifacts.values()][0]?.source).toEqual({
          _tag: "Checkpoint",
          checkpointId: checkpoint.id,
          ordinal: 4,
          commit: checkpoint.sha,
        });
      }),
    );
  });
  it("still captures after when checkpointing fails, labelled source unknown", async () => {
    const world = fixture({ checkpointFailed: true });
    const result = await run(world, (captures) =>
      captures.screenshot(caller, { ...params, side: "after" }),
    );
    expect(result.isError).not.toBe(true);
    expect([...world.artifacts.values()][0]?.source).toMatchObject({ _tag: "Unknown" });
    expect(JSON.stringify(result.content)).toContain("source unknown");
  });
  it.each([
    "held",
    "owner_only",
    "unattributed_caller",
    "no_screen",
    "busy",
  ] satisfies Array<ScreenRefusal>)("records nothing on %s refusal", async (refusal) => {
    const world = fixture({ refusal });
    const result = await run(world, (captures) => captures.screenshot(caller, params));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(refusal);
    expect(world.artifacts.size).toBe(0);
    expect(world.looks()).toBe(0);
  });
  it("records no artifact when Screens.look refuses or fails to start", async () => {
    for (const look of [
      Effect.succeed<ScreenCallAnswer>({ _tag: "Refused", refusal: "held" }),
      Effect.fail(new ScreenStartError({ message: "not started" })),
    ]) {
      const world = fixture({ look });
      expect((await run(world, (captures) => captures.screenshot(caller, params))).isError).toBe(
        true,
      );
      expect(world.artifacts.size).toBe(0);
    }
  });
  it("stores the returned PNG when the screen frame could not be retained", async () => {
    const world = fixture({ frameNotStored: true });
    expect((await run(world, (captures) => captures.screenshot(caller, params))).isError).not.toBe(
      true,
    );
    expect(world.artifacts.size).toBe(1);
    expect(world.copied).toHaveLength(0);
  });
  it("records missing before with its reason and no look or blob", async () => {
    const world = fixture();
    const result = await run(world, (captures) =>
      captures.missing(caller, {
        title: "Board",
        side: "before",
        kind: "screenshot",
        reason: "Missing test account",
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(world.looks()).toBe(0);
    expect(world.checkpoints()).toBe(0);
    expect([...world.artifacts.values()][0]?.capture).toEqual({
      _tag: "NotCaptured",
      kind: "screenshot",
      reason: "Missing test account",
    });
    expect(JSON.stringify(result)).toContain("not captured");
  });
});
