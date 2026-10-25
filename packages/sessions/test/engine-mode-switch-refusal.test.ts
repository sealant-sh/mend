import * as fs from "node:fs";
import * as path from "node:path";

import { SessionProcessId } from "@mend/domain";
import { AgentTurn, Session, SessionProcess } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  HARNESS_STATE,
  harvestHarnessStateScript,
  ProtocolHost,
  ProtocolHostNotLiveError,
  SessionEngine,
} from "@mend/sessions";
import { harnessHomePathOf, processStatePathOf } from "@mend/store";
import type { CreateOptions, InteractiveSessionStatus } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer, Result, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  completedTurnOf,
  fakeExecRun,
  harvestExecOf,
  now,
  recordedTurnsLayer,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
  transcriptIn,
  type World,
  writeHomeTranscript,
} from "./engine/fixture.ts";

const detachingProtocolHostLayer = (
  attached: Array<{ readonly process: SessionProcess; readonly mode: string }>,
  submitted: Array<string>,
  detached: Array<string> = [],
) =>
  Layer.effect(
    ProtocolHost,
    Effect.map(ProtocolHost, (host) => {
      const live = () => {
        const current = attached.at(-1)?.process.id;
        return current !== undefined && !detached.includes(current);
      };
      return {
        ...host,
        has: (processId) => Effect.sync(() => !detached.includes(processId)),
        rehydrate: (input) =>
          host.rehydrate(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                const at = detached.indexOf(input.process.id);
                if (at >= 0) detached.splice(at, 1);
              }),
            ),
          ),
        detach: (processId) => Effect.sync(() => void detached.push(processId)),
        detachForHandOver: (processId) => Effect.sync(() => void detached.push(processId)),
        submitTurn: (sessionId, input, author, correlation) =>
          Effect.suspend(() =>
            live()
              ? host.submitTurn(sessionId, input, author, correlation)
              : Effect.fail(new ProtocolHostNotLiveError({ processId: "detached" })),
          ),
      };
    }),
  ).pipe(Layer.provide(recordingProtocolHostLayer(attached, submitted)));

const PROVIDER = "5d1c2b7a-9e4f-4a3b-8c6d-0f1e2a3b4c5d";
const claudeHarness = HARNESS_STATE["claude"];
if (claudeHarness === undefined) throw new Error("no claude harness state shape");
const HARVEST_ARCHIVE = harvestHarnessStateScript(claudeHarness.paths);

