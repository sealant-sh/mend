import { PreviewsRepo } from "@mend/db";
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
import {
  PreviewStartDeclined,
  type PreviewStartRefused,
  ServiceBindError,
  ServiceHost,
  SessionEngine,
} from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  now,
  previewsRepoOf,
  sealantLaunchLayer,
  servedSocketApis,
  serviceHostStubLayer,
  setup,
  withEngine,
  type World,
} from "./engine/fixture.ts";
import { adapterLayer, echo, fakeForward, refusal, scriptedSealant } from "./forward-fixture.ts";

const OWNER = "user-fixture";
const STEERER = "user-maria";
const byOwner: ServiceStopCause = { kind: "person", userId: OWNER };
const bySteerer: ServiceStopCause = { kind: "person", userId: STEERER };
const idle: ServiceStopCause = { kind: "system", reason: "idle" };

const isService = (argv: ReadonlyArray<string>) => argv[0] === "pnpm";

const servicePlatform = () => {
  const gate: { current: Deferred.Deferred<void> | null } = { current: null };
  const closing: { gate: Deferred.Deferred<void> | null; waiting: number } = {
    gate: null,
    waiting: 0,
  };
  const opened: Array<ReadonlyArray<string>> = [];
  const closed: string[] = [];
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
              const held = closing.gate;
              if (held !== null) {
                closing.waiting += 1;
                await Effect.runPromise(Deferred.await(held));
              }
              closed.push(ptyId);
              if (control.failClose) throw new Error("the daemon did not answer");
              return pty.close();
            },
          })),
        ),
    })),
  ).pipe(Layer.provide(sealantLaunchLayer(Array<CreateOptions>())));
  return { layer, gate, closing, opened, closed, control, dead };
};

const flakyServiceHost = () => {
  const state = { failing: false };
  const layer = Layer.effect(
    ServiceHost,
    Effect.map(ServiceHost, (host) => ({
      ...host,
      start: (input) =>
        state.failing
          ? Effect.fail(new ServiceBindError({ message: "the host port is taken" }))
          : host.start(input),
    })),
  ).pipe(Layer.provide(serviceHostStubLayer));
  return { state, layer };
};

const listeningPort = (dead: ReadonlySet<string>) => {
  const state: { world: World | null; forced: boolean; warmupMs: number } = {
    world: null,
    forced: false,
    warmupMs: 0,
  };
  const firstSeen = new Map<string, number>();
  const warm = (handle: string) => {
    const seen = firstSeen.get(handle) ?? Date.now();
    firstSeen.set(handle, seen);
    return Date.now() - seen >= state.warmupMs;
  };
  const listening = () =>
    state.forced ||
    [...(state.world?.processes.values() ?? [])].some(
      (process) =>
        process.kind === "service" &&
        process.exitedAt === null &&
        process.sealantSessionId !== null &&
        !dead.has(process.sealantSessionId) &&
        warm(process.sealantSessionId),
    );
  const scripted = scriptedSealant(async () => {
    if (!listening()) throw refusal("connection-refused");
    return fakeForward(echo).forward;
  });
  return { state, layer: adapterLayer(scripted.layer) };
};

const preparePreview = (world: World, tmp: string, creatorRecorded = false) =>
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
    const web = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", {
      kind: "person",
      userId: OWNER,
    });
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

const resolutionOf = (world: World, preview: Preview) =>
  PreviewsRepo.use((previews) => previews.gatewaySnapshot(preview.id)).pipe(
    Effect.map((read) => read?.resolution),
    Effect.provide(previewsRepoOf(world)),
  );

const wakeFor = (world: World, preview: Preview, deadlineMs = 20_000) =>
  Effect.gen(function* () {
    const resolution = yield* resolutionOf(world, preview);
    if (resolution?._tag !== "Dormant") {
      return yield* Effect.die(`the preview is not dormant: ${resolution?._tag ?? "missing"}`);
    }
    return {
      previewId: preview.id,
      revision: resolution.revision,
      sourceAttemptId: resolution.source.sourceAttemptId,
      deadline: Date.now() + deadlineMs,
    } satisfies PreviewStartRequest;
  });

