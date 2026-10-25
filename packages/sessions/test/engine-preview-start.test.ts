import { PreviewId, PreviewLabel, SessionProcessId } from "@mend/domain";
import {
  type Preview,
  PREVIEW_CONTROL_INITIAL,
  previewStartId,
  type PreviewStartRequest,
  serviceStartCorrelation,
  Session,
  SessionProcess,
  type ServiceStopCause,
} from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { type PreviewStartRefused, SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { now, sealantLaunchLayer, setup, withEngine, type World } from "./engine/fixture.ts";
import { adapterLayer, echo, fakeForward, refusal, scriptedSealant } from "./forward-fixture.ts";

const OWNER = "user-fixture";
const STEERER = "user-maria";
const byOwner: ServiceStopCause = { kind: "person", userId: OWNER };
const bySteerer: ServiceStopCause = { kind: "person", userId: STEERER };

const isService = (argv: ReadonlyArray<string>) => argv[0] === "pnpm";

/**
 * The platform these worlds start Services on: each open can be held on a gate or answer a
 * process that has already exited, and every close is logged.
 */
const servicePlatform = () => {
  const gate: { current: Deferred.Deferred<void> | null } = { current: null };
  const opened: Array<ReadonlyArray<string>> = [];
  const closed: string[] = [];
  /** Processes that exited as they started: nothing of theirs ever listens. */
  const dead = new Set<string>();
  const control = { exitOnOpen: false, failClose: false };
  const layer = Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client) => ({
      ...client,
      openSession: (workspace, argv, options) =>
        Effect.gen(function* () {
          if (isService(argv) && gate.current !== null) yield* Deferred.await(gate.current);
          const pty = yield* client.openSession(workspace, argv, options);
          if (!isService(argv)) return pty;
          opened.push(argv);
          if (!control.exitOnOpen) return pty;
          dead.add(pty.id);
          return {
            ...pty,
            status: async () => ({ status: "exited", exitCode: 1, outputHighWater: 0n }),
          };
        }),
      getSession: (workspace, ptyId) =>
        client.getSession(workspace, ptyId).pipe(
          Effect.map((pty) => ({
            ...pty,
            close: async () => {
              closed.push(ptyId);
              if (control.failClose) throw new Error("the daemon did not answer");
              return pty.close();
            },
          })),
        ),
    })),
  ).pipe(Layer.provide(sealantLaunchLayer(Array<CreateOptions>())));
  return { layer, gate, opened, closed, control, dead };
};

/** A workspace port answers while a Service process with a handle runs, or when forced to. */
const listeningPort = (dead: ReadonlySet<string>) => {
  const state: { world: World | null; forced: boolean } = { world: null, forced: false };
  const listening = () =>
    state.forced ||
    [...(state.world?.processes.values() ?? [])].some(
      (process) =>
        process.kind === "service" &&
        process.exitedAt === null &&
        process.sealantSessionId !== null &&
        !dead.has(process.sealantSessionId),
    );
  const scripted = scriptedSealant(async () => {
    if (!listening()) throw refusal("connection-refused");
    return fakeForward(echo).forward;
  });
  return { state, layer: adapterLayer(scripted.layer, "refuse") };
};

const preparePreview = (
  world: World,
  tmp: string,
  /** The executor's creator is on record from its launch on (a person executor's rule applies). */
  creatorRecorded = false,
) =>
  Effect.gen(function* () {
    const project = yield* setup(tmp, world);
    const engine = yield* SessionEngine;
    const session = yield* engine.provision({
      projectId: project.id,
      harness: "codex",
      label: null,
      name: null,
      ownerUserId: OWNER,
      start: { kind: "base", base: null },
    });
    if (creatorRecorded) {
      world.executorLaunches.set(session.id, { workspaceId: "workspace-1", launchId: "launch-1" });
    }
    yield* engine.launch(session.id, ["codex"]);
    const web = yield* engine.runService(
      session.id,
      ["pnpm", "dev"],
      3000,
      "web",
      "tcp",
      "http",
      OWNER,
    );
    const worktreeId = world.sessions.get(session.id)?.worktreeId;
    if (worktreeId === undefined) return yield* Effect.die("missing session row");
    const preview: Preview = {
      id: PreviewId.make("preview-web"),
      projectId: project.id,
      worktreeId,
      serviceName: "web",
      label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
      state: "kept",
    };
    world.previews.set(preview.id, preview);
    const source = web.attempts[0]?.id;
    if (source === undefined) return yield* Effect.die("missing first attempt");
    return { engine, session, service: web.service, preview, source };
  });

const requestFor = (
  world: World,
  preview: Preview,
  source: SessionProcessId,
  deadlineMs = 20_000,
): PreviewStartRequest => ({
  previewId: preview.id,
  revision: (world.previewControls.get(preview.id) ?? PREVIEW_CONTROL_INITIAL).revision,
  sourceAttemptId: source,
  deadline: Date.now() + deadlineMs,
});

