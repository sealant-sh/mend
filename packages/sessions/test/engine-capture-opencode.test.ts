import * as fs from "node:fs";
import * as path from "node:path";

import { WorktreeId } from "@mend/domain";
import { SealantClient } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { processStatePathOf } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, InteractiveSessionStatus, WorkspaceCaptureStatus } from "@sealant/sdk";
import { Effect, Layer, Queue } from "effect";
import { describe, expect } from "vitest";

import { OPENCODE_CAPTURED_SEED } from "../src/harness-seeds.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { restoreConfiguredHarnessHome } from "./engine-capture-launch-fixtures.ts";
import { shipCapturedHarnessHome } from "./engine/capture-fixture.ts";
import {
  EXECUTOR_END_LOOKS,
  POLL_INTERVAL,
  makeEngineClock,
  statusLooks,
} from "./engine/clock-fixture.ts";
import {
  sealantLaunchLayer,
  setup,
  withPreparedEngineEffect,
  type World,
} from "./engine/fixture.ts";
import { writeOpencodeDatabase } from "./opencode-db.ts";

/**
 * What the engine does on its own once an agent's PTY exits, driven on the TestClock: the
 * watcher's 2 s poll (`watchProcess`) reads the exit, `EXECUTOR_END_LOOKS` looks a poll apart
 * find the executor answering nothing (`executorLostOnEnd`), the checkpoint's 2 s register wait
 * (`CHECKPOINT_WAIT`) times out, then the harvest and the settle write the rows the test reads.
 * Every signal comes from a fake the engine reads or writes (the PTY handle it polls, the capture
 * status it asks for, the channel wait it opens, the world rows it writes), never from the clock.
 */
const makeHarvestClock = () =>
  Effect.gen(function* () {
    const clock = yield* makeEngineClock(["sessions", "processes"]);
    const ptyHandles = yield* Queue.make<string>();
    const { looks, captureStatus } = yield* statusLooks;
    const platform = (inner: Layer.Layer<SealantClient>): Layer.Layer<SealantClient> =>
      Layer.effect(
        SealantClient,
        Effect.map(SealantClient, (client) => ({
          ...client,
          getSession: (workspace, sessionId) =>
            client
              .getSession(workspace, sessionId)
              .pipe(Effect.tap(() => Queue.offer(ptyHandles, sessionId))),
        })),
      ).pipe(Layer.provide(inner));
    /** The watcher holds the exited PTY's handle; its next poll, 2 s on, reads the exit. */
    const pollExit = (world: World, ptyId: string, processId: string) =>
      Effect.gen(function* () {
        let handle = yield* Queue.take(ptyHandles);
        while (handle !== ptyId) handle = yield* Queue.take(ptyHandles);
        yield* TestClock.adjust(1_999);
        expect(world.processes.get(processId)?.exitedAt).toBeNull();
        yield* TestClock.adjust(1);
        yield* clock.untilChanged(
          () => world.processes.get(processId)?.exitedAt !== null,
          "the exit observed",
        );
      });
    /**
     * Every look asks the executor's capture status last and sleeps a poll; the executor answers
     * none, and only the last look's silence settles the session (`executor not answering`).
     */
    const executorLooks = (world: World, sessionId: string) =>
      Effect.gen(function* () {
        for (let look = 1; look < EXECUTOR_END_LOOKS; look += 1) {
          yield* Queue.take(looks);
          expect(world.sessions.get(sessionId)?.settledAt).toBeNull();
          yield* TestClock.adjust(POLL_INTERVAL);
        }
        yield* Queue.take(looks);
        yield* clock.untilChanged(
          () => world.sessions.get(sessionId)?.settledAt !== null,
          "the executor's end read",
        );
      });
    return { ...clock, platform, captureStatus, pollExit, executorLooks };
  });
/**
 * An opencode session in capture mode: its harness home rides the worktree's captures, so the
 * database the harvest reads may hold other sessions' conversations too, and what is its own is
 * what the database did not hold when it launched (the launch snapshot). `own` starts a
 * conversation; `none` leaves an empty database; `unattributed` starts one with no launch
 * snapshot kept, so Mend cannot tell it is the session's; `unprompted` starts none beside one
 * its launch snapshot already held, a provable absence.
 */