const NO_BUDGET_CLAIM = Effect.void;

const refusalOf = <A>(effect: Effect.Effect<A, PreviewStartRefused | PreviewStartDeclined>) =>
  Effect.result(effect).pipe(
    Effect.map((result) =>
      Result.isFailure(result)
        ? result.failure._tag === "PreviewStartDeclined"
          ? "declined"
          : result.failure.reason
        : { started: result.success },
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
  it("a person's Stop latches, a steerer's too, after a crash and when the close fails; the agent's own does not", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, session } = yield* preparePreview(world, tmp);
          const agent = servedSocketApis.get(session.id);
          if (agent === undefined) return yield* Effect.die("the session serves no socket");
          yield* agent.stopService(service.id);
          expect(
            world.previewControls.get(preview.id) ?? PREVIEW_CONTROL_INITIAL,
            "the agent's own Stop, over its socket",
          ).toEqual(PREVIEW_CONTROL_INITIAL);

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
          yield* engine.stopService(service.id, bySteerer);
          expect(
            world.previewControls.get(preview.id),
            "a steerer's Stop after a crash",
          ).toMatchObject({
            _tag: "Stopped",
            revision: 1,
            by: STEERER,
          });

          yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", {
            kind: "person",
            userId: OWNER,
          });
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
            _tag: "Stopped",
            revision: 3,
            by: OWNER,
          });
          platform.control.failClose = false;
          yield* engine.stopService(service.id, byOwner);
          expect(world.previewControls.get(preview.id)).toMatchObject({ revision: 3 });
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("a person's start or restart clears the latch, a steerer's too; the agent's own does not", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, session } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, byOwner);
          const stopped = world.previewControls.get(preview.id);
          expect(stopped).toMatchObject({ _tag: "Stopped", revision: 1 });

          const agent = servedSocketApis.get(session.id);
          if (agent === undefined) return yield* Effect.die("the session serves no socket");
          yield* agent.runService(["pnpm", "dev"], 3000, "web", "tcp", "http");
          yield* agent.restartService(service.id);
          expect(
            world.previewControls.get(preview.id),
            "the agent's own start and restart",
          ).toEqual(stopped);

          yield* engine.restartService(service.id, { kind: "person", userId: STEERER });
          expect(world.previewControls.get(preview.id), "a steerer's restart").toEqual({
            _tag: "Automatic",
            revision: 2,
          });

          yield* engine.stopService(service.id, bySteerer);
          yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", {
            kind: "person",
            userId: OWNER,
          });
          expect(world.previewControls.get(preview.id), "the owner's start").toEqual({
            _tag: "Automatic",
            revision: 4,
          });
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });
});