const refusalOf = <A>(effect: Effect.Effect<A, PreviewStartRefused>) =>
  Effect.result(effect).pipe(
    Effect.map((result) =>
      Result.isFailure(result) ? result.failure.reason : { started: result.success },
    ),
  );

const serviceAttempts = (world: World, serviceId: string) =>
  [...world.processes.values()].filter((process) => process.serviceId === serviceId);

const until = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400; tries += 1) {
      if (condition()) return;
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.die(`timed out waiting for ${what}`);
  });

describe("a preview's control", () => {
  it("an owner's Stop latches, after a crash and when the close fails too; a steerer's does not", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, session } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, bySteerer);
          expect(world.previewControls.get(preview.id) ?? PREVIEW_CONTROL_INITIAL).toEqual(
            PREVIEW_CONTROL_INITIAL,
          );

          const crashed = yield* engine.runService(
            session.id,
            ["pnpm", "dev"],
            3000,
            "web",
            "tcp",
            "http",
          );
          const crashedAttempt = crashed.attempts.at(-1);
          if (crashedAttempt === undefined) return yield* Effect.die("missing attempt");
          world.processes.set(
            crashedAttempt.id,
            new SessionProcess({ ...crashedAttempt, exitedAt: now(), status: "exited" }),
          );
          yield* engine.stopService(service.id, byOwner);
          expect(world.previewControls.get(preview.id), "a Stop after a crash").toMatchObject({
            _tag: "OwnerStopped",
            revision: 1,
            by: OWNER,
          });

          yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", OWNER);
          expect(world.previewControls.get(preview.id)).toEqual({
            _tag: "Automatic",
            revision: 2,
          });
          platform.control.failClose = true;
          const unclosed = yield* engine.stopService(service.id, byOwner);
          expect(
            unclosed.attempts.at(-1)?.exitedAt,
            "the process is still recorded live",
          ).toBeNull();
          expect(world.previewControls.get(preview.id)).toMatchObject({
            _tag: "OwnerStopped",
            revision: 3,
          });
          platform.control.failClose = false;
          yield* engine.stopService(service.id, byOwner);
          expect(world.previewControls.get(preview.id)).toMatchObject({ revision: 3 });
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("an owner's start or restart clears the latch; a steerer's does not", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, session } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, byOwner);
          const stopped = world.previewControls.get(preview.id);
          expect(stopped).toMatchObject({ _tag: "OwnerStopped", revision: 1 });

          yield* engine.runService(
            session.id,
            ["pnpm", "dev"],
            3000,
            "web",
            "tcp",
            "http",
            STEERER,
          );
          yield* engine.restartService(service.id, STEERER);
          expect(world.previewControls.get(preview.id), "a steerer's start").toEqual(stopped);

          yield* engine.restartService(service.id, OWNER);
          expect(world.previewControls.get(preview.id)).toEqual({
            _tag: "Automatic",
            revision: 2,
          });
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });
});