const verifyOpencodeHarvest = (kind: "own" | "none" | "unattributed" | "unprompted") =>
  Effect.gen(function* () {
    const clock = yield* makeHarvestClock();
    const created: Array<CreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
    const ptyStates = new Map<string, InteractiveSessionStatus>();
    const memory = makeMemoryCaptureStore();
    const relocation = { homePath: "", executorRoot: "", observed: [] as string[] };
    let testRoot = "";
    let finalCapture: Effect.Effect<void> = Effect.die("final capture not prepared");
    let shipped = false;
    let opens = 0;
    const databaseOf = () =>
      path.join(relocation.homePath, ".local", "share", "opencode", "opencode.db");

    yield* withPreparedEngineEffect(
      (world, tmp) => setup(tmp, world),
      (world, tmp, project) =>
        Effect.gen(function* () {
          testRoot = tmp;
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "opencode",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["opencode"]);
          const request = created[0];
          if (request === undefined) throw new Error("cold launch made no create request");
          const executorRoot = relocation.executorRoot;
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          finalCapture = shipCapturedHarnessHome(
            tmp,
            memory,
            session.worktreeId,
            epoch,
            request,
            executorRoot,
          ).pipe(Effect.asVoid, Effect.orDie);

          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-pty" && process.exitedAt === null,
          );
          if (agent?.sealantSessionId === null || agent?.sealantSessionId === undefined) {
            throw new Error("the launch recorded no agent PTY");
          }
          const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
          if (kind === "unattributed") fs.rmSync(path.join(stateDir, "opencode-launch.json"));
          if (kind === "unprompted") {
            fs.writeFileSync(
              path.join(stateDir, "opencode-launch.json"),
              JSON.stringify(["ses_own"]),
            );
          }
          ptyStates.set(agent.sealantSessionId, {
            status: "exited",
            exitCode: 0,
            outputHighWater: 0n,
          });
          yield* clock.pollExit(world, agent.sealantSessionId, agent.id);
          yield* clock.executorLooks(world, session.id);
          if (kind === "unattributed") {
            // A conversation Mend cannot tell is the session's is no answer, not an absence: the
            // session is never hidden as a dead end, and its resume is refused, not guessed.
            yield* clock.untilChanged(
              () => world.sessions.get(session.id)?.settledAt !== null,
              "the first process settle",
            );
            yield* clock.expireCheckpointWait;
            yield* clock.untilChanged(
              () => memory.leases.get(session.worktreeId)?.executorId === null,
              "the harvest and the drain",
            );
            expect(world.sessions.get(session.id)?.hasTranscript).not.toBe(false);
            expect(fs.existsSync(path.join(stateDir, "manifest.json"))).toBe(false);
            const refusal = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);
            expect(String(refusal.message)).toContain(
              "opencode left no conversation Mend can tell is session",
            );
            expect(opens).toBe(1);
            // A shell opens no conversation: the same session resumes as a shell.
            const shell = yield* engine.resumeSession(session.id, "shell");
            expect(shell.status).toBe("running");
            const shellProcess = [...world.processes.values()].findLast(
              (process) => process.exitedAt === null && process.harness === "shell",
            );
            expect(shellProcess).toBeDefined();
            return;
          }
          if (kind === "none" || kind === "unprompted") {
            // Nothing in the database is this session's: no saved state, and the resume says so
            // rather than open the other session's conversation.
            yield* clock.expireCheckpointWait;
            yield* clock.untilChanged(
              () => world.sessions.get(session.id)?.hasTranscript === false,
              "the final capture harvest",
            );
            expect(fs.existsSync(path.join(stateDir, "manifest.json"))).toBe(false);
            yield* clock.untilChanged(
              () => world.sessions.get(session.id)?.settledAt !== null,
              "the first process settle",
            );
            const refusal = yield* engine.resumeSession(session.id, null).pipe(Effect.flip);
            expect(String(refusal.message)).toContain(
              "opencode left no conversation Mend can tell is session",
            );
            expect(opens).toBe(1);
            return;
          }
          // No transcript file, but a conversation of its own: the session is not a dead end.
          yield* clock.expireCheckpointWait;
          yield* clock.untilChanged(
            () => world.sessions.get(session.id)?.hasTranscript === true,
            "the final capture harvest",
          );
          expect(JSON.parse(fs.readFileSync(path.join(stateDir, "manifest.json"), "utf8"))).toEqual(
            expect.objectContaining({ harness: "opencode", providerSessionId: "ses_own" }),
          );
          expect(fs.existsSync(path.join(stateDir, "transcript.native"))).toBe(false);
          expect(world.sessions.get(session.id)?.providerSessionId).toBe("ses_own");

          yield* clock.untilChanged(
            () => world.sessions.get(session.id)?.settledAt !== null,
            "the first process settle",
          );
          const resumed = yield* engine.resumeSession(session.id, null);
          expect(resumed.status).toBe("running");
          const resumedAgent = [...world.processes.values()].findLast(
            (process) => process.kind === "agent-pty" && process.exitedAt === null,
          );
          expect(resumedAgent?.argv).toEqual(["opencode", "--session", "ses_own"]);
          // Both capture launches run behind the seed that keeps MCP logins out of saved state:
          // decided by Mend, not by an environment sealantd never passes on.
          expect(spawned.length).toBe(2);
          for (const argv of spawned)
            expect(argv.slice(0, 3)).toEqual(["sh", "-c", OPENCODE_CAPTURED_SEED]);
          expect(resumedAgent?.providerSessionId).toBe("ses_own");
          expect(opens).toBe(2);
          // Both launches kept what the database held as they started: nothing the first time, the
          // first process's conversation (read from the head capture) the second.
          const kept = (processId: string) =>
            JSON.parse(
              fs.readFileSync(
                path.join(
                  processStatePathOf(project.storePath, session.id, processId),
                  "opencode-launch.json",
                ),
                "utf8",
              ),
            );
          expect(kept(agent.id)).toEqual([]);
          if (resumedAgent === undefined) throw new Error("no resumed agent");
          expect(kept(resumedAgent.id)).toEqual(["ses_own"]);
        }),
      {
        captured: memory,
        drainPolicy: { pollInterval: POLL_INTERVAL },
        prepareWorld: clock.prepareWorld,
        wrapCaptureChannel: clock.wrapCaptureChannel,
        sealantLayer: clock.platform(
          sealantLaunchLayer(
            created,
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            ptyStates,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              relocation,
              captureStatus: clock.captureStatus,
              beforeCreate: (options) =>
                Effect.gen(function* () {
                  relocation.executorRoot = path.join(testRoot, `executor-${created.length}`);
                  relocation.homePath = path.join(relocation.executorRoot, "home", "agent");
                  fs.rmSync(relocation.executorRoot, { recursive: true, force: true });
                  fs.mkdirSync(relocation.executorRoot, { recursive: true });
                  const source = options.source;
                  if (source?.kind !== "capture" || source.worktreeId === undefined) {
                    throw new Error("test executor requires a cold capture source");
                  }
                  yield* restoreConfiguredHarnessHome(
                    testRoot,
                    memory,
                    WorktreeId.make(source.worktreeId),
                    options,
                    relocation.executorRoot,
                  );
                }),
              beforeOpen: () => {
                opens += 1;
                if (opens === 1) {
                  writeOpencodeDatabase(
                    databaseOf(),
                    kind === "none" ? [] : [{ id: "ses_own", createdAt: Date.now() }],
                  );
                  return;
                }
                // The pickup opens on the materialised database.
                expect(fs.existsSync(databaseOf())).toBe(true);
              },
              flush: () =>
                Effect.gen(function* () {
                  if (!shipped) {
                    yield* finalCapture;
                    shipped = true;
                  }
                  return {
                    epoch: 2,
                    worktreeId: "",
                    pending: 0,
                    stagedBytes: 0,
                    uploadedObjects: 1,
                    uploadedBytes: 1,
                    registered: 1,
                    fenced: false,
                    paused: false,
                    refused: [],
                  } satisfies WorkspaceCaptureStatus;
                }),
            },
          ),
        ),
      },
    );
  });

describe("SessionEngine capture mode", () => {
  it.effect(
    "commits the opencode conversation this session started, and a pickup opens it by id, not the newest one",
    () => verifyOpencodeHarvest("own"),
    20_000,
  );

  it.effect(
    "refuses to resume an opencode session none of whose conversations it can tell is its own",
    () => verifyOpencodeHarvest("none"),
    20_000,
  );

  it.effect(
    "leaves an opencode session whose conversation Mend cannot attribute unclassified, never a dead end",
    () => verifyOpencodeHarvest("unattributed"),
    20_000,
  );

  it.effect(
    "reads an opencode session that started no conversation as having none, when its snapshot proves it",
    () => verifyOpencodeHarvest("unprompted"),
    20_000,
  );
});
