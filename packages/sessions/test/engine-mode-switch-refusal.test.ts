import * as fs from "node:fs";
import * as path from "node:path";

import { AgentTurn, Session, SessionProcess } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  HARNESS_STATE,
  harvestHarnessStateScript,
  ProtocolHost,
  ProtocolHostNotLiveError,
  SessionEngine,
} from "@mend/sessions";
import { processStatePathOf } from "@mend/store";
import type { CreateOptions, InteractiveSessionStatus } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  completedTurnOf,
  harvestExecOf,
  recordedTurnsLayer,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
  type World,
  writeHomeTranscript,
} from "./engine/fixture.ts";

/**
 * The recording host, made to refuse a turn to a process it has let go, as the real host does: a
 * conversation the engine detached takes no more turns.
 */
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

/**
 * A claude conversation's world: what the platform was asked (creates, opens, PTY closes,
 * workspace stops, execs), what the protocol host attached, sent and let go, and the session's
 * turns as the conversation store holds them. `watcherFirst`: the platform ends the process
 * inside its close and answers the close only once the engine's process watcher (a 2 s poll) has
 * seen the exit, as in the vscode lane's r2a and r3a. `openFails`: the next `sessions.open`
 * fails while it answers true. `exec`: a command inside the executor as an effect, before the
 * harvest's own answers.
 */
const conversationWorld = (
  options: {
    readonly watcherFirst?: boolean;
    readonly closeFails?: boolean;
    readonly openFails?: () => boolean;
    readonly exec?: (argv: ReadonlyArray<string>) =>
      | Effect.Effect<{
          readonly exitCode: number;
          readonly stdout: string;
          readonly stderr: string;
        }>
      | undefined;
  } = {},
) => {
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
      ...(options.exec === undefined ? {} : { execEffect: options.exec }),
      ...(options.openFails === undefined ? {} : { openFails: options.openFails }),
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
              if (options.closeFails === true) throw new Error("the platform did not close it");
              if (options.watcherFirst !== true) return;
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
      conversationLayer: recordedTurnsLayer(turns),
    },
  };
};

/** A claude conversation of a new session, launched with `prompt` (none: no turn ran). */
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

/**
 * The conversation's first turn ran and completed, as claude leaves one: the turn on record, and
 * its transcript, named by the conversation's provider id, in the harness home (`transcript`).
 */
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
          // A conversation launched with no prompt: no turn has run, so no transcript exists.
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
      openFails: () => {
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
    const run = conversationWorld({ closeFails: true });
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
      "the conversation goes on",
    );
    expect.soft(row?.exitedAt).toBeNull();
    expect.soft(run.attached.map((entry) => entry.process.id)).toEqual([row?.id, row?.id]);
    expect.soft(run.spawned.some((argv) => argv.includes("--resume"))).toBe(false);
    expect.soft(status).toBe("running");
    expect(laterTurn).toBe("delivered");
  }, 30_000);
});

/** A claude conversation with a completed turn, switched to the terminal. */
const switchAfterACompletedTurn = async (watcherFirst: boolean) => {
  const run = conversationWorld({ watcherFirst });
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
      exec: (argv) =>
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
          // Its transcript is only where the harvest reads it, in the running workspace.
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
      exec: (argv) =>
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
