import * as fs from "node:fs";
import * as path from "node:path";

import { WorktreeId } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { processStatePathOf } from "@mend/store";
import type { CreateOptions, InteractiveSessionStatus, WorkspaceCaptureStatus } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { OPENCODE_CAPTURED_SEED } from "../src/harness-seeds.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { it } from "./effect-vitest.ts";
import { restoreConfiguredHarnessHome } from "./engine-capture-launch-fixtures.ts";
import { shipCapturedHarnessHome, until } from "./engine/capture-fixture.ts";
import { sealantLaunchLayer, setup, withEngine } from "./engine/fixture.ts";
import { writeOpencodeDatabase } from "./opencode-db.ts";
/**
 * An opencode session in capture mode: its harness home rides the worktree's captures, so the
 * database the harvest reads may hold other sessions' conversations too, and what is its own is
 * what the database did not hold when it launched (the launch snapshot). `own` starts a
 * conversation; `none` leaves an empty database; `unattributed` starts one with no launch
 * snapshot kept, so Mend cannot tell it is the session's; `unprompted` starts none beside one
 * its launch snapshot already held, a provable absence.
 */
const verifyOpencodeHarvest =
  (kind: "own" | "none" | "unattributed" | "unprompted") => async () => {
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

    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          testRoot = tmp;
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "opencode",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
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
          if (kind === "unattributed") {
            // A conversation Mend cannot tell is the session's is no answer, not an absence: the
            // session is never hidden as a dead end, and its resume is refused, not guessed.
            yield* until(
              () => world.sessions.get(session.id)?.settledAt !== null,
              "the first process settle",
            );
            yield* Effect.sleep("1 second");
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
            yield* until(
              () => world.sessions.get(session.id)?.hasTranscript === false,
              "the final capture harvest",
            );
            expect(fs.existsSync(path.join(stateDir, "manifest.json"))).toBe(false);
            yield* until(
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
          yield* until(
            () => world.sessions.get(session.id)?.hasTranscript === true,
            "the final capture harvest",
          );
          expect(JSON.parse(fs.readFileSync(path.join(stateDir, "manifest.json"), "utf8"))).toEqual(
            expect.objectContaining({ harness: "opencode", providerSessionId: "ses_own" }),
          );
          expect(fs.existsSync(path.join(stateDir, "transcript.native"))).toBe(false);
          expect(world.sessions.get(session.id)?.providerSessionId).toBe("ses_own");

          yield* until(
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
        sealantLayer: sealantLaunchLayer(
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
      },
    );
  };

describe("SessionEngine capture mode", () => {
  it(
    "commits the opencode conversation this session started, and a pickup opens it by id, not the newest one",
    { timeout: 20_000 },
    verifyOpencodeHarvest("own"),
  );

  it(
    "refuses to resume an opencode session none of whose conversations it can tell is its own",
    { timeout: 20_000 },
    verifyOpencodeHarvest("none"),
  );

  it(
    "leaves an opencode session whose conversation Mend cannot attribute unclassified, never a dead end",
    { timeout: 20_000 },
    verifyOpencodeHarvest("unattributed"),
  );

  it(
    "reads an opencode session that started no conversation as having none, when its snapshot proves it",
    { timeout: 20_000 },
    verifyOpencodeHarvest("unprompted"),
  );
});