const conversationWorld = (
  options: {
    readonly closeAnswersOnceTheWatcherSawTheExit?: boolean;
    readonly closeRefused?: boolean;
    readonly openFailsWhile?: () => boolean;
    readonly answerExec?: (argv: ReadonlyArray<string>) =>
      | Effect.Effect<{
          readonly exitCode: number;
          readonly stdout: string;
          readonly stderr: string;
        }>
      | undefined;
    readonly firstRunSettlesOn?: Effect.Effect<void>;
    readonly beforeTurnsAreRead?: () => Effect.Effect<void>;
  } = {},
) => {
  let runsWaited = 0;
  const created: Array<CreateOptions> = [];
  const spawned: Array<ReadonlyArray<string>> = [];
  const workspaceStops: Array<string> = [];
  const execCalls: Array<ReadonlyArray<string>> = [];
  const closes: Array<string> = [];
  const ptyStates = new Map<string, InteractiveSessionStatus>();
  const watcherSaw = new Map<string, () => void>();
  const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
  const submitted: Array<string> = [];
  const detached: Array<string> = [];
  const turns: Array<AgentTurn> = [];
  const base = sealantLaunchLayer(
    created,
    undefined,
    workspaceStops,
    spawned,
    undefined,
    undefined,
    ptyStates,
    undefined,
    undefined,
    execCalls,
    undefined,
    {
      exec: harvestExecOf("claude", PROVIDER),
      ...(options.answerExec === undefined ? {} : { execEffect: options.answerExec }),
      ...(options.openFailsWhile === undefined ? {} : { openFails: options.openFailsWhile }),
      ...(options.firstRunSettlesOn === undefined
        ? {}
        : {
            record: () => Stream.empty,
            waitRun: () => {
              runsWaited += 1;
              return runsWaited === 1 && options.firstRunSettlesOn !== undefined
                ? options.firstRunSettlesOn.pipe(Effect.as(fakeExecRun))
                : Effect.never;
            },
          }),
    },
  );
  const sealantLayer = Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client) => ({
      ...client,
      getSession: (workspace, id) =>
        client.getSession(workspace, id).pipe(
          Effect.map((pty) => ({
            ...pty,
            status: async () => {
              const observed = await pty.status();
              if (observed.status === "exited") watcherSaw.get(pty.id)?.();
              return observed;
            },
            close: async () => {
              closes.push(pty.id);
              if (options.closeRefused === true) throw new Error("the platform did not close it");
              if (options.closeAnswersOnceTheWatcherSawTheExit !== true) return;
              const seen = new Promise<void>((resolve) => watcherSaw.set(pty.id, resolve));
              ptyStates.set(pty.id, { status: "exited", exitCode: 0, outputHighWater: 0n });
              await seen;
            },
          })),
        ),
    })),
  ).pipe(Layer.provide(base));
  return {
    created,
    spawned,
    workspaceStops,
    execCalls,
    closes,
    ptyStates,
    attached,
    submitted,
    detached,
    turns,
    layers: {
      sealantLayer,
      protocolHostLayer: detachingProtocolHostLayer(attached, submitted, detached),
      conversationLayer: recordedTurnsLayer(turns, options.beforeTurnsAreRead),
    },
  };
};

const launchConversation = (world: World, tmp: string, prompt?: string) =>
  Effect.gen(function* () {
    const project = yield* setup(tmp, world);
    const engine = yield* SessionEngine;
    const session = yield* engine.provision({
      projectId: project.id,
      harness: "claude",
      label: null,
      name: null,
      ownerUserId: "user-fixture",
      start: { kind: "base", base: null },
    });
    yield* engine.launchProtocol(
      session.id,
      prompt === undefined ? { mode: "protocol" } : { mode: "protocol", prompt },
      "user-fixture",
    );
    const conversation = [...world.processes.values()].find(
      (process) => process.sessionId === session.id && process.kind === "agent-protocol",
    );
    if (conversation === undefined) return yield* Effect.die("no conversation");
    return { engine, project, session, conversation };
  });

const firstTurnCompleted = (
  world: World,
  turns: Array<AgentTurn>,
  storePath: string,
  conversation: SessionProcess,
  options: { readonly status?: AgentTurn["status"]; readonly transcript?: boolean } = {},
) => {
  const named = world.processes.get(conversation.id);
  if (named === undefined) throw new Error("no conversation row");
  world.processes.set(
    conversation.id,
    new SessionProcess({ ...named, providerSessionId: PROVIDER }),
  );
  const turn = completedTurnOf(conversation);
  turns.push(
    options.status === undefined ? turn : new AgentTurn({ ...turn, status: options.status }),
  );
  if (options.transcript !== false) {
    writeHomeTranscript(storePath, conversation.sessionId, "claude", PROVIDER);
  }
};

const codeOf = (error: unknown) =>
  error instanceof SealantPlatformError ? error.code : error instanceof Error ? error.name : null;

const liveOf = (world: World, sessionId: string, kind: SessionProcess["kind"]) =>
  [...world.processes.values()].filter(
    (process) =>
      process.sessionId === sessionId && process.kind === kind && process.exitedAt === null,
  );

