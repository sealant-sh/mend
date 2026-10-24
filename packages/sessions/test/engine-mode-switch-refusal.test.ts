import { Session, SessionProcess } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  HARNESS_STATE,
  harvestHarnessStateScript,
  ProtocolHost,
  ProtocolHostNotLiveError,
  SessionEngine,
} from "@mend/sessions";
import type { CreateOptions, InteractiveSessionStatus } from "@sealant/sdk";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
} from "./engine/fixture.ts";

/**
 * The recording host, made to refuse a turn to a process it has let go, as the real host does: a
 * conversation the engine detached takes no more turns.
 */
const detachingProtocolHostLayer = (
  attached: Array<{ readonly process: SessionProcess; readonly mode: string }>,
  submitted: Array<string>,
) =>
  Layer.effect(
    ProtocolHost,
    Effect.map(ProtocolHost, (host) => {
      const detached = new Set<string>();
      const live = () => {
        const current = attached.at(-1)?.process.id;
        return current !== undefined && !detached.has(current);
      };
      return {
        ...host,
        has: (processId) => Effect.sync(() => !detached.has(processId)),
        detach: (processId) => Effect.sync(() => void detached.add(processId)),
        detachForHandOver: (processId) => Effect.sync(() => void detached.add(processId)),
        submitTurn: (sessionId, input, author, correlation) =>
          Effect.suspend(() =>
            live()
              ? host.submitTurn(sessionId, input, author, correlation)
              : Effect.fail(new ProtocolHostNotLiveError({ processId: "detached" })),
          ),
      };
    }),
  ).pipe(Layer.provide(recordingProtocolHostLayer(attached, submitted)));

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
});

const PROVIDER = "5d1c2b7a-9e4f-4a3b-8c6d-0f1e2a3b4c5d";
const TRANSCRIPT = `/home/agent/.claude/projects/-workspace-repo/${PROVIDER}.jsonl`;
const claudeHarness = HARNESS_STATE["claude"];
if (claudeHarness === undefined) throw new Error("no claude harness state shape");

/** The executor's answers to a harvest of a claude whose first turn completed. */
const completedTurnExec = (argv: ReadonlyArray<string>) => {
  if (argv[2] === harvestHarnessStateScript(claudeHarness.paths)) {
    return { exitCode: 0, stdout: "eA==", stderr: "" };
  }
  if (argv[2] === claudeHarness.latestTranscript) {
    return { exitCode: 0, stdout: `${TRANSCRIPT}\n`, stderr: "" };
  }
  if (argv[3] === "mend-read") {
    const line = {
      type: "user",
      sessionId: PROVIDER,
      message: { role: "user", content: "say hi" },
    };
    return { exitCode: 0, stdout: `${JSON.stringify(line)}\n`, stderr: "" };
  }
  return undefined;
};

/**
 * A claude conversation with a completed turn, switched to the terminal. `watcherFirst`: the
 * platform ends the process inside its close and answers the close as soon as the engine's process
 * watcher (a 2 s poll) has seen the exit, as in the vscode lane's r2a and r3a.
 */
const switchAfterACompletedTurn = async (watcherFirst: boolean) => {
  const created: Array<CreateOptions> = [];
  const spawned: Array<ReadonlyArray<string>> = [];
  const ptyStates = new Map<string, InteractiveSessionStatus>();
  const watcherSaw = new Map<string, () => void>();
  const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
  let outcome = "not switched";
  let status: string | undefined;
  let terminal: SessionProcess | undefined;
  const base = sealantLaunchLayer(
    created,
    undefined,
    undefined,
    spawned,
    undefined,
    undefined,
    ptyStates,
    undefined,
    undefined,
    [],
    undefined,
    { exec: completedTurnExec },
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
              if (!watcherFirst) return;
              const seen = new Promise<void>((resolve) => watcherSaw.set(pty.id, resolve));
              ptyStates.set(pty.id, { status: "exited", exitCode: 0, outputHighWater: 0n });
              await seen;
            },
          })),
        ),
    })),
  ).pipe(Layer.provide(base));
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
        yield* engine.launchProtocol(
          session.id,
          { mode: "protocol", prompt: "say hi" },
          "user-fixture",
        );
        const switched = yield* engine
          .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
          .pipe(Effect.result);
        outcome = Result.isSuccess(switched)
          ? "switched"
          : switched.failure instanceof SealantPlatformError
            ? switched.failure.code
            : switched.failure._tag;
        status = world.sessions.get(session.id)?.status;
        terminal = [...world.processes.values()].find(
          (process) =>
            process.sessionId === session.id &&
            process.kind === "agent-pty" &&
            process.exitedAt === null,
        );
      }),
    {
      sealantLayer,
      protocolHostLayer: recordingProtocolHostLayer(attached, []),
    },
  );
  const argv = spawned.at(-1) ?? [];
  return { outcome, status, terminal, resumed: argv[argv.indexOf("--resume") + 1] ?? null };
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
  }, 30_000);
});
