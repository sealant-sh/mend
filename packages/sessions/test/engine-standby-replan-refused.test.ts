import { SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import { HotWorkspace, Project, Session, SessionProcess } from "@mend/domain/workbench";
import { SealantClient, type SealantClientShape, SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type {
  CreateOptions,
  Workspace,
  WorkspaceCaptureReplanned,
  WorkspaceCaptureStatus,
} from "@sealant/sdk";
import { Clock, Duration, Effect, Exit, Fiber, Layer } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { lifecycleLayer, memoryHotPool } from "./engine/capture-fixture.ts";
import { makeStandbyClock } from "./engine/clock-fixture.ts";
import {
  captureAnswer,
  servedSocketApis,
  setup,
  type World,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

/**
 * SLNT-1053: a claim whose `capture.replan` failed because a connection dropped (`capture plan.get
 * failed: transport: io: peer closed connection without sending TLS close_notify`, 2 of 18 claims
 * on the box on 2026-11-16). The launch drained the standby as a relaunch drains; the standby holds
 * no lease, so its final flush never saved, the session never ran, and its stop read "not saved ·
 * 3.3 KB pending · workspace kept · the claimed standby may hold work not yet saved" until its owner
 * discarded it, its Boat VM billed meanwhile.
 */

/** One ask of the standby's re-plan, as sealantd answers it. */
type Ask =
  /** The connection dropped on its `plan.get`: nothing changed on the standby. */
  | "drop"
  /** It took (the session's worktree under the claim's epoch), and its answer was lost. */
  | "lost"
  /** It took and answered. */
  | "ok"
  /** It never answers inside the launch's budget, and never takes. */
  | "hang"
  /** sealant refused the claim's owner map before its daemon was reached. */
  | "owner-map";

interface Scenario {
  /** Each ask in turn; past the last, the last again. */
  readonly asks: ReadonlyArray<Ask>;
  /**
   * Whether the standby's own status answers (`capture.status()`), or never can be read; a cell
   * the scenario turns readable later.
   */
  readonly status: "answers" | "unreadable" | { value: "answers" | "unreadable" };
  /** A session joined the standby and ran a process there while its re-plan was asked. */
  readonly joined?: boolean;
}

interface Outcome {
  readonly launch: "ran" | "refused";
  readonly refusal: string | null;
  readonly asks: number;
  /** Every stop asked of the platform, the standby's and the cold executor's. */
  readonly stops: ReadonlyArray<{ readonly workspace: string; readonly kind: "drain" | "discard" }>;
  readonly creates: number;
  readonly sessionWorkspace: string | null;
  /** The launch the session's workspace was created under: a standby's, or a cold launch's. */
  readonly sessionLaunch: string | null;
  readonly status: string | null;
  readonly summary: string | null;
  readonly standbyEnded: boolean;
  readonly logs: ReadonlyArray<string>;
  readonly world: World;
  readonly sessionId: SessionId;
}

const drain = {
  terminationWait: Duration.millis(50),
  pollInterval: Duration.millis(10),
  // A drain that does not read saved keeps the workspace at once: what a person sees after the
  // box's stall window, without waiting it out.
  stallSeconds: 0,
};

/**
 * Each create gets its own workspace id (the standby `workspace-1`, a cold executor after it
 * `workspace-2`), and one the platform stopped reads stopped from then on. `launches` keeps the
 * launch each was created under: over a re-plan's whole budget the pool makes the claimed
 * standby's replacement too, so the cold executor's id is not always the second.
 */
const distinctWorkspaces = (
  layer: Layer.Layer<SealantClient>,
  stopped: Set<string>,
  launches: Map<string, string>,
): Layer.Layer<SealantClient> =>
  Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client) => {
      const workspaces = new Map<string, Workspace>();
      return {
        ...client,
        createWorkspace: (options, launch, watch) =>
          client.createWorkspace(options, launch, watch).pipe(
            Effect.map((workspace) => {
              const id = `workspace-${workspaces.size + 1}`;
              const created: Workspace = {
                ...workspace,
                id,
                status: async () => (stopped.has(id) ? "stopped" : "ready"),
              };
              workspaces.set(id, created);
              launches.set(id, launch?.launchId ?? "");
              return created;
            }),
          ),
        getWorkspace: (id) => {
          const workspace = workspaces.get(id);
          return workspace === undefined ? client.getWorkspace(id) : Effect.succeed(workspace);
        },
        stopWorkspace: (workspace, options) =>
          client.stopWorkspace(workspace, options).pipe(
            Effect.tap((answer) =>
              Effect.sync(() => {
                if (answer.state === "stopped") stopped.add(workspace.id);
              }),
            ),
          ),
      } satisfies SealantClientShape;
    }),
  ).pipe(Layer.provide(layer));