describe("a mode switch to the terminal the conversation cannot make (SLNT-142)", () => {
  it("refused for missing saved state, it leaves the conversation running and taking turns", async () => {
    const created: Array<CreateOptions> = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: Array<string> = [];
    let refusal: unknown = null;
    let after: Session | undefined;
    let conversation: SessionProcess | undefined;
    let laterTurn = "not sent";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          refusal = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
          after = world.sessions.get(session.id);
          conversation = [...world.processes.values()].find(
            (process) => process.sessionId === session.id && process.kind === "agent-protocol",
          );
          const turn = yield* engine
            .submitTurn(session.id, "still here?", "user-fixture")
            .pipe(Effect.result);
          laterTurn = Result.isSuccess(turn) ? "delivered" : turn.failure._tag;
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: detachingProtocolHostLayer(attached, submitted),
      },
    );
    expect(refusal).toBeInstanceOf(SealantPlatformError);
    expect(refusal instanceof SealantPlatformError ? refusal.code : null).toBe(
      "mode_switch_state_missing",
    );
    expect.soft(after?.status).toBe("running");
    expect.soft(conversation?.exitedAt).toBeNull();
    expect.soft(laterTurn).toBe("delivered");
    expect.soft(submitted).toEqual(["still here?"]);
    expect(attached).toHaveLength(1);
  }, 30_000);

  it.each([
    ["the capture store", true],
    ["the co-located store", false],
  ] as const)(
    "on %s, a completed turn with no transcript saved is refused before anything of the conversation stops",
    async (_store, captured) => {
      const run = conversationWorld();
      let refusal: unknown = null;
      let before: SessionProcess | undefined;
      let after: SessionProcess | undefined;
      let status: string | undefined;
      let manifestWritten = true;
      let laterTurn = "not sent";
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, project, session, conversation } = yield* launchConversation(
              world,
              tmp,
              "say hi",
            );
            firstTurnCompleted(world, run.turns, project.storePath, conversation, {
              transcript: false,
            });
            before = world.processes.get(conversation.id);
            refusal = yield* engine
              .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
              .pipe(Effect.flip);
            after = world.processes.get(conversation.id);
            status = world.sessions.get(session.id)?.status;
            manifestWritten = fs.existsSync(
              path.join(
                processStatePathOf(project.storePath, session.id, conversation.id),
                "manifest.json",
              ),
            );
            const turn = yield* engine
              .submitTurn(session.id, "still here?", "user-fixture")
              .pipe(Effect.result);
            laterTurn = Result.isSuccess(turn) ? "delivered" : turn.failure._tag;
          }),
        captured ? { ...run.layers, captured: makeMemoryCaptureStore() } : run.layers,
      );
      expect(codeOf(refusal)).toBe("mode_switch_state_missing");
      expect(refusal instanceof SealantPlatformError ? refusal.message : null).toBe(
        "Nothing to continue in a terminal yet · wait for the first reply, then try again",
      );
      expect.soft(run.detached, "nothing let the conversation go").toEqual([]);
      expect.soft(run.closes, "nothing closed").toEqual([]);
      expect.soft(after, "the conversation's row as it was").toEqual(before);
      expect.soft(manifestWritten, "no saved state written").toBe(false);
      expect.soft(run.execCalls.some((argv) => argv[2] === HARVEST_ARCHIVE)).toBe(false);
      expect.soft(status).toBe("running");
      expect.soft(laterTurn).toBe("delivered");
      expect(run.attached).toHaveLength(1);
    },
    30_000,
  );

  it("a first turn still running is refused, though its transcript is there, and the conversation goes on", async () => {
    const run = conversationWorld();
    let refusal: unknown = null;
    let status: string | undefined;
    let conversationEnded: unknown = "not read";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          firstTurnCompleted(world, run.turns, project.storePath, conversation, {
            status: "running",
          });
          refusal = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
          status = world.sessions.get(session.id)?.status;
          conversationEnded = world.processes.get(conversation.id)?.exitedAt;
        }),
      run.layers,
    );
    expect(codeOf(refusal)).toBe("mode_switch_state_missing");
    expect.soft(run.closes).toEqual([]);
    expect.soft(conversationEnded).toBeNull();
    expect.soft(status).toBe("running");
    expect(run.spawned.some((argv) => argv.includes("--resume"))).toBe(false);
  }, 30_000);

  it("a terminal that fails to open after the conversation stopped starts the conversation again, which takes the next turn", async () => {
    let failNextOpen = false;
    const run = conversationWorld({
      openFailsWhile: () => {
        const fails = failNextOpen;
        failNextOpen = false;
        return fails;
      },
    });
    let refusal: unknown = null;
    let status: string | undefined;
    let original: SessionProcess | undefined;
    let conversations: ReadonlyArray<SessionProcess> = [];
    let laterTurn = "not sent";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          firstTurnCompleted(world, run.turns, project.storePath, conversation);
          failNextOpen = true;
          refusal = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
          status = world.sessions.get(session.id)?.status;
          original = world.processes.get(conversation.id);
          conversations = liveOf(world, session.id, "agent-protocol");
          const turn = yield* engine
            .submitTurn(session.id, "still here?", "user-fixture")
            .pipe(Effect.result);
          laterTurn = Result.isSuccess(turn) ? "delivered" : turn.failure._tag;
        }),
      run.layers,
    );
    expect(codeOf(refusal)).toBe("mode_switch_terminal_not_opened");
    expect(refusal instanceof SealantPlatformError ? refusal.message : "").toContain(
      "the conversation goes on",
    );
    expect.soft(original?.exitedAt, "the checked conversation stopped").not.toBeNull();
    expect.soft(conversations, "one conversation runs again").toHaveLength(1);
    expect.soft(conversations[0]?.providerSessionId).toBe(PROVIDER);
    expect.soft(run.attached).toHaveLength(2);
    expect.soft(status).toBe("running");
    expect.soft(laterTurn).toBe("delivered");
    expect(run.submitted.at(-1)).toBe("still here?");
  }, 30_000);
});