describe("a preview's control between two same-named Services in one worktree", () => {
  it("only a Stop or Start of the Service the preview selects decides it", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, session } = yield* preparePreview(world, tmp);
          const joined = yield* engine.provision({
            projectId: session.projectId,
            harness: "codex",
            label: null,
            name: session.worktree,
            start: { kind: "base", base: null },
            ownerUserId: STEERER,
          });
          expect(joined.worktreeId, "the second session joins the first's worktree").toBe(
            session.worktreeId,
          );
          yield* engine.launch(joined.id, ["codex"]);
          const theirs = yield* engine.runService(
            joined.id,
            ["pnpm", "dev"],
            3000,
            "web",
            "tcp",
            "http",
            { kind: "person", userId: STEERER },
          );
          yield* engine.stopService(theirs.service.id, bySteerer);
          expect(
            world.previewControls.get(preview.id) ?? PREVIEW_CONTROL_INITIAL,
            "the owner of the Service the preview does not select stopped theirs",
          ).toEqual(PREVIEW_CONTROL_INITIAL);

          yield* engine.stopService(service.id, byOwner);
          expect(world.previewControls.get(preview.id), "the selected one's owner").toMatchObject({
            _tag: "Stopped",
            revision: 1,
          });
          yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", {
            kind: "person",
            userId: OWNER,
          });
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
          yield* engine.stopService(service.id, idle);
          const before = platform.opened.length;
          const request = requestFor(world, preview, source);
          const [first, second] = yield* Effect.all(
            [
              engine.ensurePreviewRunning(request, NO_BUDGET_CLAIM),
              engine.ensurePreviewRunning(request, NO_BUDGET_CLAIM),
            ],
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
          expect(world.reachedAttempts.has(first), "readiness names the attempt").toBe(true);
          expect(
            yield* engine.ensurePreviewRunning(requestFor(world, preview, source), NO_BUDGET_CLAIM),
          ).toBe(first);
          expect(platform.opened.length - before).toBe(1);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("a request while a person's start is still opening its process waits for that start", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, session } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, idle);
          const known = new Set(serviceAttempts(world, service.id).map((attempt) => attempt.id));
          const gate = yield* Deferred.make<void>();
          platform.gate.current = gate;
          const before = platform.opened.length;
          const run = yield* Effect.forkChild(
            engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", {
              kind: "person",
              userId: OWNER,
            }),
          );
          const opening = () =>
            serviceAttempts(world, service.id).find((attempt) => !known.has(attempt.id));
          yield* until(() => opening() !== undefined, "the person's attempt");
          const attempt = opening();
          if (attempt === undefined) return yield* Effect.die("missing attempt");
          expect(attempt.sealantSessionId, "its process is still opening").toBeNull();
          const joined = yield* Effect.forkChild(
            refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, attempt.id), NO_BUDGET_CLAIM),
            ),
          );
          yield* Effect.sleep("200 millis");
          yield* Deferred.succeed(gate, undefined);
          expect(yield* Fiber.join(joined)).toEqual({ started: attempt.id });
          yield* Fiber.join(run);
          expect(platform.opened.length - before, "one process").toBe(1);
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
          yield* engine.stopService(service.id, idle);
          platform.control.exitOnOpen = true;
          const before = platform.opened.length;
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, source), NO_BUDGET_CLAIM),
            ),
          ).toBe("command-failed");
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, source), NO_BUDGET_CLAIM),
            ),
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
          yield* engine.stopService(service.id, idle);
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
          expect(yield* refusalOf(engine.ensurePreviewRunning(request, NO_BUDGET_CLAIM))).toBe(
            "start-unconfirmed",
          );
          expect(platform.opened.length).toBe(before);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("a person's Stop committed while the start is under way ends the process it started", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, idle);
          const known = new Set(serviceAttempts(world, service.id).map((attempt) => attempt.id));
          const gate = yield* Deferred.make<void>();
          platform.gate.current = gate;
          const start = yield* Effect.forkChild(
            refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, source), NO_BUDGET_CLAIM),
            ),
          );
          yield* until(
            () => serviceAttempts(world, service.id).some((attempt) => !known.has(attempt.id)),
            "the request's attempt",
          );
          const stop = yield* Effect.forkChild(engine.stopService(service.id, byOwner));
          yield* until(
            () => world.previewControls.get(preview.id)?._tag === "Stopped",
            "the owner's Stop recorded before its turn",
          );
          yield* Deferred.succeed(gate, undefined);
          expect(yield* Fiber.join(start)).toBe("stopped");
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

  it("waits for the source attempt's own ready timeout, never the browser's longer hold", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source } = yield* preparePreview(world, tmp);
          world.launches.set(source, {
            cwd: null,
            env: {},
            ready: { _tag: "Tcp", timeoutMs: 1_000 },
          });
          yield* engine.stopService(service.id, idle);
          port.state.warmupMs = 2_500;
          const began = Date.now();
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, source), NO_BUDGET_CLAIM),
            ),
          ).toBe("start-expired");
          expect(Date.now() - began).toBeLessThan(2_500);
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
          yield* engine.stopService(service.id, idle);
          const known = new Set(serviceAttempts(world, service.id).map((attempt) => attempt.id));
          const gate = yield* Deferred.make<void>();
          platform.gate.current = gate;
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, source, 300), NO_BUDGET_CLAIM),
            ),
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

  it("refuses a stopped preview, a stale request, a busy port, and a workspace that is not live", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source, session } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, byOwner);
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, source), NO_BUDGET_CLAIM),
            ),
          ).toBe("stopped");

          yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", {
            kind: "person",
            userId: OWNER,
          });
          yield* engine.stopService(service.id, idle);
          const stale = { ...requestFor(world, preview, source), revision: 0 };
          expect(yield* refusalOf(engine.ensurePreviewRunning(stale, NO_BUDGET_CLAIM))).toBe(
            "control-changed",
          );
          const latest = serviceAttempts(world, service.id).at(-1)?.id;
          if (latest === undefined) return yield* Effect.die("missing attempt");
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, source), NO_BUDGET_CLAIM),
            ),
            "the newer attempt is the source",
          ).toBe("control-changed");

          port.state.forced = true;
          const before = platform.opened.length;
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, latest), NO_BUDGET_CLAIM),
            ),
          ).toBe("port-occupied");
          expect(platform.opened.length).toBe(before);
          port.state.forced = false;

          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("missing session row");
          world.sessions.set(session.id, new Session({ ...row, sealantWorkspaceId: null }));
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, latest), NO_BUDGET_CLAIM),
            ),
          ).toBe("workspace-not-live");
          expect(platform.opened.length).toBe(before);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("only the request that claims a new launch pays for it; a join or an earlier failure pays nothing", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, source, session } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, idle);
          const claims: Array<string> = [];
          const claimAs = (who: string) => Effect.sync(() => void claims.push(who));
          const request = requestFor(world, preview, source);
          const [first, second] = yield* Effect.all(
            [
              engine.ensurePreviewRunning(request, claimAs("first")),
              engine.ensurePreviewRunning(request, claimAs("second")),
            ],
            { concurrency: "unbounded" },
          );
          expect(second).toBe(first);
          expect(claims, "one launch, one claim").toHaveLength(1);
          expect(
            yield* engine.ensurePreviewRunning(requestFor(world, preview, source), claimAs("late")),
          ).toBe(first);
          expect(claims, "joining a running attempt claims nothing").toHaveLength(1);

          yield* engine.stopService(service.id, idle);
          platform.control.exitOnOpen = true;
          const failing = yield* wakeFor(world, preview);
          expect(yield* refusalOf(engine.ensurePreviewRunning(failing, claimAs("fails")))).toBe(
            "command-failed",
          );
          expect(yield* refusalOf(engine.ensurePreviewRunning(failing, claimAs("again")))).toBe(
            "command-failed",
          );
          expect(claims, "an earlier failure is answered without a claim").toEqual([
            "first",
            "fails",
          ]);

          platform.control.exitOnOpen = false;
          yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", {
            kind: "person",
            userId: OWNER,
          });
          yield* engine.stopService(service.id, idle);
          const before = platform.opened.length;
          const declined = new PreviewStartDeclined();
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(yield* wakeFor(world, preview), Effect.fail(declined)),
            ),
          ).toBe("declined");
          expect(platform.opened.length, "a declined claim starts nothing").toBe(before);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });

  it("an attempt it started that answered is the next one woken, though no host port bound for it", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    const host = flakyServiceHost();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, idle);
          host.state.failing = true;
          const served = yield* refusalOf(
            engine.ensurePreviewRunning(yield* wakeFor(world, preview), NO_BUDGET_CLAIM),
          );
          expect(served, "served while its host port did not bind").toMatchObject({
            started: expect.any(String),
          });
          yield* engine.stopService(service.id, idle);
          const woken = yield* refusalOf(
            engine.ensurePreviewRunning(yield* wakeFor(world, preview), NO_BUDGET_CLAIM),
          );
          expect(woken, "the next request starts it again").toMatchObject({
            started: expect.any(String),
          });
          expect(woken).not.toEqual(served);
        }),
      {
        sealantLayer: platform.layer,
        forwardAdapterLayer: port.layer,
        serviceHostLayer: host.layer,
      },
    );
  });

  it("a start accepted as its caller's hold ran out still has its answer observed, and wakes again", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, idle);
          const known = new Set(serviceAttempts(world, service.id).map((attempt) => attempt.id));
          port.state.warmupMs = 400;
          const gate = yield* Deferred.make<void>();
          platform.gate.current = gate;
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(yield* wakeFor(world, preview, 300), NO_BUDGET_CLAIM),
            ),
          ).toBe("start-expired");
          platform.gate.current = null;
          yield* Deferred.succeed(gate, undefined);
          const late = () =>
            serviceAttempts(world, service.id).find((attempt) => !known.has(attempt.id));
          yield* until(() => late()?.status === "running", "the late start to finish");
          yield* engine.stopService(service.id, idle);
          yield* until(() => late()?.exitedAt != null, "the late start to stop");
          const woken = yield* refusalOf(
            engine.ensurePreviewRunning(yield* wakeFor(world, preview), NO_BUDGET_CLAIM),
          );
          expect(woken, "the next request starts it again").toMatchObject({
            started: expect.any(String),
          });
          expect(woken).not.toEqual({ started: late()?.id });
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
          yield* engine.stopService(service.id, idle);
          world.serviceStarters.set(service.id, "user-carol");
          const before = platform.opened.length;
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, source), NO_BUDGET_CLAIM),
            ),
          ).toBe("starter-no-standing");
          expect(platform.opened.length).toBe(before);
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });
});

