import {
  AgentConversationRepo,
  CheckpointsRepo,
  type PreviewPreparationClaim,
  PreviewPreparationsRepo,
  SessionNotFoundError,
  SessionsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import { ProjectNotFoundError } from "@mend/db";
import {
  AgentTurnId,
  ChangeId,
  CheckpointId,
  PreviewId,
  ProjectId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  AgentTurn,
  Change,
  Checkpoint,
  type AgentTurnStatus,
  type PreviewPreparationDecision,
  type PreviewPreparationHold,
  type PreviewPrepared,
  Worktree,
  Session,
  type SessionPurpose,
} from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import {
  type CaptureFlushObservation,
  SessionEngine,
  WorktreeNotCapturedError,
  WorktreeReads,
} from "@mend/sessions";
import type { ChangedFile } from "@mend/store";
import { Deferred, Duration, Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { makeSession } from "../test/support/tenancy-harness.ts";
import { makePreviewPreparation } from "./preview-preparation.ts";

const PROJECT = ProjectId.make("project-api");
const SESSION = SessionId.make("session-1");
const WORKTREE = WorktreeId.make("worktree-1");
const BASE = Sha.make("b".repeat(40));
const BEFORE_TURN = Sha.make("c".repeat(40));
const AFTER_TURN = Sha.make("d".repeat(40));
const NOW = new Date("2026-10-30T12:00:00.000Z");
const PREVIEW = PreviewId.make("preview-web");

const file = (path: string): ChangedFile => ({ path, additions: 3, deletions: 1 });

interface World {
  purpose: SessionPurpose | null;
  turns: Array<AgentTurn>;
  rows: Map<string, { claimId: string; decision: PreviewPreparationDecision | null }>;
  progress: Array<{ readonly turnId: string; readonly phase: string }>;
  changed: Map<string, ReadonlyArray<ChangedFile>>;
  changeExists: boolean;
  notCaptured: boolean;
  /** The chain head failed Git verification: a lenient read answers an older capture's files. */
  headFailed: boolean;
  projectGone: boolean;
  checkpoints: Array<Checkpoint>;
  flushes: Array<CaptureFlushObservation>;
  flushGate: {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null;
  prepared: (hold: PreviewPreparationHold) => Effect.Effect<PreviewPrepared, SealantPlatformError>;
  stopped: boolean;
  /** Renewals answer false from now on: another worker retook the turn. */
  lost: boolean;
  /** Another preparation holds the preview: a progress write answers Taken. */
  taken: boolean;
  renewals: number;
  timeline: Array<string>;
  bases: Array<string>;
}

const startingWeb = {
  _tag: "Starting",
  service: "web",
  previewId: PREVIEW,
  phase: "service",
  note: null,
} as const;

const running = (note: "setup-inputs-changed" | null = null): PreviewPrepared => ({
  _tag: "Running",
  service: "web",
  previewId: PREVIEW,
  note,
});

const blankWorld = (): World => ({
  purpose: null,
  turns: [],
  rows: new Map(),
  progress: [],
  changed: new Map([[BEFORE_TURN, [file("src/app.tsx")]]]),
  changeExists: true,
  notCaptured: false,
  headFailed: false,
  projectGone: false,
  checkpoints: [],
  flushes: [],
  flushGate: null,
  prepared: () =>
    Effect.sync(() =>
      world.stopped ? { _tag: "Stopped", service: "web", previewId: PREVIEW } : running(),
    ),
  stopped: false,
  lost: false,
  taken: false,
  renewals: 0,
  timeline: [],
  bases: [],
});

let world: World = blankWorld();

const turn = (
  ordinal: number,
  overrides: {
    readonly status?: AgentTurnStatus;
    readonly endedAt?: Date | null;
    readonly startedAt?: Date;
  } = {},
) =>
  new AgentTurn({
    id: AgentTurnId.make(`turn-${ordinal}`),
    sessionId: SESSION,
    processId: SessionProcessId.make("process-1"),
    ordinal,
    author: "alice",
    input: "fix the login page",
    status: overrides.status ?? "completed",
    providerTurnId: null,
    error: null,
    usage: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    startedAt: overrides.startedAt ?? new Date(NOW.getTime() - 60_000),
    endedAt: overrides.endedAt === undefined ? new Date(NOW.getTime() - 5_000) : overrides.endedAt,
  });

const checkpointAt = (sha: Sha, at: Date, ordinal: number) =>
  new Checkpoint({
    id: CheckpointId.make(`cp-${ordinal}`),
    worktreeId: WORKTREE,
    sessionId: SESSION,
    ordinal,
    ref: `refs/mend/checkpoints/worktree-1/${ordinal}`,
    sha,
    sealantRunId: null,
    seq: 0n,
    trigger: "turn-boundary",
    createdAt: at,
  });

const worktree = new Worktree({
  id: WORKTREE,
  projectId: PROJECT,
  name: "fix-login",
  directory: "fix-login",
  branch: "mend/fix-login",
  baseSha: BASE,
  baseRef: "main",
  handoff: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const change = new Change({
  id: ChangeId.make("change-1"),
  projectId: PROJECT,
  worktreeId: WORKTREE,
  sessionId: SESSION,
  branch: "mend/fix-login",
  baseSha: BASE,
  headSha: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const holds = (claim: PreviewPreparationClaim) => {
  const row = world.rows.get(claim.turnId);
  return !world.lost && row !== undefined && row.claimId === claim.claimId && row.decision === null;
};

const OLDER_CAPTURE = {
  source: "capture" as const,
  captureN: 3,
  captureId: "3".repeat(64),
  seq: "30",
  kind: "turn",
  partial: false,
  observedAt: NOW.toISOString(),
};

const layer = Layer.mergeAll(
  Layer.mock(PreviewPreparationsRepo, {
    undecided: () =>
      Effect.sync(() =>
        world.turns
          .filter(
            (candidate) =>
              candidate.status !== "queued" &&
              candidate.status !== "running" &&
              (world.rows.get(candidate.id)?.decision ?? null) === null,
          )
          .map((candidate) => candidate.id),
      ),
    claim: (turnId) =>
      Effect.sync(() => {
        if (world.rows.has(turnId)) return null;
        const claimId = `claim-${turnId}`;
        world.rows.set(turnId, { claimId, decision: null });
        return { turnId, sessionId: SESSION, worktreeId: WORKTREE, claimId };
      }),
    left: () =>
      Effect.sync(
        () =>
          new Map(
            [...world.rows].flatMap(([turnId, row]) =>
              row.decision === null
                ? []
                : [
                    [
                      AgentTurnId.make(turnId),
                      row.decision._tag === "Superseded"
                        ? ("superseded" as const)
                        : ("decided" as const),
                    ] as const,
                  ],
            ),
          ),
      ),
    renew: (claim) =>
      Effect.sync(() => {
        world.renewals += 1;
        return holds(claim);
      }),
    progress: (claim, progress) =>
      Effect.sync(() => {
        if (!holds(claim)) return "Lost" as const;
        if (world.taken) return "Taken" as const;
        world.progress.push({ turnId: claim.turnId, phase: progress.phase });
        return "Held" as const;
      }),
    decide: (claim, decision) =>
      Effect.sync(() => {
        if (!holds(claim)) return false;
        world.rows.set(claim.turnId, { claimId: claim.claimId, decision });
        return true;
      }),
  }),
  Layer.mock(AgentConversationRepo, { listTurns: () => Effect.sync(() => [...world.turns]) }),
  Layer.mock(SessionsRepo, {
    byId: (id) =>
      id === SESSION
        ? Effect.sync(
            () =>
              new Session({
                ...makeSession(SESSION, PROJECT, WORKTREE, "alice"),
                purpose: world.purpose,
              }),
          )
        : Effect.fail(new SessionNotFoundError({ sessionId: id })),
  }),
  Layer.mock(WorktreesRepo, { byId: () => Effect.succeed(worktree) }),
  Layer.mock(WorktreeChangesRepo, {
    byWorktree: () => Effect.sync(() => (world.changeExists ? change : null)),
  }),
  Layer.mock(CheckpointsRepo, {
    latestForWorktreeAt: (_worktree, at) =>
      Effect.sync(
        () => world.checkpoints.filter((checkpoint) => checkpoint.createdAt <= at).at(-1) ?? null,
      ),
  }),
  Layer.mock(WorktreeReads, {
    changedFiles: (_project, _worktree, base, options) =>
      Effect.suspend((): ReturnType<WorktreeReads["Service"]["changedFiles"]> => {
        world.timeline.push("read-change");
        world.bases.push(base);
        if (world.projectGone) return Effect.fail(new ProjectNotFoundError({ projectId: PROJECT }));
        if (world.notCaptured || (world.headFailed && options?.exactHead === true))
          return Effect.fail(
            new WorktreeNotCapturedError({ worktreeId: WORKTREE, message: "no head" }),
          );
        if (world.headFailed) return Effect.succeed({ value: [], stamp: OLDER_CAPTURE });
        return Effect.succeed({
          value: world.changed.get(base) ?? [],
          stamp: {
            source: "worktree" as const,
            captureN: null,
            captureId: null,
            seq: null,
            kind: null,
            partial: false,
            observedAt: null,
          },
        });
      }),
  }),
  Layer.mock(SessionEngine, {
    launchUnderWay: () => false,
    flushCaptures: () =>
      Effect.gen(function* () {
        world.timeline.push("flush");
        if (world.flushGate !== null) {
          yield* Deferred.succeed(world.flushGate.started, undefined);
          yield* Deferred.await(world.flushGate.release);
        }
        return world.flushes.shift() ?? "flushed";
      }),
    preparePreview: (_session, turnId, hold) =>
      Effect.suspend(() => {
        world.timeline.push(`prepare:${turnId}`);
        return world.prepared(hold);
      }),
  }),
);

const look = (times = 1, leaseMs?: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const preparer = yield* makePreviewPreparation({
        now: () => NOW.getTime(),
        flushPause: Duration.zero,
        ...(leaseMs === undefined ? {} : { leaseMs }),
      });
      for (let index = 0; index < times; index += 1) yield* preparer.consider(SESSION);
    }).pipe(Effect.provide(layer)),
  );

const decisions = () =>
  world.turns.map((candidate) => [
    candidate.ordinal,
    world.rows.get(candidate.id)?.decision?._tag ?? null,
  ]);

beforeEach(() => {
  world = blankWorld();
  world.checkpoints = [checkpointAt(BEFORE_TURN, new Date(NOW.getTime() - 90_000), 1)];
});

describe("the preview after a changed turn (docs/adr/0017, After the agent is done)", () => {
  it("starts the preview after a turn that changed the worktree since the turn began", async () => {
    world.turns = [turn(0)];

    await look();

    expect(world.bases).toEqual([BEFORE_TURN]);
    expect(world.timeline).toEqual(["flush", "read-change", "prepare:turn-0"]);
    expect(world.rows.get("turn-0")?.decision).toEqual(running());
  });

  it("starts nothing after a question that changed nothing, and never reads mend.toml for it", async () => {
    world.turns = [turn(0)];
    world.changed = new Map([
      [BEFORE_TURN, []],
      [BASE, [file("src/app.tsx")]],
    ]);

    await look();

    expect(decisions()).toEqual([[0, "NoChange"]]);
    expect(world.timeline).toEqual(["flush", "read-change"]);
  });

  it("compares with the base when no checkpoint came before the turn", async () => {
    world.turns = [turn(0)];
    world.checkpoints = [checkpointAt(BEFORE_TURN, NOW, 1)];
    world.changed = new Map([[BASE, [file("src/app.tsx")]]]);

    await look();

    expect(world.bases).toEqual([BASE]);
    expect(decisions()).toEqual([[0, "Running"]]);
  });

  it("records a change it could not read as not captured, never as no change", async () => {
    world.turns = [turn(0), turn(1)];
    world.flushes = ["incomplete", "incomplete", "incomplete"];

    await look();
    expect(world.rows.get("turn-1")?.decision).toEqual({ _tag: "NotCaptured" });
    expect(world.timeline).toEqual(["flush", "flush", "flush"]);

    world.notCaptured = true;
    world.turns = [turn(2)];
    await look();
    expect(world.rows.get("turn-2")?.decision).toEqual({ _tag: "NotCaptured" });
  });

  it("waits for a capture-mode flush before it reads the change", async () => {
    world.turns = [turn(0)];
    world.flushGate = {
      started: Deferred.makeUnsafe<void>(),
      release: Deferred.makeUnsafe<void>(),
    };
    const gate = world.flushGate;
    const looking = look();
    await Effect.runPromise(Deferred.await(gate.started));
    expect(world.timeline).toEqual(["flush"]);
    await Effect.runPromise(Deferred.succeed(gate.release, undefined));
    await looking;

    expect(world.timeline).toEqual(["flush", "read-change", "prepare:turn-0"]);
  });

  it("skips a lone turn that did not complete, and starts one that covers a completed turn", async () => {
    world.turns = [turn(1, { status: "failed" })];
    await look();
    expect(world.rows.get("turn-1")?.decision).toEqual({ _tag: "Skipped", why: "the turn failed" });

    world.rows.clear();
    world.turns = [turn(2), turn(3, { status: "interrupted" })];
    await look();
    expect(decisions()).toEqual([
      [2, "Superseded"],
      [3, "Running"],
    ]);
  });

  it("skips a turn that ended long ago", async () => {
    world.turns = [turn(0, { endedAt: new Date(NOW.getTime() - 16 * 60_000) })];
    await look();
    expect(world.rows.get("turn-0")?.decision).toEqual({ _tag: "Skipped", why: "ended long ago" });
  });

  it("a changed turn and a question after it, considered together, start the preview once", async () => {
    world.turns = [
      turn(0, { startedAt: new Date(NOW.getTime() - 60_000) }),
      turn(1, { startedAt: new Date(NOW.getTime() - 20_000) }),
    ];
    world.checkpoints = [
      checkpointAt(BEFORE_TURN, new Date(NOW.getTime() - 90_000), 1),
      checkpointAt(AFTER_TURN, new Date(NOW.getTime() - 30_000), 2),
    ];
    world.changed = new Map([
      [BEFORE_TURN, [file("src/app.tsx")]],
      [AFTER_TURN, []],
    ]);

    await look();

    expect(decisions()).toEqual([
      [0, "Superseded"],
      [1, "Running"],
    ]);
    expect(world.bases).toEqual([BEFORE_TURN]);
    expect(world.timeline.filter((entry) => entry.startsWith("prepare:"))).toEqual([
      "prepare:turn-1",
    ]);
  });

  it("records a fallback to an older capture as not captured, never as no change", async () => {
    world.turns = [turn(0)];
    world.headFailed = true;

    await look();

    expect(world.rows.get("turn-0")?.decision).toEqual({ _tag: "NotCaptured" });
    expect(world.timeline).not.toContain("prepare:turn-0");
  });

  it("skips a turn whose project is gone by the time its change is read", async () => {
    world.turns = [turn(0)];
    world.projectGone = true;

    await look();

    expect(world.rows.get("turn-0")?.decision).toEqual({
      _tag: "Skipped",
      why: "the project is gone",
    });
  });

  it("asks the engine to start nothing once a renewal says the claim was lost", async () => {
    world.turns = [turn(0)];
    world.flushGate = {
      started: Deferred.makeUnsafe<void>(),
      release: Deferred.makeUnsafe<void>(),
    };
    const gate = world.flushGate;
    world.lost = true;
    const looking = look(1, 30);
    await Effect.runPromise(Deferred.await(gate.started));
    await Effect.runPromise(Effect.sleep("60 millis"));
    await Effect.runPromise(Deferred.succeed(gate.release, undefined));
    await looking;

    expect(world.renewals).toBeGreaterThan(0);
    expect(world.timeline).not.toContain("prepare:turn-0");
    expect(world.rows.get("turn-0")?.decision).toBeNull();
  });

  it("ends the preparation when a progress write finds the claim gone, without waiting on the start", async () => {
    world.turns = [turn(0)];
    world.prepared = (hold) =>
      Effect.gen(function* () {
        world.lost = true;
        expect(yield* hold.report({ ...startingWeb, phase: "setup" })).toBe(false);
        return yield* Effect.never;
      });

    await look(1, 30);

    expect(world.rows.get("turn-0")?.decision).toBeNull();
  });

  it("stops renewing its claim once the turn is decided, however long the start took", async () => {
    world.turns = [turn(0)];
    world.prepared = (hold) =>
      Effect.gen(function* () {
        yield* hold.report({ ...startingWeb, phase: "setup" });
        yield* Effect.sleep("100 millis");
        return { _tag: "Refused", service: "web", previewId: PREVIEW, reason: "setup failed" };
      });

    await look(1, 30);
    const renewed = world.renewals;
    await Effect.runPromise(Effect.sleep("100 millis"));

    expect(renewed).toBeGreaterThan(0);
    expect(world.renewals).toBe(renewed);
    expect(world.progress).toEqual([{ turnId: "turn-0", phase: "setup" }]);
    expect(world.rows.get("turn-0")?.decision).toMatchObject({ _tag: "Refused" });
  });

  it("decides each turn once, however many times it looks", async () => {
    world.turns = [turn(0)];

    await look(3);

    expect(world.timeline.filter((entry) => entry.startsWith("prepare:"))).toEqual([
      "prepare:turn-0",
    ]);
  });

  it("records a person's Stop that landed while the turn was being read", async () => {
    world.turns = [turn(0)];
    world.flushGate = {
      started: Deferred.makeUnsafe<void>(),
      release: Deferred.makeUnsafe<void>(),
    };
    const gate = world.flushGate;
    const looking = look();
    await Effect.runPromise(Deferred.await(gate.started));
    world.stopped = true;
    await Effect.runPromise(Deferred.succeed(gate.release, undefined));
    await looking;

    expect(world.rows.get("turn-0")?.decision).toEqual({
      _tag: "Stopped",
      service: "web",
      previewId: PREVIEW,
    });
  });

  it("leaves a turn undecided when the workspace could not be read, for a later look", async () => {
    world.turns = [turn(0)];
    world.prepared = () =>
      Effect.fail(
        new SealantPlatformError({
          code: "workspace_status_failed",
          status: null,
          message: "Could not observe the session workspace status.",
          cause: null,
        }),
      );

    await look();

    expect(world.rows.get("turn-0")).toEqual({ claimId: "claim-turn-0", decision: null });
  });

  it("looks no further for a session that is gone", async () => {
    world.turns = [turn(0)];
    await Effect.runPromise(
      Effect.gen(function* () {
        const preparer = yield* makePreviewPreparation({ now: () => NOW.getTime() });
        yield* preparer.consider(SessionId.make("session-gone"));
      }).pipe(Effect.provide(layer)),
    );
    expect(world.timeline).toEqual([]);
  });
});

it("records setup turns as skipped before reading the change or preparing a preview", async () => {
  world.purpose = "setup";
  world.turns = [turn(0)];
  world.changed.set(BEFORE_TURN, [file(".mend/mend.toml")]);
  await look(2);
  expect(world.rows.get(world.turns[0]?.id ?? "")?.decision).toEqual({
    _tag: "Skipped",
    why: "setup sessions write instructions; nothing starts",
  });
  expect(world.timeline).toEqual([]);
});