describe("a mode switch to the terminal whose conversation the platform does not close (SLNT-142)", () => {
  it("attaches the conversation again, opens no terminal, and the conversation takes the next turn", async () => {
    const run = conversationWorld({ closeRefused: true });
    let refusal: unknown = null;
    let row: SessionProcess | undefined;
    let status: string | undefined;
    let laterTurn = "not sent";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          firstTurnCompleted(world, run.turns, project.storePath, conversation);
          refusal = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
          row = world.processes.get(conversation.id);
          status = world.sessions.get(session.id)?.status;
          const turn = yield* engine
            .submitTurn(session.id, "still here?", "user-fixture")
            .pipe(Effect.result);
          laterTurn = Result.isSuccess(turn) ? "delivered" : turn.failure._tag;
        }),
      run.layers,
    );
    expect(codeOf(refusal)).toBe("conversation_not_stopped");
    expect(refusal instanceof SealantPlatformError ? refusal.message : "").toContain(
      "its open turns were cancelled · the conversation goes on",
    );
    expect.soft(row?.exitedAt).toBeNull();
    expect.soft(run.attached.map((entry) => entry.process.id)).toEqual([row?.id, row?.id]);
    expect.soft(run.spawned.some((argv) => argv.includes("--resume"))).toBe(false);
    expect.soft(status).toBe("running");
    expect(laterTurn).toBe("delivered");
  }, 30_000);
});

const switchAfterACompletedTurn = async (closeAnswersOnceTheWatcherSawTheExit: boolean) => {
  const run = conversationWorld({ closeAnswersOnceTheWatcherSawTheExit });
  let outcome = "not switched";
  let status: string | undefined;
  let terminal: SessionProcess | undefined;
  await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const { engine, project, session, conversation } = yield* launchConversation(
          world,
          tmp,
          "say hi",
        );
        firstTurnCompleted(world, run.turns, project.storePath, conversation);
        const switched = yield* engine
          .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
          .pipe(Effect.result);
        outcome = Result.isSuccess(switched) ? "switched" : (codeOf(switched.failure) ?? "failed");
        status = world.sessions.get(session.id)?.status;
        terminal = liveOf(world, session.id, "agent-pty")[0];
      }),
    run.layers,
  );
  const argv = run.spawned.at(-1) ?? [];
  return {
    outcome,
    status,
    terminal,
    resumed: argv[argv.indexOf("--resume") + 1] ?? null,
    workspaceStops: run.workspaceStops,
  };
};