describe("ensurePreviewRunning", () => {
  it("two concurrent requests start one process, and a later one joins it", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, bySteerer);
          const before = platform.opened.length;
          const request = requestFor(world, preview, source);
          const [first, second] = yield* Effect.all(
            [engine.ensurePreviewRunning(request), engine.ensurePreviewRunning(request)],
            { concurrency: "unbounded" },
          );
          expect(second).toBe(first);
          expect(platform.opened.length - before, "one process").toBe(1);
          const started = world.processes.get(first);
          expect(started).toMatchObject({
            status: "running",
            argv: ["pnpm", "dev"],
            launchCorrelationId: serviceStartCorrelation(service.id, previewStartId(request)),
          });
          expect(started?.sealantSessionId).not.toBeNull();
          expect([...world.observationAttempts.values()], "readiness names the attempt").toContain(
            first,
          );
          expect(yield* engine.ensurePreviewRunning(requestFor(world, preview, source))).toBe(
            first,
          );
          expect(platform.opened.length - before).toBe(1);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("a request's start that failed is answered as failed again, and never run a second time", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, bySteerer);
          platform.control.exitOnOpen = true;
          const before = platform.opened.length;
          expect(
            yield* refusalOf(engine.ensurePreviewRunning(requestFor(world, preview, source))),
          ).toBe("command-failed");
          expect(
            yield* refusalOf(engine.ensurePreviewRunning(requestFor(world, preview, source))),
          ).toBe("command-failed");
          expect(platform.opened.length - before).toBe(1);
          expect(serviceAttempts(world, service.id).filter((a) => a.exitedAt === null)).toEqual([]);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("an attempt recorded with no process handle is not known to run, and nothing starts again", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, bySteerer);
          const request = requestFor(world, preview, source);
          const sourceRow = world.processes.get(source);
          if (sourceRow === undefined) return yield* Effect.die("missing source row");
          const orphan = SessionProcessId.make("crashed-before-its-handle");
          world.processes.set(
            orphan,
            new SessionProcess({
              ...sourceRow,
              id: orphan,
              sealantSessionId: null,
              sealantRunId: null,
              status: "starting",
              exitedAt: null,
              attemptOrdinal: 9,
              launchCorrelationId: serviceStartCorrelation(service.id, previewStartId(request)),
              createdAt: now(),
            }),
          );
          const before = platform.opened.length;
          expect(yield* refusalOf(engine.ensurePreviewRunning(request))).toBe("start-unconfirmed");
          expect(platform.opened.length).toBe(before);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("an owner's Stop committed while the start is under way ends the process it started", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, bySteerer);
          const known = new Set(serviceAttempts(world, service.id).map((attempt) => attempt.id));
          const gate = yield* Deferred.make<void>();
          platform.gate.current = gate;
          const start = yield* Effect.forkChild(
            refusalOf(engine.ensurePreviewRunning(requestFor(world, preview, source))),
          );
          yield* until(
            () => serviceAttempts(world, service.id).some((attempt) => !known.has(attempt.id)),
            "the request's attempt",
          );
          const stop = yield* Effect.forkChild(engine.stopService(service.id, byOwner));
          yield* until(
            () => world.previewControls.get(preview.id)?._tag === "OwnerStopped",
            "the owner's Stop recorded before its turn",
          );
          yield* Deferred.succeed(gate, undefined);
          expect(yield* Fiber.join(start)).toBe("owner-stopped");
          yield* Fiber.join(stop);
          const started = serviceAttempts(world, service.id).find(
            (attempt) => !known.has(attempt.id),
          );
          expect(started?.status).toBe("stopped");
          expect(platform.closed).toContain(started?.sealantSessionId);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("a caller whose deadline passes leaves an accepted start to finish with its handle recorded", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, bySteerer);
          const known = new Set(serviceAttempts(world, service.id).map((attempt) => attempt.id));
          const gate = yield* Deferred.make<void>();
          platform.gate.current = gate;
          expect(
            yield* refusalOf(engine.ensurePreviewRunning(requestFor(world, preview, source, 300))),
          ).toBe("start-expired");
          const accepted = () =>
            serviceAttempts(world, service.id).find((attempt) => !known.has(attempt.id));
          expect(accepted()?.sealantSessionId, "still opening").toBeNull();
          yield* Deferred.succeed(gate, undefined);
          yield* until(() => accepted()?.sealantSessionId != null, "the recorded handle");
          yield* until(() => accepted()?.status === "running", "the start to finish");
          expect(accepted()?.exitedAt).toBeNull();
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("refuses an owner-stopped preview, a stale request, a busy port, and a workspace that is not live", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source, session } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, byOwner);
          expect(
            yield* refusalOf(engine.ensurePreviewRunning(requestFor(world, preview, source))),
          ).toBe("owner-stopped");

          yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", OWNER);
          yield* engine.stopService(service.id, bySteerer);
          const stale = { ...requestFor(world, preview, source), revision: 0 };
          expect(yield* refusalOf(engine.ensurePreviewRunning(stale))).toBe("control-changed");
          const latest = serviceAttempts(world, service.id).at(-1)?.id;
          if (latest === undefined) return yield* Effect.die("missing attempt");
          expect(
            yield* refusalOf(engine.ensurePreviewRunning(requestFor(world, preview, source))),
            "the newer attempt is the source",
          ).toBe("control-changed");

          port.state.forced = true;
          const before = platform.opened.length;
          expect(
            yield* refusalOf(engine.ensurePreviewRunning(requestFor(world, preview, latest))),
          ).toBe("port-occupied");
          expect(platform.opened.length).toBe(before);
          port.state.forced = false;

          // What a session whose workspace ended reads as.
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("missing session row");
          world.sessions.set(session.id, new Session({ ...row, sealantWorkspaceId: null }));
          expect(
            yield* refusalOf(engine.ensurePreviewRunning(requestFor(world, preview, latest))),
          ).toBe("workspace-not-live");
          expect(platform.opened.length).toBe(before);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("refuses a start whose last starter no longer has standing in the workspace", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source, session } = yield* preparePreview(
            world,
            tmp,
            true,
          );
          expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
          yield* engine.stopService(service.id, bySteerer);
          // The Service's last starter is no longer a member of the project's organization.
          world.serviceStarters.set(service.id, "user-carol");
          const before = platform.opened.length;
          const refused = yield* Effect.result(
            engine.ensurePreviewRunning(requestFor(world, preview, source)),
          );
          expect(Result.isFailure(refused) ? refused.failure.reason : refused).toBe(
            "starter-no-standing",
          );
          expect(platform.opened.length).toBe(before);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });
});