describe("a preview's control under people's concurrent intents", () => {
  it("a restart asked before another person's Stop never clears that Stop", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview } = yield* preparePreview(world, tmp);
          const held = yield* Deferred.make<void>();
          platform.closing.gate = held;
          const restart = yield* Effect.forkChild(
            engine.restartService(service.id, { kind: "person", userId: STEERER }),
          );
          yield* until(() => platform.closing.waiting > 0, "the restart to hold the lifecycle");
          const stop = yield* Effect.forkChild(engine.stopService(service.id, byOwner));
          yield* until(
            () => world.previewControls.get(preview.id)?._tag === "Stopped",
            "the owner's Stop recorded before its turn",
          );
          platform.closing.gate = null;
          yield* Deferred.succeed(held, undefined);
          yield* Fiber.join(restart);
          yield* Fiber.join(stop);
          expect(world.previewControls.get(preview.id), "the later Stop stands").toMatchObject({
            _tag: "Stopped",
            by: OWNER,
          });
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });
});

describe("a person's Stop and a run the agent started", () => {
  it("serves the agent's run while it lasts, starts nothing once it ends, and a person's Start clears it", async () => {
    const platform = servicePlatform();
    const port = listeningPort(platform.dead);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          port.state.world = world;
          const { engine, service, preview, session } = yield* preparePreview(world, tmp);
          yield* engine.stopService(service.id, byOwner);
          const agent = servedSocketApis.get(session.id);
          if (agent === undefined) return yield* Effect.die("the session serves no socket");
          yield* agent.runService(["pnpm", "dev"], 3000, "web", "tcp", "http");
          expect(yield* resolutionOf(world, preview), "the agent's run is served").toMatchObject({
            _tag: "Bound",
          });

          yield* agent.stopService(service.id);
          expect(yield* resolutionOf(world, preview), "the Stop holds again").toMatchObject({
            _tag: "Stopped",
            control: { by: OWNER },
          });
          const latest = serviceAttempts(world, service.id).at(-1)?.id;
          if (latest === undefined) return yield* Effect.die("missing attempt");
          const before = platform.opened.length;
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(requestFor(world, preview, latest), NO_BUDGET_CLAIM),
            ),
          ).toBe("stopped");
          expect(platform.opened.length, "a request starts nothing").toBe(before);

          yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", "http", {
            kind: "person",
            userId: OWNER,
          });
          yield* engine.stopService(service.id, idle);
          expect(
            yield* refusalOf(
              engine.ensurePreviewRunning(yield* wakeFor(world, preview), NO_BUDGET_CLAIM),
            ),
            "a person's Start cleared the Stop",
          ).toMatchObject({ started: expect.any(String) });
        }),
      { sealantLayer: platform.layer, forwardAdapterLayer: port.layer },
    );
  });
});