/** A process another session ran in the standby (a join), ended since. */
const joinedProcess = (workspaceId: string) =>
  new SessionProcess({
    id: SessionProcessId.make("joined-process"),
    sessionId: SessionId.make("joiner-session"),
    sealantWorkspaceId: SealantWorkspaceId.make(workspaceId),
    sealantSessionId: "sealant-session-joined",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind: "shell",
    harness: "codex",
    providerSessionId: null,
    protocolOptions: null,
    label: "shell",
    argv: ["bash"],
    status: "exited",
    exitCode: 0,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: new Date(0),
    exitedAt: new Date(1),
    updatedAt: new Date(1),
  });

const run = (
  scenario: Scenario,
  after?: (world: World, sessionId: SessionId) => Effect.Effect<void, unknown, SessionEngine>,
) =>
  Effect.gen(function* () {
    const created: Array<CreateOptions> = [];
    const stopKinds: Array<"drain" | "discard"> = [];
    const stops: Array<{ workspace: string; kind: "drain" | "discard" }> = [];
    const stopped = new Set<string>();
    const launches = new Map<string, string>();
    const logs: Array<string> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    const clock = yield* makeStandbyClock(pool);
    let placeholder = 0;
    let launch = "";
    let alias = "";
    let claimEpoch = 0;
    /** The standby's own identity moved to the session's: the re-plan took. */
    let took = false;
    let asks = 0;
    let executor: SessionId | null = null;
    let world: World | null = null;
    let observation = 0;
    const stamped = (epoch: number) => ({
      epoch,
      origin: { epoch, launch, bootId: "boot-1", bootGeneration: 1, observation: ++observation },
    });
    /** The standby's own status: under its placeholder until its re-plan took. */
    const standbyAnswer = (): WorkspaceCaptureStatus =>
      took
        ? captureAnswer({ ...stamped(claimEpoch), worktreeId: worktreeOf(), pending: 0 })
        : captureAnswer({
            ...stamped(placeholder),
            worktreeId: alias,
            // Its refused uploads: the "3.3 KB pending" the box read.
            pending: 1,
            pendingBytes: 3_340,
          });
    const worktreeOf = () => {
      if (executor === null || world === null) throw new Error("no session");
      return world.sessions.get(executor)?.worktreeId ?? "";
    };
    /** What sealantd's `plan.get` answers the claim: the session's worktree, the claim's epoch. */
    const planOf = Effect.gen(function* () {
      if (executor === null) throw new Error("no executor to replan");
      const api = servedSocketApis.get(executor)?.capture;
      if (api === undefined) throw new Error("the executor serves no capture api");
      return yield* api.planGet({ worktree_id: null, epoch: 0 }).pipe(Effect.orDie);
    });
    const replan = (_workspace: Workspace) =>
      Effect.gen(function* () {
        const ask = scenario.asks[Math.min(asks, scenario.asks.length - 1)] ?? "drop";
        asks++;
        if (scenario.joined === true && world !== null) {
          world.processes.set("joined-process", joinedProcess("workspace-1"));
        }
        if (ask === "hang") return yield* Effect.never;
        if (ask === "owner-map") {
          return yield* new SealantPlatformError({
            code: "owner-map-mismatch",
            status: 409,
            message: "the standby booted with another owner map",
            cause: null,
          });
        }
        if (ask === "drop") {
          return yield* new SealantPlatformError({
            code: "replan_refused",
            status: 502,
            message:
              "The workspace runtime refused the re-plan: capture plan.get failed: transport: io: peer closed connection without sending TLS close_notify",
            cause: null,
          });
        }
        const plan = yield* planOf;
        claimEpoch = plan.epoch;
        took = true;
        if (ask === "lost") {
          return yield* new SealantPlatformError({
            code: "replan_refused",
            status: 502,
            message: "transport: io: connection reset by peer",
            cause: null,
          });
        }
        return {
          worktreeId: plan.worktree_id,
          epoch: plan.epoch,
          ...(plan.head === null
            ? {}
            : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
          filesWritten: 0,
          bytesWritten: 0,
          filesSkipped: 0,
          bytesSkipped: 0,
          removed: 0,
          unchanged: asks > 1,
        } satisfies WorkspaceCaptureReplanned;
      });
    const result: { outcome: Outcome | null } = { outcome: null };
    yield* withPreparedEngineEffect(
      (testWorld, tmp) => setup(tmp, testWorld),
      (testWorld, _tmp, project) =>
        Effect.gen(function* () {
          world = testWorld;
          testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const engine = yield* SessionEngine;
          yield* engine.reconcileHotSessions(project.id);
          yield* clock.untilReady(
            () => pool.entries.some((entry) => entry.status === "ready"),
            "a standby",
          );
          const warmed = pool.entries[0];
          if (warmed === undefined) throw new Error("no standby");
          // Stamped on the engine's clock, as the claim evidence suite does: the standby's answers
          // come after its creation, as they do on a server.
          yield* TestClock.adjust(Duration.seconds(1));
          const standby = new HotWorkspace({
            ...warmed,
            createdAt: new Date(yield* Clock.currentTimeMillis),
          });
          pool.entries[0] = standby;
          placeholder = standby.createdAt.getTime();
          launch = `standby:${standby.id}`;
          alias = `standby-${standby.id}`;
          const session = yield* clock.claim(
            engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            }),
          );
          executor = session.id;
          const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
          // A re-plan that never answers spends the launch's whole budget (three minutes).
          for (let look = 0; look < 400 && launching.pollUnsafe() === undefined; look++) {
            yield* TestClock.adjust(Duration.seconds(1));
          }
          const exit = yield* Fiber.await(launching);
          const row = testWorld.sessions.get(session.id);
          if (after !== undefined) yield* after(testWorld, session.id);
          const settled = testWorld.sessions.get(session.id);
          result.outcome = {
            launch: Exit.isSuccess(exit) ? "ran" : "refused",
            refusal: Exit.isFailure(exit) ? String(exit.cause) : null,
            asks,
            stops: [...stops],
            creates: created.length,
            sessionWorkspace: row?.sealantWorkspaceId ?? null,
            sessionLaunch: launches.get(row?.sealantWorkspaceId ?? "") ?? null,
            status: settled?.status ?? null,
            summary: settled?.summary ?? null,
            standbyEnded: stopped.has("workspace-1"),
            logs: [...logs],
            world: testWorld,
            sessionId: session.id,
          };
        }),
      {
        captured: memory,
        logs,
        hotWorkspacesLayer: clock.poolLayer,
        wrapCaptureChannel: clock.wrapCaptureChannel,
        drainPolicy: drain,
        sealantLayer: distinctWorkspaces(
          lifecycleLayer(created, {
            captureOps: {
              stops: stopKinds,
              // Boat as the box saw it: a saving stop of the standby drains a final flush that
              // never saves and is kept; a discard ends it. The cold executor's stop ends it.
              stopAnswer: (discard) => {
                const kind = discard ? "discard" : "drain";
                const workspace = stopped.has("workspace-1") ? "workspace-2" : "workspace-1";
                stops.push({ workspace, kind });
                return discard || took || workspace !== "workspace-1" ? "stopped" : "draining";
              },
              resourceId: () => "standby-vm",
              replan,
              captureStatus: (target) =>
                Effect.sync(() =>
                  (typeof scenario.status === "string"
                    ? scenario.status
                    : scenario.status.value) === "unreadable"
                    ? null
                    : target.id === "workspace-1"
                      ? standbyAnswer()
                      : null,
                ),
              // The standby's final flush: under its placeholder its uploads are refused, so it
              // never saves; once re-planned, everything saved.
              flush: (target) =>
                Effect.sync(() =>
                  target.id !== "workspace-1"
                    ? captureAnswer({ pending: 0 })
                    : took
                      ? captureAnswer({
                          ...stamped(claimEpoch),
                          worktreeId: worktreeOf(),
                          pending: 0,
                          registered: 1,
                          headN: 1,
                        })
                      : captureAnswer({
                          ...stamped(placeholder),
                          worktreeId: alias,
                          pending: 1,
                          pendingBytes: 3_340,
                        }),
                ),
            },
          }),
          stopped,
          launches,
        ),
      },
    );
    if (result.outcome === null) throw new Error("the scenario did not finish");
    return result.outcome;
  });