describe("a mode switch to the terminal racing the process watcher (SLNT-142, SLNT-147)", () => {
  it("continues a conversation with a completed turn as a terminal", async () => {
    const run = await switchAfterACompletedTurn(false);
    expect(run.outcome).toBe("switched");
    expect(run.status).toBe("running");
    expect(run.terminal).toBeDefined();
    expect(run.resumed).toBe(PROVIDER);
  }, 30_000);

  it("continues it as a terminal when the watcher records the conversation's end first", async () => {
    const run = await switchAfterACompletedTurn(true);
    expect.soft(run.outcome).toBe("switched");
    expect.soft(run.status).toBe("running");
    expect.soft(run.terminal).toBeDefined();
    expect.soft(run.resumed).toBe(PROVIDER);
    expect.soft(run.workspaceStops, "the workspace the terminal starts in kept").toEqual([]);
  }, 30_000);
});

describe("a mode switch to the terminal beside the conversation's own end (SLNT-142)", () => {
  it("one asked while the watcher records the conversation's exit waits for that end, its harvest included, and continues from what it saved", async () => {
    const harvestStarted = Deferred.makeUnsafe<void>();
    const releaseHarvest = Deferred.makeUnsafe<void>();
    const run = conversationWorld({
      answerExec: (argv) =>
        argv[2] === HARVEST_ARCHIVE
          ? Deferred.succeed(harvestStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseHarvest)),
              Effect.as({ exitCode: 0, stdout: "eA==", stderr: "" }),
            )
          : undefined,
    });
    let outcome = "not switched";
    let terminal: SessionProcess | undefined;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          firstTurnCompleted(world, run.turns, project.storePath, conversation, {
            transcript: false,
          });
          const pty = conversation.sealantSessionId;
          if (pty === null) return yield* Effect.die("no pipe");
          run.ptyStates.set(pty, { status: "exited", exitCode: 0, outputHighWater: 0n });
          yield* Deferred.await(harvestStarted);
          const switched = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.sleep("200 millis");
          yield* Deferred.succeed(releaseHarvest, undefined);
          const result = yield* Fiber.join(switched);
          outcome = Result.isSuccess(result) ? "switched" : (codeOf(result.failure) ?? "failed");
          terminal = liveOf(world, session.id, "agent-pty")[0];
        }),
      run.layers,
    );
    const argv = run.spawned.at(-1) ?? [];
    expect(outcome).toBe("switched");
    expect(terminal).toBeDefined();
    expect(argv[argv.indexOf("--resume") + 1]).toBe(PROVIDER);
  }, 30_000);

  it("a Stop while a switch saves the conversation stops the session, and neither waits for the other", async () => {
    const harvestStarted = Deferred.makeUnsafe<void>();
    const releaseHarvest = Deferred.makeUnsafe<void>();
    const run = conversationWorld({
      answerExec: (argv) =>
        argv[2] === HARVEST_ARCHIVE
          ? Deferred.succeed(harvestStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseHarvest)),
              Effect.as({ exitCode: 0, stdout: "eA==", stderr: "" }),
            )
          : undefined,
    });
    let stopped = "not stopped";
    let outcome = "not switched";
    let status: string | undefined;
    let live = -1;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          firstTurnCompleted(world, run.turns, project.storePath, conversation);
          const switched = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(harvestStarted);
          const stop = yield* engine
            .stop(session.id)
            .pipe(Effect.timeout("10 seconds"), Effect.result);
          stopped = Result.isSuccess(stop) ? "stopped" : "stop did not return";
          yield* Deferred.succeed(releaseHarvest, undefined);
          const result = yield* Fiber.join(switched).pipe(Effect.timeout("10 seconds"));
          outcome = Result.isSuccess(result) ? "switched" : (codeOf(result.failure) ?? "failed");
          status = world.sessions.get(session.id)?.status;
          live = [
            ...liveOf(world, session.id, "agent-pty"),
            ...liveOf(world, session.id, "agent-protocol"),
          ].length;
        }),
      run.layers,
    );
    expect(stopped).toBe("stopped");
    expect(outcome).not.toBe("switched");
    expect.soft(live, "nothing runs after the Stop").toBe(0);
    expect.soft(run.attached, "the conversation was not started again").toHaveLength(1);
    expect(status).toBe("stopped");
  }, 30_000);
});