const has = (logs: ReadonlyArray<string>, words: string) =>
  logs.some((line) => line.includes(words));

describe("a claim whose re-plan is refused (SLNT-1053)", () => {
  it.effect(
    "a re-plan whose connection drops every time, the standby still on its placeholder: the standby is discarded, never drained, and the session runs cold",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({ asks: ["drop"], status: "answers" });
        // Asked again, up to three times, before giving up on the claim.
        expect(outcome.asks).toBe(3);
        expect(has(outcome.logs, "standby replan · refused · asking again")).toBe(true);
        expect(has(outcome.logs, "the re-plan never took · cold launch")).toBe(true);
        // The standby ended by a discard, with no saving stop first; nothing of it is left.
        expect(outcome.stops[0]).toEqual({ workspace: "workspace-1", kind: "discard" });
        expect(outcome.standbyEnded).toBe(true);
        expect(has(outcome.logs, "capture flush · timed out")).toBe(false);
        // The session runs on a cold executor of its own.
        expect(outcome.launch).toBe("ran");
        expect(outcome.creates).toBe(2);
        expect(outcome.sessionWorkspace).not.toBe("workspace-1");
        expect(outcome.sessionLaunch?.startsWith("launch:")).toBe(true);
        expect(outcome.status).toBe("running");
        expect(outcome.summary ?? "").not.toContain("not saved");
        expect(outcome.world.sessions.get(outcome.sessionId)?.captureNotSavedAt ?? null).toBeNull();
        const launch = outcome.world.executorLaunches.get(outcome.sessionId)?.launchId ?? "";
        expect(launch).not.toMatch(/^standby:/);
      }),
    30_000,
  );

  it.effect(
    "a re-plan that never answers in the launch's budget, the standby on its placeholder: asked once, then discarded, and the session runs cold",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({ asks: ["hang"], status: "answers" });
        expect(outcome.asks).toBe(1);
        expect(has(outcome.logs, "standby replan · timed out")).toBe(true);
        expect(outcome.stops[0]).toEqual({ workspace: "workspace-1", kind: "discard" });
        expect(outcome.standbyEnded).toBe(true);
        expect(outcome.launch).toBe("ran");
        // Not `workspace-2`: this re-plan spends the launch's three minutes, in which the pool
        // makes the claimed standby's replacement. The session's is the one a cold launch made.
        expect(outcome.sessionWorkspace).not.toBe("workspace-1");
        expect(outcome.sessionLaunch?.startsWith("launch:")).toBe(true);
      }),
    60_000,
  );

  it.effect(
    "a re-plan that fails once and answers when asked again: the session runs on the standby, with no cold launch",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({ asks: ["drop", "ok"], status: "answers" });
        expect(outcome.asks).toBe(2);
        expect(outcome.launch).toBe("ran");
        expect(outcome.creates).toBe(1);
        expect(outcome.stops).toEqual([]);
        expect(outcome.sessionWorkspace).toBe("workspace-1");
        expect(outcome.status).toBe("running");
      }),
    30_000,
  );

  it.effect(
    "a re-plan that took and lost its answer every time: the standby answers as the session's, and the session runs on it, adopted",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({ asks: ["lost"], status: "answers" });
        // Asked again after a lost answer, sealantd's idempotent re-plan took the first time.
        expect(outcome.asks).toBe(3);
        expect(
          has(outcome.logs, "its answer was lost · the executor answers as this session's"),
        ).toBe(true);
        expect(outcome.launch).toBe("ran");
        expect(outcome.creates).toBe(1);
        expect(outcome.stops).toEqual([]);
        expect(outcome.sessionWorkspace).toBe("workspace-1");
        expect(outcome.status).toBe("running");
      }),
    30_000,
  );

  it.effect(
    "a re-plan that took and lost its answer, and a standby that cannot be read: drained as a relaunch drains, it saves, and the session runs cold",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({ asks: ["lost"], status: "unreadable" });
        expect(has(outcome.logs, "could not be read · drained as a relaunch drains")).toBe(true);
        expect(outcome.stops[0]).toEqual({ workspace: "workspace-1", kind: "drain" });
        expect(outcome.stops.some((stop) => stop.kind === "discard")).toBe(false);
        expect(outcome.launch).toBe("ran");
        expect(outcome.sessionWorkspace).not.toBe("workspace-1");
        expect(outcome.sessionLaunch?.startsWith("launch:")).toBe(true);
      }),
    30_000,
  );

  it.effect(
    "a refused re-plan and a standby that cannot be read: kept as before, and the words say only what is known",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({ asks: ["drop"], status: "unreadable" });
        expect(outcome.stops.some((stop) => stop.kind === "discard")).toBe(false);
        expect(outcome.standbyEnded).toBe(false);
        expect(outcome.launch).toBe("refused");
        expect(outcome.refusal).toContain("not saved");
        expect(outcome.refusal).toContain("this session's command never ran in it");
        expect(outcome.refusal).not.toContain("may hold work not yet saved");
        expect(outcome.summary).not.toContain("may hold work not yet saved");
      }),
    30_000,
  );

  it.effect(
    "a refused re-plan while a joined session ran a process in the standby: never discarded, kept as before",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({ asks: ["drop"], status: "answers", joined: true });
        expect(outcome.stops.some((stop) => stop.kind === "discard")).toBe(false);
        expect(outcome.standbyEnded).toBe(false);
        expect(outcome.launch).toBe("refused");
      }),
    30_000,
  );

  it.effect(
    "an owner-map refusal is not asked again: one ask, its own words, and the launch goes cold",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run({ asks: ["owner-map"], status: "answers" });
        expect(outcome.asks).toBe(1);
        expect(
          has(
            outcome.logs,
            "standby replan · the standby booted with another owner map · cold launch",
          ),
        ).toBe(true);
        expect(has(outcome.logs, "asking again")).toBe(false);
        expect(outcome.launch).toBe("ran");
        expect(outcome.sessionWorkspace).not.toBe("workspace-1");
        expect(outcome.sessionLaunch?.startsWith("launch:")).toBe(true);
      }),
    30_000,
  );

  it.effect(
    "a session already kept this way, with the words of the build before: the capture reaper's next pass discards the standby and the words say what it was",
    () =>
      Effect.gen(function* () {
        // On the build before, nothing looked at the standby: the launch kept it. Reproduced by a
        // standby whose status cannot be read at the launch, and can once the server is upgraded.
        const status: { value: "answers" | "unreadable" } = { value: "unreadable" };
        const outcome = yield* run({ asks: ["drop"], status }, (world, sessionId) =>
          Effect.gen(function* () {
            const kept = world.sessions.get(sessionId);
            if (kept === undefined) throw new Error("no session");
            expect(kept.captureDrain).toBe("relaunch");
            expect(kept.captureNotSavedAt).not.toBeNull();
            world.sessions.set(
              sessionId,
              new Session({
                ...kept,
                summary:
                  "not saved · 3.3 KB pending · workspace kept · the claimed standby may hold work not yet saved · start again once it saves, or discard unsaved and stop",
              }),
            );
            status.value = "answers";
            const engine = yield* SessionEngine;
            // The reaper takes the kept drain up again after its first wait (10 s).
            yield* TestClock.adjust(Duration.seconds(10));
            yield* engine.reapCaptureLeases();
            for (
              let look = 0;
              look < 200 && world.sessions.get(sessionId)?.captureDrain != null;
              look++
            ) {
              yield* TestClock.adjust(drain.pollInterval);
            }
          }),
        );
        expect(outcome.launch).toBe("refused");
        expect(outcome.stops).toEqual([{ workspace: "workspace-1", kind: "discard" }]);
        expect(outcome.standbyEnded).toBe(true);
        expect(outcome.world.sessions.get(outcome.sessionId)?.captureDrain ?? null).toBeNull();
        expect(outcome.status).toBe("failed");
        expect(outcome.summary).toContain("the claimed standby never took this session's worktree");
        expect(outcome.summary).not.toContain("may hold work not yet saved");
      }),
    30_000,
  );
});