const EARLIER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NEWER = "9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f";

const homeTranscriptOf = (storePath: string, sessionId: string, providerSessionId: string) =>
  path.join(harnessHomePathOf(storePath, sessionId), transcriptIn("claude", providerSessionId));

const answeringNewerAsLatest = (argv: ReadonlyArray<string>) =>
  argv[2] === claudeHarness.latestTranscript
    ? Effect.succeed({
        exitCode: 0,
        stdout: `/home/agent/${transcriptIn("claude", NEWER)}\n`,
        stderr: "",
      })
    : undefined;

describe("a mode switch to the terminal continues the conversation it checked (SLNT-142)", () => {
  it("one whose run ends first waits for the run's end, its harvest included, and continues from what it saved", async () => {
    const runEnds = Deferred.makeUnsafe<void>();
    const harvestStarted = Deferred.makeUnsafe<void>();
    const releaseHarvest = Deferred.makeUnsafe<void>();
    const run = conversationWorld({
      firstRunSettlesOn: Deferred.await(runEnds),
      answerExec: (argv) =>
        argv[2] === HARVEST_ARCHIVE
          ? Deferred.succeed(harvestStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseHarvest)),
              Effect.as({ exitCode: 0, stdout: "eA==", stderr: "" }),
            )
          : undefined,
    });
    let outcome = "not switched";
    let terminal: SessionProcess | undefined;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          firstTurnCompleted(world, run.turns, project.storePath, conversation, {
            transcript: false,
          });
          yield* Deferred.succeed(runEnds, undefined);
          yield* Deferred.await(harvestStarted);
          const switched = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.sleep("200 millis");
          yield* Deferred.succeed(releaseHarvest, undefined);
          const result = yield* Fiber.join(switched);
          outcome = Result.isSuccess(result) ? "switched" : (codeOf(result.failure) ?? "failed");
          terminal = liveOf(world, session.id, "agent-pty")[0];
        }),
      run.layers,
    );
    const argv = run.spawned.at(-1) ?? [];
    expect(outcome).toBe("switched");
    expect(terminal).toBeDefined();
    expect(argv[argv.indexOf("--resume") + 1]).toBe(PROVIDER);
  }, 30_000);

  it.each([
    ["opens", false],
    ["does not open, and the conversation starts again", true],
  ] as const)(
    "a home holding a newer conversation than the one checked: the terminal %s on the checked one",
    async (_case, terminalFails) => {
      let failNextOpen = false;
      const run = conversationWorld({
        answerExec: answeringNewerAsLatest,
        openFailsWhile: () => {
          const fails = failNextOpen;
          failNextOpen = false;
          return fails;
        },
      });
      let outcome = "not switched";
      let conversations: ReadonlyArray<SessionProcess> = [];
      let sessionProvider: string | null = null;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, project, session, conversation } = yield* launchConversation(
              world,
              tmp,
              "say hi",
            );
            firstTurnCompleted(world, run.turns, project.storePath, conversation);
            writeHomeTranscript(project.storePath, session.id, "claude", NEWER);
            const later = new Date(Date.now() + 60_000);
            fs.utimesSync(homeTranscriptOf(project.storePath, session.id, NEWER), later, later);
            failNextOpen = terminalFails;
            const switched = yield* engine
              .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
              .pipe(Effect.result);
            outcome = Result.isSuccess(switched)
              ? "switched"
              : (codeOf(switched.failure) ?? "failed");
            conversations = liveOf(world, session.id, "agent-protocol");
            sessionProvider = world.sessions.get(session.id)?.providerSessionId ?? null;
          }),
        run.layers,
      );
      const argv = run.spawned.at(-1) ?? [];
      if (terminalFails) {
        expect(outcome).toBe("mode_switch_terminal_not_opened");
        expect.soft(conversations).toHaveLength(1);
        expect.soft(conversations[0]?.providerSessionId ?? null).not.toBe(NEWER);
        expect.soft(argv.join(" ")).toContain(PROVIDER);
        expect(argv.join(" ")).not.toContain(NEWER);
      } else {
        expect(outcome).toBe("switched");
        expect(argv[argv.indexOf("--resume") + 1]).toBe(PROVIDER);
      }
      expect(sessionProvider).not.toBe(NEWER);
    },
    30_000,
  );

  it.skipIf(process.getuid?.() === 0)(
    "a transcript that does not read is refused before anything of the conversation stops",
    async () => {
      const run = conversationWorld();
      let refusal: unknown = null;
      let before: SessionProcess | undefined;
      let after: SessionProcess | undefined;
      let status: string | undefined;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, project, session, conversation } = yield* launchConversation(
              world,
              tmp,
              "say hi",
            );
            firstTurnCompleted(world, run.turns, project.storePath, conversation);
            fs.chmodSync(homeTranscriptOf(project.storePath, session.id, PROVIDER), 0o000);
            before = world.processes.get(conversation.id);
            refusal = yield* engine
              .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
              .pipe(Effect.flip);
            after = world.processes.get(conversation.id);
            status = world.sessions.get(session.id)?.status;
          }),
        run.layers,
      );
      expect(codeOf(refusal)).toBe("mode_switch_state_unreadable");
      expect(refusal instanceof SealantPlatformError ? refusal.message : "").toContain(
        "nothing was stopped",
      );
      expect.soft(run.detached).toEqual([]);
      expect.soft(run.closes).toEqual([]);
      expect.soft(after).toEqual(before);
      expect.soft(run.execCalls.some((argv) => argv[2] === HARVEST_ARCHIVE)).toBe(false);
      expect(status).toBe("running");
    },
    30_000,
  );

  it("a completed turn of an earlier conversation of the session does not let a new one with no reply yet switch", async () => {
    const run = conversationWorld();
    let refusal: unknown = null;
    let ended: unknown = "not read";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          const earlier = new SessionProcess({
            ...conversation,
            id: SessionProcessId.make("process-earlier-conversation"),
            providerSessionId: EARLIER,
            exitedAt: now(),
          });
          world.processes.set(earlier.id, earlier);
          run.turns.push(completedTurnOf(earlier));
          writeHomeTranscript(project.storePath, session.id, "claude", EARLIER);
          const current = world.processes.get(conversation.id);
          if (current === undefined) return yield* Effect.die("no conversation row");
          world.processes.set(
            conversation.id,
            new SessionProcess({ ...current, providerSessionId: PROVIDER }),
          );
          writeHomeTranscript(project.storePath, session.id, "claude", PROVIDER);
          refusal = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
          ended = world.processes.get(conversation.id)?.exitedAt;
        }),
      run.layers,
    );
    expect(codeOf(refusal)).toBe("mode_switch_state_missing");
    expect.soft(run.closes).toEqual([]);
    expect(ended).toBeNull();
  }, 30_000);

  it("a harvest that dies after the conversation stopped starts the conversation again, which takes the next turn", async () => {
    let died = false;
    const run = conversationWorld({
      answerExec: (argv) => {
        if (argv[2] !== HARVEST_ARCHIVE || died) return undefined;
        died = true;
        return Effect.die(new Error("the executor broke"));
      },
    });
    let refusal: unknown = null;
    let conversations: ReadonlyArray<SessionProcess> = [];
    let laterTurn = "not sent";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          firstTurnCompleted(world, run.turns, project.storePath, conversation);
          refusal = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
          conversations = liveOf(world, session.id, "agent-protocol");
          const turn = yield* engine
            .submitTurn(session.id, "still here?", "user-fixture")
            .pipe(Effect.result);
          laterTurn = Result.isSuccess(turn) ? "delivered" : turn.failure._tag;
        }),
      run.layers,
    );
    expect(codeOf(refusal)).toBe("mode_switch_terminal_not_opened");
    expect.soft(conversations).toHaveLength(1);
    expect.soft(conversations[0]?.providerSessionId).toBe(PROVIDER);
    expect(laterTurn).toBe("delivered");
  }, 30_000);

  it("a Stop while the switch checks the conversation settles the session and frees its workspace before the switch ends", async () => {
    let holdTurns = false;
    const checking = Deferred.makeUnsafe<void>();
    const resumeCheck = Deferred.makeUnsafe<void>();
    const run = conversationWorld({
      beforeTurnsAreRead: () =>
        holdTurns
          ? Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(resumeCheck)))
          : Effect.void,
    });
    let stopped = "not stopped";
    let statusDuring: string | undefined;
    let freedDuring: ReadonlyArray<string> = [];
    let outcome = "not switched";
    let statusAfter: string | undefined;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          firstTurnCompleted(world, run.turns, project.storePath, conversation);
          holdTurns = true;
          const switched = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(checking);
          holdTurns = false;
          const stop = yield* engine
            .stop(session.id)
            .pipe(Effect.timeout("10 seconds"), Effect.result);
          stopped = Result.isSuccess(stop) ? "stopped" : "stop did not return";
          for (let polls = 0; polls < 50 && run.workspaceStops.length === 0; polls += 1) {
            yield* Effect.sleep("100 millis");
          }
          statusDuring = world.sessions.get(session.id)?.status;
          freedDuring = [...run.workspaceStops];
          yield* Deferred.succeed(resumeCheck, undefined);
          const result = yield* Fiber.join(switched).pipe(Effect.timeout("10 seconds"));
          outcome = Result.isSuccess(result) ? "switched" : (codeOf(result.failure) ?? "failed");
          statusAfter = world.sessions.get(session.id)?.status;
        }),
      run.layers,
    );
    expect(stopped).toBe("stopped");
    expect.soft(statusDuring, "the switch still checking").not.toBe("running");
    expect.soft(freedDuring, "the Stop's sweep, not refused as in use").not.toEqual([]);
    expect.soft(outcome).not.toBe("switched");
    expect.soft(run.attached, "nothing started again").toHaveLength(1);
    expect(statusAfter).toBe("stopped");
  }, 30_000);

  it("an end its run reports while a refused switch checks the conversation is recorded once the switch lets it go", async () => {
    let holdTurns = false;
    const checking = Deferred.makeUnsafe<void>();
    const resumeCheck = Deferred.makeUnsafe<void>();
    const runEnds = Deferred.makeUnsafe<void>();
    const run = conversationWorld({
      firstRunSettlesOn: Deferred.await(runEnds),
      beforeTurnsAreRead: () =>
        holdTurns
          ? Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(resumeCheck)))
          : Effect.void,
    });
    let refusal: unknown = null;
    let ended: Date | null | undefined;
    let status: string | undefined;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session, conversation } = yield* launchConversation(
            world,
            tmp,
            "say hi",
          );
          firstTurnCompleted(world, run.turns, project.storePath, conversation, {
            transcript: false,
          });
          holdTurns = true;
          const switched = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(checking);
          holdTurns = false;
          yield* Deferred.succeed(runEnds, undefined);
          yield* Effect.sleep("300 millis");
          yield* Deferred.succeed(resumeCheck, undefined);
          refusal = yield* Fiber.join(switched);
          for (let polls = 0; polls < 50; polls += 1) {
            ended = world.processes.get(conversation.id)?.exitedAt;
            if (ended !== null && ended !== undefined) break;
            yield* Effect.sleep("100 millis");
          }
          status = world.sessions.get(session.id)?.status;
        }),
      run.layers,
    );
    expect(codeOf(refusal)).toBe("mode_switch_state_missing");
    expect.soft(ended ?? null, "the run's end recorded").not.toBeNull();
    expect(status).not.toBe("running");
  }, 30_000);
});
