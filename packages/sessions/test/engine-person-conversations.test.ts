// A shared conversation per person (docs/adr/0016, Deliveries 16 to 18): each person's readers,
// the conversation's home, a terminal takeover, and shared steering through the engine.

import * as path from "node:path";

import {
  AgentConversationRepo,
  AgentMemoryRepo,
  linuxLoginNameOf,
  makeHarnessLayoutsMemoryState,
} from "@mend/db";
import {
  AgentRequestId,
  AgentTurnId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import { AgentRequest, AgentTurn, Session, SessionProcess } from "@mend/domain/workbench";
import {
  type HomeLogins,
  PersonLayoutPlatform,
  type PersonLogin,
  type PersonSessionOptions,
  SealantClient,
  SealantPlatformError,
} from "@mend/sealant";
import {
  NoLiveAgent,
  ProtocolHost,
  type ProtocolHostHooks,
  Restart,
  SessionEngine,
  WorkspaceHostUserNamespaces,
} from "@mend/sessions";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, SessionOptions, Workspace } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer, Queue } from "effect";
import { describe, expect } from "vitest";

import { CLAUDE_AGENT_HOOKS, claudeSettingsOf } from "../src/claude-settings.ts";
import { HAND_OVER_NOT_NOW } from "../src/conversation-steps.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  claudeLine,
  commandOf,
  peopleDir,
  PROJECT_DIR,
  writeUnder,
} from "./engine-person-runtime-fixtures.ts";
import {
  configuredHarnessHomePath,
  headFlush,
  seedStoppedBeforeRestart,
  shipCaptureFiles,
  shipCapturedHarnessHome,
} from "./engine/capture-fixture.ts";
import { signalWrites, signalled, watched } from "./engine/clock-fixture.ts";
import {
  agentConversationStub,
  agentMemoryLayerOf,
  completedTurnOf,
  now,
  recordedTurnsLayer,
  recordingProtocolHostLayer,
  redeemPickupExec,
  sealantLaunchLayer,
  setup,
  transcriptIn,
  transcriptLine,
  type World,
  withEngine,
  withEngineEffect,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";
import {
  LAYOUT_READY,
  MARIA,
  answerLayout,
  isPrepare,
  personPlatform,
} from "./engine/person-fixture.ts";
import { recordedBeforeStart } from "./engine/person-layout-fixture.ts";

describe("readers per person (docs/adr/0016, Delivery 16)", () => {
  it.effect.each([
    ["never shared", false],
    ["Alice's shared once, then turned off", true],
  ] as const)(
    "two people's transcripts and memory in one capture are each read back only for their own person (%s)",
    ([_label, aliceOnceShared]) =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
        /** Woken by every read-back, every session row written and every line the engine logs. */
        const woken = yield* Queue.make<void>();
        const logs: Array<string> = [];
        const push = logs.push.bind(logs);
        logs.push = (...lines) => {
          const length = push(...lines);
          Queue.offerUnsafe(woken, undefined);
          return length;
        };
        const alice = crypto.randomUUID();
        const maria = crypto.randomUUID();
        const old = crypto.randomUUID();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const holder = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(holder.id, ["claude"]);
              const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: MARIA,
              });
              yield* engine.launch(joined.id, ["claude"]);
              const request = created[0];
              if (request === undefined) return yield* Effect.die("the launch made no executor");
              // One executor's harness home, with both people's saved directories in it, and the
              // shared home a pre-release executor left beside them.
              const executorRoot = path.join(tmp, "person-executor");
              const home = configuredHarnessHomePath(request, executorRoot);
              writeUnder(
                home,
                `${peopleDir("user-fixture")}/${PROJECT_DIR}/${alice}.jsonl`,
                claudeLine(alice, "alice's turn"),
              );
              writeUnder(
                home,
                `${peopleDir("user-fixture")}/${PROJECT_DIR}/memory/MEMORY.md`,
                "- alice learned\n",
              );
              writeUnder(
                home,
                `${peopleDir(MARIA)}/${PROJECT_DIR}/${maria}.jsonl`,
                claudeLine(maria, "maria's turn"),
              );
              writeUnder(
                home,
                `${peopleDir(MARIA)}/${PROJECT_DIR}/memory/MEMORY.md`,
                "- maria learned\n",
              );
              writeUnder(home, `${PROJECT_DIR}/${old}.jsonl`, claudeLine(old, "before 0.36"));
              writeUnder(home, `${PROJECT_DIR}/memory/MEMORY.md`, "- the old shared home\n");
              yield* shipCapturedHarnessHome(
                tmp,
                memory,
                holder.worktreeId,
                memory.leases.get(holder.worktreeId)?.epoch ?? 0,
                request,
                executorRoot,
              );

              if (aliceOnceShared) {
                // Shared control was on, then turned off: her session still credits nobody.
                const row = world.sessions.get(holder.id);
                if (row === undefined) return yield* Effect.die("no holder session");
                world.sessions.set(
                  holder.id,
                  new Session({ ...row, sharedControlEverAt: new Date(Date.now() - 60_000) }),
                );
              }
              yield* engine.stop(joined.id);
              yield* signalled(woken)(() => readBacks.length > 0, "Maria's read-back");
              expect(readBacks.map((input) => input.userId)).toEqual([MARIA]);
              expect(readBacks[0]?.session.map((file) => [file.path, file.contents])).toEqual([
                [`${PROJECT_DIR}/memory/MEMORY.md`, "- maria learned\n"],
              ]);
              expect(world.sessions.get(joined.id)?.providerSessionId).toBe(maria);

              yield* engine.stop(holder.id);
              if (aliceOnceShared) {
                yield* signalled(woken)(
                  () => world.sessions.get(holder.id)?.providerSessionId === alice,
                  "Alice's harvest",
                );
                // Her harvest decides whose memory to read back after it, and says what it did.
                yield* signalled(woken)(
                  () => logs.some((line) => line.includes("agent memory not read back")),
                  "the read-back decision",
                );
                expect(readBacks.map((input) => input.userId)).toEqual([MARIA]);
                return;
              }
              yield* signalled(woken)(() => readBacks.length > 1, "Alice's read-back");
              expect(readBacks.map((input) => input.userId)).toEqual([MARIA, "user-fixture"]);
              expect(readBacks[1]?.session.map((file) => [file.path, file.contents])).toEqual([
                [`${PROJECT_DIR}/memory/MEMORY.md`, "- alice learned\n"],
              ]);
              expect(world.sessions.get(holder.id)?.providerSessionId).toBe(alice);
            }),
          {
            captured: memory,
            logs,
            prepareWorld: (world) => {
              world.members.set(MARIA, "member");
              signalWrites(world.sessions, woken);
            },
            agentMemoryLayer: agentMemoryLayerOf({
              readBack: (input) =>
                Effect.sync(() => {
                  readBacks.push(input);
                  Queue.offerUnsafe(woken, undefined);
                  return { saved: [], merged: [], deleted: [], skipped: [] };
                }),
            }),
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              [],
              undefined,
              { flush: headFlush(memory), exec: answerLayout(LAYOUT_READY) },
            ),
            harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
          },
        );
      }),
    { timeout: 30_000 },
  );

  /**
   * A conversation two captures of the worktree's last shared executor hold, then the worktree
   * turns person and Alice resumes it. With `marias`, a pre-release terminal session of Maria's in
   * the same worktree was harvested with the same conversation id.
   */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const resumeAfterSharedEra = (options: { readonly marias: boolean }) =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const execCalls: Array<ReadonlyArray<string>> = [];
      const memory = makeMemoryCaptureStore();
      const state = recordedBeforeStart(makeHarnessLayoutsMemoryState());
      const id = crypto.randomUUID();
      const picked: Array<{ readonly path: string; readonly contents: string }> = [];
      let resumed: SessionId | null = null;
      let summary: string | null = null;
      /** Every session row written: the stop's harvest lands the conversation id on Alice's. */
      const writes = yield* Queue.make<void>();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "before",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            resumed = session.id;
            // The worktree's last shared executor: an earlier capture, then its final one, which
            // holds what the conversation said last.
            yield* engine.launch(session.id, ["claude"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "shared-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            writeUnder(home, `${PROJECT_DIR}/${id}.jsonl`, claudeLine(id, "first"));
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            writeUnder(
              home,
              `${PROJECT_DIR}/${id}.jsonl`,
              `${claudeLine(id, "first")}${claudeLine(id, "last")}`,
            );
            writeUnder(home, `${PROJECT_DIR}/${id}/tool-results/out.txt`, "a tool's output\n");
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            yield* engine.stop(session.id);
            // The harvest runs off the stop's path; its write to her row is the signal.
            yield* signalled(writes)(
              () => world.sessions.get(session.id)?.providerSessionId === id,
              "the shared executor's harvest",
            );
            if (options.marias) {
              // Maria's terminal agent in the same shared home: its harvest took the newest
              // transcript there, Alice's.
              const marias = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: MARIA,
              });
              const row = world.sessions.get(marias.id);
              if (row === undefined) return yield* Effect.die("no session of Maria's");
              world.sessions.set(marias.id, new Session({ ...row, providerSessionId: id }));
            }
            // Then the worktree runs per person, and Alice resumes that conversation.
            state.worktrees.set(session.worktreeId, { layout: "person", requested: null });
            yield* engine.resumeSession(session.id, null);
            summary = world.sessions.get(session.id)?.summary ?? null;
          }),
        {
          captured: memory,
          prepareWorld: (world) => {
            world.members.set(MARIA, "member");
            signalWrites(world.sessions, writes);
          },
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            execCalls,
            undefined,
            {
              flush: headFlush(memory),
              exec: answerLayout(LAYOUT_READY),
              execEffect: (argv) => {
                const command = commandOf(argv);
                if (command[3] !== "mend-write" || !command.some((part) => part.startsWith("A/"))) {
                  return undefined;
                }
                return redeemPickupExec(command, resumed).pipe(
                  Effect.map((answer) => {
                    for (const file of answer.files) {
                      picked.push({
                        path: file.path,
                        contents: Buffer.from(file.base64, "base64").toString("utf8"),
                      });
                    }
                    return { exitCode: 0, stdout: "", stderr: "" };
                  }),
                  Effect.orDie,
                );
              },
            },
          ),
          harnessLayout: { flag: "shared", state, platform: personPlatform([], { person: true }) },
        },
      );
      return { id, picked, execCalls, summary };
    });

  it.effect(
    "a resume copies its conversation from the worktree's last shared-layout capture, the final one, only where its owner has none",
    () =>
      Effect.gen(function* () {
        const { id, picked, execCalls } = yield* resumeAfterSharedEra({ marias: false });
        const P = "/workspace/harness-home/people/user-fixture";
        expect(picked.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
          {
            path: `${P}/${PROJECT_DIR}/${id}.jsonl`,
            contents: `${claudeLine(id, "first")}${claudeLine(id, "last")}`,
          },
          {
            path: `${P}/${PROJECT_DIR}/${id}/tool-results/out.txt`,
            contents: "a tool's output\n",
          },
        ]);
        // Written only where nothing is, 0600, as Alice, into her own saved directory.
        const copies = execCalls.filter(
          (argv) =>
            commandOf(argv)[3] === "mend-write" && argv.some((part) => part.startsWith(`A${P}/`)),
        );
        expect(copies).toHaveLength(1);
        expect(
          commandOf(copies[0] ?? [])
            .slice(5)
            .every((part) => part.startsWith(`A${P}/`)),
        ).toBe(true);
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "a conversation another person's pre-release session also holds is never copied, and the session says so",
    () =>
      Effect.gen(function* () {
        const { picked, summary } = yield* resumeAfterSharedEra({ marias: true });
        expect(picked).toEqual([]);
        expect(summary ?? "").toContain(
          "conversation from before per-person homes not copied · another person's session in this worktree holds it too",
        );
      }),
    { timeout: 30_000 },
  );
});

const isStage = (argv: ReadonlyArray<string>) => (argv[2] ?? "").includes("leftover()");

const isExchange = (argv: ReadonlyArray<string>) =>
  (argv[2] ?? "").includes("nothing is staged for this conversation");

/** A protocol host that records what each attached process resumes by. */
const resumingHost = (
  attached: Array<{ readonly process: SessionProcess; readonly resumePath: string | null }>,
) =>
  Layer.succeed(ProtocolHost, {
    attach: (input) =>
      Effect.sync(() => {
        attached.push({ process: input.process, resumePath: input.resumePath ?? null });
      }),
    rehydrate: () => Effect.void,
    submitTurn: () => Effect.die("not in test"),
    interruptTurn: () => Effect.void,
    respondRequest: () => Effect.die("not in test"),
    detach: () => Effect.void,
    has: () => Effect.succeed(false),
    quiescence: () => Effect.succeed(null),
    awaitQuiescent: () => Effect.void,
    endWork: () => Effect.void,
    detachForHandOver: () => Effect.void,
  });

describe("the conversation home of a shared conversation (docs/adr/0016, Delivery 17)", () => {
  const scenario = (options: {
    readonly harness: "claude" | "codex";
    readonly shared: boolean;
    readonly mode: "protocol" | "pty";
  }) =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const spawned: Array<ReadonlyArray<string>> = [];
      const opened: Array<SessionOptions | PersonSessionOptions> = [];
      const execCalls: Array<ReadonlyArray<string>> = [];
      const calls: Array<string> = [];
      const attached: Array<{
        readonly process: SessionProcess;
        readonly resumePath: string | null;
      }> = [];
      const state = makeHarnessLayoutsMemoryState();
      const provider =
        options.harness === "claude"
          ? "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11"
          : "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
      let sessionId: SessionId | null = null;
      let afterFirst: { readonly execs: number; readonly calls: number } = { execs: 0, calls: 0 };
      const exec = (argv: ReadonlyArray<string>) => {
        if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
        const script = argv[2] ?? "";
        if (isStage(argv)) {
          const home = `/run/mend/conv/${sessionId ?? ""}`;
          const resume = !script.includes(provider)
            ? ""
            : options.harness === "claude"
              ? `mend-conv resume ${home}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
              : `mend-conv resume ${home}/.codex/sessions/2026/10/07/rollout-2026-10-07T10-00-00-${provider}.jsonl\n`;
          const moved = script.includes("moved=0") ? "mend-conv moved 2\n" : "";
          return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
        }
        if (isExchange(argv)) {
          return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
        }
        return undefined;
      };
      /** Every session row written, and every call the platform logs. */
      const writes = yield* Queue.make<void>();
      const logged = yield* Queue.make<void>();
      const push = calls.push.bind(calls);
      calls.push = (...lines) => {
        const length = push(...lines);
        Queue.offerUnsafe(logged, undefined);
        return length;
      };
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: options.harness,
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            sessionId = session.id;
            if (options.shared) {
              const row = world.sessions.get(session.id);
              if (row === undefined) return yield* Effect.die("no session");
              world.sessions.set(
                session.id,
                new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
              );
            }
            if (options.mode === "pty") {
              yield* engine.launch(session.id, [options.harness]);
              return;
            }
            yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
            afterFirst = { execs: execCalls.length, calls: calls.length };
            // The conversation has a provider id now, as its first process's harvest leaves it.
            const first = [...world.processes.values()].findLast(
              (process) => process.sessionId === session.id && process.kind === "agent-protocol",
            );
            if (first === undefined) return yield* Effect.die("no protocol process");
            world.processes.set(
              first.id,
              new SessionProcess({ ...first, providerSessionId: provider }),
            );
            yield* engine.stop(session.id);
            // The stop settles the session and, off its path, releases the home's login: the row's
            // write and the platform's call are the signals, before the resume asks for H again.
            yield* signalled(writes)(
              () => world.sessions.get(session.id)?.settledAt !== null,
              "the stop's settle",
            );
            const home = `/run/mend/conv/${session.id}`;
            if (calls.includes(`post:user-fixture:${home}`)) {
              yield* signalled(logged)(
                () => calls.includes(`delete:${home}`),
                "H's login released",
              );
            }
            yield* engine.resumeSession(session.id, null);
          }),
        {
          captured: makeMemoryCaptureStore(),
          prepareWorld: (world) => {
            world.members.set(MARIA, "member");
            signalWrites(world.sessions, writes);
          },
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            undefined,
            opened,
            undefined,
            execCalls,
            undefined,
            { exec },
          ),
          protocolHostLayer: resumingHost(attached),
          harnessLayout: {
            flag: "person",
            state,
            platform: personPlatform(calls, { person: true }),
          },
        },
      );
      if (sessionId === null) throw new Error("no session");
      return {
        sessionId,
        spawned,
        opened,
        execCalls,
        calls,
        attached,
        state,
        afterFirst,
        provider,
      };
    });

  it.effect(
    "a shared Claude conversation moves into C once and runs in its home as its sender, in the neutral context",
    () =>
      Effect.gen(function* () {
        const run = yield* scenario({ harness: "claude", shared: true, mode: "protocol" });
        const home = `/run/mend/conv/${run.sessionId}`;
        // First start: the move, as the owner, then the exchange; Core writes the owner's login into H.
        const firstExecs = run.execCalls.slice(0, run.afterFirst.execs);
        const stages = firstExecs.filter(isStage);
        expect(stages).toHaveLength(1);
        expect(stages[0]?.[2]).toContain("moved=0");
        expect(firstExecs.filter(isExchange)).toHaveLength(1);
        expect(run.calls.slice(0, run.afterFirst.calls)).toContain(`post:user-fixture:${home}`);
        expect(run.state.sharedConversations.get(run.sessionId)?.owner).toBe("user-fixture");
        // Started directly, with the neutral settings file: no seed, no shell profile.
        const agentArgv = run.spawned.filter((argv) => argv.includes("stream-json"));
        expect(agentArgv[0]?.[0]).toBe("claude");
        expect(agentArgv[0]?.slice(-2)).toEqual([
          "--settings",
          JSON.stringify({
            autoMemoryEnabled: false,
            env: {
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
              CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
              CLAUDE_CODE_DISABLE_CRON: "1",
              CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
            },
          }),
        ]);
        const agentOptions = run.opened.filter(
          (options) => "env" in options && options.env?.["CLAUDE_CONFIG_DIR"] !== undefined,
        );
        expect(agentOptions[0]?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`${home}/.claude`);
        expect(agentOptions[0]?.env?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
        expect(agentOptions[0]?.env?.["CLAUDE_CODE_DISABLE_CRON"]).toBe("1");
        // The process says whose user it runs as.
        expect(run.attached[0]?.process.runsAs).toBe("user-fixture");
        // Stopped: the conversation is free and H's login released.
        expect(run.calls).toContain(`delete:${home}`);
        // Resumed: no move again, and Claude resumes by the full path of its transcript in C, via H.
        const resumeStages = run.execCalls.slice(run.afterFirst.execs).filter(isStage);
        expect(resumeStages).toHaveLength(1);
        expect(resumeStages[0]?.[2]).not.toContain("moved=0");
        const resumed = agentArgv.at(-1) ?? [];
        expect(resumed[resumed.indexOf("--resume") + 1]).toBe(
          `${home}/.claude/projects/-workspace-repo/${run.provider}.jsonl`,
        );
        // One live process per conversation: the resumed one holds it now.
        const last = run.attached.at(-1)?.process;
        expect(run.state.conversationHolders.get(run.sessionId)?.processId).toBe(last?.id);
      }),
    30_000,
  );

  it.effect(
    "a shared Codex conversation runs with HOME and its index at H, and resumes by its rollout's path",
    () =>
      Effect.gen(function* () {
        const run = yield* scenario({ harness: "codex", shared: true, mode: "protocol" });
        const home = `/run/mend/conv/${run.sessionId}`;
        const agentOptions = run.opened.filter(
          (options) => "env" in options && options.env?.["CODEX_HOME"] !== undefined,
        );
        expect(agentOptions[0]?.env?.["HOME"]).toBe(home);
        expect(agentOptions[0]?.env?.["CODEX_SQLITE_HOME"]).toBe(`${home}/.codex`);
        const agentArgv = run.spawned.filter((argv) => argv.includes("app-server"));
        expect(agentArgv[0]).toEqual([
          "codex",
          "-c",
          "features.memories=false",
          "-c",
          "features.plugins=false",
          "-c",
          "features.daemon_auto_start=false",
          "-c",
          "features.shell_snapshot=false",
          "app-server",
        ]);
        expect(run.attached.at(-1)?.resumePath).toBe(
          `${home}/.codex/sessions/2026/10/07/rollout-2026-10-07T10-00-00-${run.provider}.jsonl`,
        );
        expect(run.calls.filter((call) => call === `post:user-fixture:${home}`)).toHaveLength(2);
      }),
    30_000,
  );

  it.effect(
    "a conversation never shared runs in its owner's own home, as before",
    () =>
      Effect.gen(function* () {
        const run = yield* scenario({ harness: "claude", shared: false, mode: "protocol" });
        expect(run.execCalls.filter(isStage)).toHaveLength(0);
        expect(run.calls.some((call) => call.includes("/run/mend/conv/"))).toBe(false);
        expect(run.state.sharedConversations.size).toBe(0);
        // Still one live process per conversation.
        expect(run.state.conversationHolders.size).toBe(0);
      }),
    30_000,
  );

  it.effect(
    "Shared control on a terminal session changes nothing: no move, no conversation home, the owner's own context",
    () =>
      Effect.gen(function* () {
        const run = yield* scenario({ harness: "claude", shared: true, mode: "pty" });
        expect(run.execCalls.filter(isStage)).toHaveLength(0);
        expect(run.execCalls.filter(isExchange)).toHaveLength(0);
        expect(run.calls.some((call) => call.includes("/run/mend/conv/"))).toBe(false);
        expect(run.state.sharedConversations.size).toBe(0);
        for (const options of run.opened) {
          if ("env" in options) expect(options.env?.["CLAUDE_CONFIG_DIR"]).toBeUndefined();
        }
      }),
    30_000,
  );
});

describe("a terminal takeover of a once-shared conversation (review of mend#572, P2-3)", () => {
  it("a mode switch to the terminal opens in the conversation home, on a take, with the transcript under H", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const calls: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    const stops: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    const memory = makeMemoryCaptureStore();
    const turns: Array<AgentTurn> = [];
    const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
    let sessionId: SessionId | null = null;
    let takesAtStart = 0;
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) {
        const resume = (argv[2] ?? "").includes(provider)
          ? `mend-conv resume /run/mend/conv/${sessionId ?? ""}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
          : "";
        const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
        return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
      }
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          sessionId = session.id;
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
          );
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0]?.process;
          if (alice === undefined) return yield* Effect.die("no protocol process");
          world.processes.set(
            alice.id,
            new SessionProcess({ ...alice, providerSessionId: provider }),
          );
          turns.push(completedTurnOf(alice));
          yield* shipCaptureFiles(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            {
              [`harness/people/user-fixture/conversations/${session.id}/${transcriptIn("claude", provider)}`]:
                transcriptLine("claude", provider),
            },
          );
          takesAtStart = state.conversationHolders.get(session.id)?.fence ?? 0;
          yield* engine.switchMode(session.id, "pty", { mode: "pty" }, "user-fixture");
        }),
      {
        captured: memory,
        conversationLayer: recordedTurnsLayer(turns),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          execCalls,
          undefined,
          { exec },
        ),
        protocolHostLayer: steeringHost(attached, stops),
        harnessLayout: { flag: "person", state, platform: personPlatform(calls, { person: true }) },
      },
    );
    if (sessionId === null) throw new Error("no session");
    const home = `/run/mend/conv/${sessionId}`;
    // The terminal agent: the owner's, in H, with the neutral settings and its transcript there.
    const terminal = spawned.at(-1) ?? [];
    expect(terminal).not.toContain("stream-json");
    expect(terminal[terminal.indexOf("--resume") + 1]).toBe(
      `${home}/.claude/projects/-workspace-repo/${provider}.jsonl`,
    );
    expect(terminal.at(-2)).toBe("--settings");
    expect(opened.at(-1)?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`${home}/.claude`);
    // No second move: the conversation already lives in C.
    expect(execCalls.filter(isStage).filter((argv) => argv[2]?.includes("moved=0"))).toHaveLength(
      1,
    );
    // The one-live-process lock: taken again, and held by the terminal agent.
    const holder = state.conversationHolders.get(sessionId);
    expect(holder?.fence).toBeGreaterThan(takesAtStart);
    const ptyAgent = [...state.conversationHolders.values()][0]?.processId ?? null;
    expect(ptyAgent).not.toBeNull();
  }, 30_000);

  it("a takeover whose close the platform refuses leaves the conversation's take with the process that still runs", async () => {
    const calls: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    const stops: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    const memory = makeMemoryCaptureStore();
    const turns: Array<AgentTurn> = [];
    const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
    let sessionId: SessionId | null = null;
    let aliceId: string | null = null;
    let refusal: unknown = null;
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) {
        const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
        return { exitCode: 0, stdout: `${moved}mend-conv empty\n`, stderr: "" };
      }
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    const base = sealantLaunchLayer(
      [],
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      [],
      undefined,
      { exec },
    );
    const refusingClose = Layer.effect(
      SealantClient,
      Effect.map(SealantClient, (client) => ({
        ...client,
        getSession: (workspace, id) =>
          client.getSession(workspace, id).pipe(
            Effect.map((pty) => ({
              ...pty,
              close: async () => {
                throw new Error("the platform did not close it");
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
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          sessionId = session.id;
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
          );
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0]?.process;
          if (alice === undefined) return yield* Effect.die("no protocol process");
          aliceId = alice.id;
          world.processes.set(
            alice.id,
            new SessionProcess({ ...alice, providerSessionId: provider }),
          );
          turns.push(completedTurnOf(alice));
          yield* shipCaptureFiles(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            {
              [`harness/people/user-fixture/conversations/${session.id}/${transcriptIn("claude", provider)}`]:
                transcriptLine("claude", provider),
            },
          );
          refusal = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
        }),
      {
        captured: memory,
        conversationLayer: recordedTurnsLayer(turns),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: refusingClose,
        protocolHostLayer: steeringHost(attached, stops),
        harnessLayout: { flag: "person", state, platform: personPlatform(calls, { person: true }) },
      },
    );
    if (sessionId === null) throw new Error("no session");
    expect(refusal instanceof SealantPlatformError ? refusal.code : refusal).toBe(
      "conversation_not_stopped",
    );
    const holder = state.conversationHolders.get(sessionId);
    expect.soft(holder?.launchId ?? null).not.toBeNull();
    expect(holder?.processId ?? null).toBe(aliceId);
  }, 30_000);

  it("a fresh terminal claude in a once-shared conversation's home carries Mend's hooks and is pinned to a session id its row records (G4)", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const calls: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    const agentRows: Array<SessionProcess> = [];
    let sessionId: SessionId | null = null;
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) return { exitCode: 0, stdout: "mend-conv empty\n", stderr: "" };
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "once-shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          sessionId = session.id;
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(session.id, new Session({ ...row, sharedControlEverAt: now() }));
          state.sharedConversations.set(session.id, { owner: "user-fixture", movedAt: now() });
          yield* engine.launch(session.id, ["claude"]);
          agentRows.push(
            ...[...world.processes.values()].filter(
              (process) =>
                process.sessionId === session.id &&
                process.kind === "agent-pty" &&
                process.exitedAt === null,
            ),
          );
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          [],
          undefined,
          { exec },
        ),
        harnessLayout: { flag: "person", state, platform: personPlatform(calls, { person: true }) },
      },
    );
    if (sessionId === null) throw new Error("no session");
    const terminal = spawned.at(-1) ?? [];
    expect(terminal[0]).toBe("claude");
    expect(terminal).not.toContain("--resume");
    const pinned = terminal[terminal.indexOf("--session-id") + 1];
    expect(pinned).toMatch(/^[0-9a-f-]{36}$/);
    const settings: unknown = JSON.parse(terminal[terminal.indexOf("--settings") + 1] ?? "{}");
    expect(settings).toEqual({ ...claudeSettingsOf("neutral"), hooks: CLAUDE_AGENT_HOOKS });
    expect(opened.at(-1)?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`/run/mend/conv/${sessionId}/.claude`);
    expect(agentRows.map((row) => row.providerSessionId)).toEqual([pinned]);
  }, 30_000);

  it("a takeover that loses the conversation to a waiting turn's hand-over says so (review 2 of mend#572, P3-1)", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const calls: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    const stops: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    const memory = makeMemoryCaptureStore();
    const turns: Array<AgentTurn> = [];
    const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
    let sessionId: SessionId | null = null;
    let takesAtStart = 0;
    let lostWith = "";
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) {
        const resume = (argv[2] ?? "").includes(provider)
          ? `mend-conv resume /run/mend/conv/${sessionId ?? ""}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
          : "";
        const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
        return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
      }
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          sessionId = session.id;
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
          );
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0]?.process;
          if (alice === undefined) return yield* Effect.die("no protocol process");
          world.processes.set(
            alice.id,
            new SessionProcess({ ...alice, providerSessionId: provider }),
          );
          turns.push(completedTurnOf(alice));
          yield* shipCaptureFiles(
            tmp,
            memory,
            session.worktreeId,
            memory.leases.get(session.worktreeId)?.epoch ?? 0,
            {
              [`harness/people/user-fixture/conversations/${session.id}/${transcriptIn("claude", provider)}`]:
                transcriptLine("claude", provider),
            },
          );
          takesAtStart = state.conversationHolders.get(session.id)?.fence ?? 0;
          // Maria's turn waits, and its hand-over takes the conversation first.
          const steering = attached[0]?.hooks.steering;
          if (steering === undefined) return yield* Effect.die("no steering");
          yield* steering.waiting({
            sessionId: session.id,
            processId: alice.id,
            turnId: AgentTurnId.make("turn-maria"),
            runsAs: "user-fixture",
            sender: MARIA,
            openTurn: false,
            work: [],
          });
          const held = state.conversationHolders.get(session.id);
          if (held === undefined) return yield* Effect.die("no holder");
          state.conversationHolders.set(session.id, {
            ...held,
            processId: null,
            fence: held.fence + 1,
            takenAt: Date.now(),
          });
          const lost = yield* engine
            .switchMode(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
          lostWith = lost.message;
        }),
      {
        captured: memory,
        conversationLayer: recordedTurnsLayer(turns),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          execCalls,
          undefined,
          { exec },
        ),
        protocolHostLayer: steeringHost(attached, stops),
        harnessLayout: { flag: "person", state, platform: personPlatform(calls, { person: true }) },
      },
    );
    expect(lostWith).toContain("waiting turn took the conversation first");
    // Nothing of the terminal's started, and the hand-over's take stands.
    expect(spawned.some((argv) => !argv.includes("stream-json") && argv[0] === "claude")).toBe(
      false,
    );
    expect(takesAtStart).toBeGreaterThan(0);
  }, 30_000);
});

/** What a test sees between a hand-over's two senders (`inTheHandOverGap`). */
interface GapContext {
  readonly world: World;
  readonly sessionId: SessionId;
  readonly alice: SessionProcess;
  readonly attached: Array<{
    readonly process: SessionProcess;
    readonly hooks: ProtocolHostHooks;
    readonly resumePath: string | null;
  }>;
  /** Each process stopped for a hand-over. */
  readonly stops: ReadonlyArray<string>;
  /** Each stop of a workspace asked of the platform. */
  readonly workspaceStops: ReadonlyArray<"drain" | "discard">;
  readonly spawned: ReadonlyArray<ReadonlyArray<string>>;
  /** The words of each waiting turn failed. */
  readonly failed: ReadonlyArray<string>;
  /** Waits for a write of a session row that makes `condition` true. */
  readonly untilWritten: (condition: () => boolean, label: string) => Effect.Effect<void>;
  /** The next launch waits past its admission: `held` once it does, until `release`. */
  readonly holdNextLaunch: Effect.Effect<{
    readonly held: Effect.Effect<void>;
    readonly release: Deferred.Deferred<void>;
  }>;
  /** How the hand-over ended, once it has. */
  readonly handedOver: () => string | null;
}

/** A plain launch that needs no saved harness state: it gets as far as replacing the workspace. */
const LAUNCH_ARGV = ["bash"];

/** What the host says at a hand-over's stop: the turn still waits and the process is quiescent. */
const atTheStop = (stillQuiescent: Effect.Effect<boolean> = Effect.succeed(true)) => ({
  stillQuiescent,
  endedCrons: 0,
});

/** A protocol host that records each attach with its hooks, and each stop for a hand-over. */
const steeringHost = (
  attached: Array<{
    readonly process: SessionProcess;
    readonly hooks: ProtocolHostHooks;
    readonly resumePath: string | null;
  }>,
  stops: Array<string>,
) =>
  Layer.succeed(ProtocolHost, {
    attach: (input) =>
      Effect.sync(() => {
        attached.push({
          process: input.process,
          hooks: input.hooks,
          resumePath: input.resumePath ?? null,
        });
      }),
    rehydrate: () => Effect.void,
    submitTurn: () => Effect.die("not in test"),
    interruptTurn: () => Effect.void,
    respondRequest: () => Effect.die("not in test"),
    detach: () => Effect.void,
    has: () => Effect.succeed(true),
    quiescence: () => Effect.succeed(null),
    awaitQuiescent: () => Effect.void,
    endWork: () => Effect.void,
    detachForHandOver: (processId) =>
      Effect.sync(() => {
        stops.push(processId);
      }),
  });

describe("shared steering through the engine (docs/adr/0016, Delivery 18)", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const turnBy = (author: string | null, processId: SessionProcessId, sessionId: SessionId) =>
    new AgentTurn({
      id: AgentTurnId.make(`turn-${author ?? "mend"}`),
      sessionId,
      processId,
      ordinal: 0,
      author,
      input: "go",
      status: "running",
      providerTurnId: null,
      error: null,
      usage: null,
      createdAt: now(),
      startedAt: now(),
      endedAt: null,
    });

  it("B's turn runs as B with A's conversation, and a hand-over costs two Core calls, DELETE then POST, one stop and one start", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const calls: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    const stops: Array<string> = [];
    // Every write of logins wakes `posted`: the re-login below is forked off the turn's path.
    const posted = Effect.runSync(Queue.sliding<void>(1));
    const posts = watched<{
      readonly onBehalfOf: string;
      readonly home: string;
      readonly logins: HomeLogins;
    }>(posted);
    const state = makeHarnessLayoutsMemoryState();
    const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
    let sessionId: SessionId | null = null;
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) {
        const resume = (argv[2] ?? "").includes(provider)
          ? `mend-conv resume /run/mend/conv/${sessionId ?? ""}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
          : "";
        const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
        return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
      }
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          sessionId = session.id;
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
          );
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0];
          if (alice === undefined) return yield* Effect.die("no process attached");
          expect(alice.process.runsAs).toBe("user-fixture");
          const steering = alice.hooks.steering;
          if (steering === undefined)
            return yield* Effect.die("no steering for a person's process");
          // The conversation holds a transcript now, as its first turn leaves it.
          world.processes.set(
            alice.process.id,
            new SessionProcess({ ...alice.process, providerSessionId: provider }),
          );
          // Who each turn runs as: the owner's turn on her own process, Maria's in a new one of
          // hers, Mend's own as the owner.
          expect(
            yield* steering.decide(turnBy("user-fixture", alice.process.id, session.id)),
          ).toEqual({
            kind: "send",
          });
          expect(yield* steering.decide(turnBy(null, alice.process.id, session.id))).toEqual({
            kind: "send",
          });
          expect(yield* steering.decide(turnBy(MARIA, alice.process.id, session.id))).toEqual({
            kind: "hand-over",
            sender: MARIA,
          });

          // Maria's turn: her own user, her own login, Alice's conversation.
          yield* steering.handOver(MARIA, AgentTurnId.make("turn-maria"), atTheStop());
          const maria = attached[1];
          expect(maria?.process.runsAs).toBe(MARIA);
          expect(stops).toEqual([alice.process.id]);
          expect(world.processes.get(alice.process.id)?.exitedAt).not.toBeNull();
          const home = `/run/mend/conv/${session.id}`;
          const mariasOpen = opened.at(-1);
          const mariasUser =
            mariasOpen !== undefined && "user" in mariasOpen ? mariasOpen.user : undefined;
          expect(typeof mariasUser === "string" ? mariasUser : mariasUser?.name).toBe(
            linuxLoginNameOf(MARIA),
          );
          expect(mariasOpen?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`${home}/.claude`);
          const mariasArgv = spawned.at(-1) ?? [];
          expect(mariasArgv[mariasArgv.indexOf("--resume") + 1]).toBe(
            `${home}/.claude/projects/-workspace-repo/${provider}.jsonl`,
          );
          // Her own login into H, after Alice's was released; nobody else's is ever written.
          expect(calls.filter((call) => call.includes(home))).toEqual([
            `post:user-fixture:${home}`,
            `delete:${home}`,
            `post:${MARIA}:${home}`,
          ]);
          // One live process: Maria's holds the conversation now.
          expect(state.conversationHolders.get(session.id)?.processId).toBe(maria?.process.id);
          if (maria === undefined) return yield* Effect.die("no process attached for Maria");

          // Maria's turn refused for her login: her own home is written again, as her, never the
          // owner's (review of mend#684, round 1).
          const postsBefore = posts.length;
          yield* maria.hooks.onTurnCompleted(
            new AgentTurn({
              ...turnBy(MARIA, maria.process.id, session.id),
              status: "failed",
              error: "API Error: 401 Unauthorized",
              endedAt: now(),
            }),
          );
          yield* signalled(posted)(() => posts.length > postsBefore, "Maria's re-login");
          expect(posts.slice(postsBefore)).toEqual([
            {
              onBehalfOf: MARIA,
              home: `/home/${linuxLoginNameOf(MARIA)}`,
              logins: { claude: true, codex: true, github: true },
            },
          ]);

          // And back to Alice: the hand-over's budget, with both people already made here.
          const steeringOfMaria = maria?.hooks.steering;
          if (steeringOfMaria === undefined || maria === undefined) {
            return yield* Effect.die("no steering for Maria's process");
          }
          world.processes.set(
            maria.process.id,
            new SessionProcess({ ...maria.process, providerSessionId: provider }),
          );
          const before = { calls: calls.length, opened: opened.length, stops: stops.length };
          yield* steeringOfMaria.handOver(
            "user-fixture",
            AgentTurnId.make("turn-alice"),
            atTheStop(),
          );
          expect(calls.slice(before.calls)).toEqual([
            `delete:${home}`,
            `post:user-fixture:${home}`,
          ]);
          expect(stops.length - before.stops).toBe(1);
          expect(opened.length - before.opened).toBe(1);
          expect(attached.at(-1)?.process.runsAs).toBe("user-fixture");
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          execCalls,
          undefined,
          { exec },
        ),
        protocolHostLayer: steeringHost(attached, stops),
        harnessLayout: {
          flag: "person",
          state,
          platform: Layer.effect(
            PersonLayoutPlatform,
            Effect.map(PersonLayoutPlatform, (inner) => ({
              ...inner,
              postCredentials: (
                workspace: Workspace,
                input: Parameters<typeof inner.postCredentials>[1],
              ) => {
                posts.push({
                  onBehalfOf: input.onBehalfOf,
                  home: input.home,
                  logins: input.logins,
                });
                return inner.postCredentials(workspace, input);
              },
            })),
          ).pipe(Layer.provide(personPlatform(calls, { person: true }))),
        },
      },
    );
    // Shared steering spends each sender's own logins only (amendment of 2026-10-10): Maria's
    // other agent login goes into her own home, which her turn's tools run with, and the
    // conversation's home holds the conversation's agent's login of whoever sends.
    const home = `/run/mend/conv/${sessionId ?? ""}`;
    expect(posts.filter((post) => post.home === home)).toEqual([
      { onBehalfOf: "user-fixture", home, logins: { claude: true } },
      { onBehalfOf: MARIA, home, logins: { claude: true } },
      { onBehalfOf: "user-fixture", home, logins: { claude: true } },
    ]);
    // Her start's write, then the one after her refused turn.
    expect(posts.filter((post) => post.home !== home)).toEqual([
      {
        onBehalfOf: MARIA,
        home: `/home/${linuxLoginNameOf(MARIA)}`,
        logins: { claude: true, codex: true, github: true },
      },
      {
        onBehalfOf: MARIA,
        home: `/home/${linuxLoginNameOf(MARIA)}`,
        logins: { claude: true, codex: true, github: true },
      },
    ]);
  }, 30_000);

  /**
   * Alice's shared conversation handed over to Maria, held between its two senders: Alice's process
   * has ended, and Maria's has not started. `between` runs there; `after` once the hand-over ends.
   * The next launch can be held past its admission (`holdNextLaunch`).
   */
  const inTheHandOverGap = (scenario: {
    readonly between: (context: GapContext) => Effect.Effect<void, never, SessionEngine>;
    readonly after?: (context: GapContext) => Effect.Effect<void, never, SessionEngine>;
  }) =>
    Effect.gen(function* () {
      const spawned: Array<ReadonlyArray<string>> = [];
      const calls: Array<string> = [];
      const attached: GapContext["attached"] = [];
      const stops: Array<string> = [];
      const workspaceStops: Array<"drain" | "discard"> = [];
      const failed: Array<string> = [];
      const writes = yield* Queue.make<void>();
      const state = makeHarnessLayoutsMemoryState();
      const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
      let sessionId: SessionId | null = null;
      const betweenSenders = yield* Deferred.make<void>();
      const goOn = yield* Deferred.make<void>();
      const launchHeld = yield* Deferred.make<void>();
      const releaseLaunch = yield* Deferred.make<void>();
      let holding = false;
      const heldLaunch = Layer.succeed(WorkspaceHostUserNamespaces, {
        observe: () =>
          Effect.suspend(() => {
            if (!holding) return Effect.succeed(null);
            holding = false;
            return Deferred.succeed(launchHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseLaunch)),
              Effect.as(null),
            );
          }),
      });
      const exec = (argv: ReadonlyArray<string>) => {
        if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
        if (isStage(argv)) {
          const resume = (argv[2] ?? "").includes(provider)
            ? `mend-conv resume /run/mend/conv/${sessionId ?? ""}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
            : "";
          const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
          return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
        }
        if (isExchange(argv)) {
          return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
        }
        return undefined;
      };
      let handedOver: string | null = null;
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            sessionId = session.id;
            const row = world.sessions.get(session.id);
            if (row === undefined) return yield* Effect.die("no session");
            world.sessions.set(
              session.id,
              new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
            );
            yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
            const alice = attached[0];
            const steering = alice?.hooks.steering;
            if (alice === undefined || steering === undefined) {
              return yield* Effect.die("no steering for the owner's process");
            }
            world.processes.set(
              alice.process.id,
              new SessionProcess({ ...alice.process, providerSessionId: provider }),
            );
            const handing = yield* steering
              .handOver(MARIA, AgentTurnId.make("turn-maria"), atTheStop())
              .pipe(Effect.forkChild);
            yield* Deferred.await(betweenSenders);
            // No harvest to restore from: a launch admitted here goes on to replace the workspace.
            const between = world.sessions.get(session.id);
            if (between === undefined) return yield* Effect.die("no session");
            world.sessions.set(session.id, new Session({ ...between, sealantRunId: null }));
            const context: GapContext = {
              world,
              sessionId: session.id,
              alice: alice.process,
              attached,
              stops,
              workspaceStops,
              spawned,
              failed,
              untilWritten: signalled(writes),
              holdNextLaunch: Effect.sync(() => {
                holding = true;
              }).pipe(Effect.as({ held: Deferred.await(launchHeld), release: releaseLaunch })),
              handedOver: () => handedOver,
            };
            yield* scenario.between(context);
            yield* Deferred.succeed(goOn, undefined);
            handedOver = (yield* Fiber.await(handing))._tag;
            if (scenario.after !== undefined) yield* scenario.after(context);
          }),
        {
          captured: makeMemoryCaptureStore(),
          prepareWorld: (world) => {
            world.members.set(MARIA, "member");
            signalWrites(world.sessions, writes);
          },
          sealantLayer: sealantLaunchLayer(
            [],
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            [],
            undefined,
            { exec, stops: workspaceStops },
          ),
          protocolHostLayer: steeringHost(attached, stops),
          hostUserNamespaces: heldLaunch,
          conversationLayer: Layer.succeed(AgentConversationRepo, {
            ...agentConversationStub,
            cancelOpenForProcess: () => Effect.void,
            failTurn: (turnId, words) =>
              Effect.sync(() => {
                failed.push(words);
                return new AgentTurn({
                  id: turnId,
                  sessionId: sessionId ?? SessionId.make("no-session"),
                  processId: SessionProcessId.make("process-maria"),
                  ordinal: 1,
                  author: MARIA,
                  input: "go",
                  status: "failed",
                  providerTurnId: null,
                  error: words,
                  usage: null,
                  createdAt: now(),
                  startedAt: null,
                  endedAt: now(),
                });
              }),
          }),
          harnessLayout: {
            flag: "person",
            state,
            platform: Layer.effect(
              PersonLayoutPlatform,
              Effect.map(PersonLayoutPlatform, (inner) => ({
                ...inner,
                // Maria's login goes into the conversation's home once Alice's process has ended.
                postCredentials: (
                  workspace: Workspace,
                  input: Parameters<typeof inner.postCredentials>[1],
                ) =>
                  input.onBehalfOf === MARIA && input.home.startsWith("/run/mend/conv/")
                    ? Deferred.succeed(betweenSenders, undefined).pipe(
                        Effect.andThen(Deferred.await(goOn)),
                        Effect.andThen(inner.postCredentials(workspace, input)),
                      )
                    : inner.postCredentials(workspace, input),
              })),
            ).pipe(Layer.provide(personPlatform(calls, { person: true }))),
          },
        },
      );
    });

  it.effect(
    "a plain launch between a hand-over's two senders is refused, and Maria's agent starts and stays (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const seen = { launch: "", aliceEnded: false, mariaLive: false, handedOver: "" };
        let spawnedLaunches: ReadonlyArray<ReadonlyArray<string>> = [];
        let workspaceStops: ReadonlyArray<string> = [];
        yield* inTheHandOverGap({
          between: (gap) =>
            Effect.gen(function* () {
              seen.aliceEnded = (gap.world.processes.get(gap.alice.id)?.exitedAt ?? null) !== null;
              const launched = yield* (yield* SessionEngine)
                .launch(gap.sessionId, LAUNCH_ARGV, { over: NoLiveAgent })
                .pipe(Effect.result);
              seen.launch = launched._tag === "Failure" ? launched.failure._tag : "launched";
            }),
          after: (gap) =>
            Effect.sync(() => {
              const maria = gap.attached.at(-1)?.process;
              seen.handedOver = gap.handedOver() ?? "";
              seen.mariaLive =
                maria?.runsAs === MARIA &&
                (gap.world.processes.get(maria.id)?.exitedAt ?? null) === null;
              spawnedLaunches = gap.spawned.filter((argv) => argv[0] === LAUNCH_ARGV[0]);
              workspaceStops = [...gap.workspaceStops];
            }),
        });
        expect(seen).toEqual({
          launch: "SessionAgentLiveError",
          aliceEnded: true,
          mariaLive: true,
          handedOver: "Success",
        });
        expect(spawnedLaunches).toEqual([]);
        expect(workspaceStops).toEqual([]);
      }),
    30_000,
  );

  it.effect(
    "a hand-over asked while a launch holds the gate is not now, and stops nothing (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const seen = { back: "", mariaLive: false, stopped: 0 };
        yield* inTheHandOverGap({
          between: () => Effect.void,
          after: (gap) =>
            Effect.gen(function* () {
              const maria = gap.attached.at(-1);
              const steering = maria?.hooks.steering;
              if (maria === undefined || steering === undefined) {
                return yield* Effect.die("no steering for Maria's process");
              }
              const stopsBefore = gap.stops.length;
              const hold = yield* gap.holdNextLaunch;
              const restarting = yield* (yield* SessionEngine)
                .launch(gap.sessionId, LAUNCH_ARGV, { over: Restart })
                .pipe(Effect.forkChild);
              yield* hold.held;
              const back = yield* steering
                .handOver("user-fixture", AgentTurnId.make("turn-alice"), atTheStop())
                .pipe(Effect.result);
              seen.back = back._tag === "Failure" ? back.failure.code : "handed over";
              seen.stopped = gap.stops.length - stopsBefore;
              seen.mariaLive =
                (gap.world.processes.get(maria.process.id)?.exitedAt ?? null) === null;
              yield* Deferred.succeed(hold.release, undefined);
              yield* Fiber.await(restarting);
            }),
        });
        expect(seen).toEqual({ back: HAND_OVER_NOT_NOW, mariaLive: true, stopped: 0 });
      }),
    30_000,
  );

  it.effect(
    "the owner's Stop between a hand-over's two senders wins: neither agent starts again (SLNT-167)",
    () =>
      Effect.gen(function* () {
        const seen: {
          status: string | undefined;
          live: ReadonlyArray<string | null>;
          failed: ReadonlyArray<string>;
        } = { status: undefined, live: [], failed: [] };
        yield* inTheHandOverGap({
          between: (gap) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              yield* engine.stop(gap.sessionId).pipe(Effect.ignore);
            }),
          after: (gap) =>
            Effect.gen(function* () {
              // The Stop the hand-over owed runs as it ends; its settle is the signal.
              yield* gap.untilWritten(
                () => (gap.world.sessions.get(gap.sessionId)?.settledAt ?? null) !== null,
                "the stop's settle",
              );
              seen.status = gap.world.sessions.get(gap.sessionId)?.status;
              seen.live = [...gap.world.processes.values()]
                .filter((process) => process.sessionId === gap.sessionId)
                .filter((process) => process.exitedAt === null)
                .map((process) => process.runsAs);
              seen.failed = [...gap.failed];
            }),
        });
        expect(seen.status).toBe("stopped");
        expect(seen.live).toEqual([]);
        expect(seen.failed).toHaveLength(1);
      }),
    30_000,
  );

  /**
   * Alice's shared Claude conversation in a person executor, her process attached, and a hand-over
   * to Maria asked of its steering, as the host asks once Maria's turn has waited.
   */
  const handOverToMaria = (options: {
    readonly logins?: (accountId: string) => PersonLogin;
    readonly postFails?: (onBehalfOf: string, home: string) => boolean;
    /** What the host says at the stop (review 2 of mend#572, P2-2). */
    readonly stillQuiescent?: Effect.Effect<boolean>;
    /** Maria's next turn asks for the conversation again at once (review 2, P3-3). */
    readonly again?: boolean;
    /** The conversation then goes idle and Mend stops it, as the idle stop does. */
    readonly thenIdle?: boolean;
  }) =>
    Effect.gen(function* () {
      const spawned: Array<ReadonlyArray<string>> = [];
      const opened: Array<SessionOptions | PersonSessionOptions> = [];
      const calls: Array<string> = [];
      const attached: Array<{
        readonly process: SessionProcess;
        readonly hooks: ProtocolHostHooks;
        readonly resumePath: string | null;
      }> = [];
      const stops: Array<string> = [];
      const failed: Array<{ readonly turnId: string; readonly words: string }> = [];
      /** Every process whose open turns were cancelled (`cancelOpenForProcess`). */
      const swept: Array<string> = [];
      const state = makeHarnessLayoutsMemoryState();
      const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
      let sessionId: SessionId | null = null;
      const result: {
        outcome: { readonly code: string; readonly message: string } | null;
        second: { readonly code: string; readonly message: string } | null;
        stopsBeforeSecond: number;
        summary: string | null;
      } = { outcome: null, second: null, stopsBeforeSecond: 0, summary: null };
      /** The session's status at every write, `settled` when the write settled it. */
      const statuses: Array<string> = [];
      const exec = (argv: ReadonlyArray<string>) => {
        if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
        if (isStage(argv)) {
          const resume = (argv[2] ?? "").includes(provider)
            ? `mend-conv resume /run/mend/conv/${sessionId ?? ""}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
            : "";
          const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
          return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
        }
        if (isExchange(argv)) {
          return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
        }
        return undefined;
      };
      /** Every session row written: the idle stop's settle lands on it. */
      const writes = yield* Queue.make<void>();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            sessionId = session.id;
            const row = world.sessions.get(session.id);
            if (row === undefined) return yield* Effect.die("no session");
            world.sessions.set(
              session.id,
              new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
            );
            yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
            const alice = attached[0];
            const steering = alice?.hooks.steering;
            if (alice === undefined || steering === undefined) {
              return yield* Effect.die("no steering for the owner's process");
            }
            world.processes.set(
              alice.process.id,
              new SessionProcess({ ...alice.process, providerSessionId: provider }),
            );
            const handed = yield* steering
              .handOver(MARIA, AgentTurnId.make("turn-maria"), atTheStop(options.stillQuiescent))
              .pipe(Effect.result);
            if (handed._tag === "Failure") {
              result.outcome = { code: handed.failure.code, message: handed.failure.message };
            }
            if (options.again === true) {
              result.stopsBeforeSecond = stops.length;
              const restarted = attached.at(-1);
              const again = yield* (restarted?.hooks.steering ?? steering)
                .handOver(MARIA, AgentTurnId.make("turn-maria-2"), atTheStop())
                .pipe(Effect.result);
              if (again._tag === "Failure") {
                result.second = { code: again.failure.code, message: again.failure.message };
              }
            }
            if (options.thenIdle === true) {
              yield* engine.stop(session.id, "idle");
              // The settle lands off the stop's path; its write to the row is the signal.
              yield* signalled(writes)(
                () => (world.sessions.get(session.id)?.settledAt ?? null) !== null,
                "the idle stop's settle",
              );
            }
            result.summary = world.sessions.get(session.id)?.summary ?? null;
          }),
        {
          captured: makeMemoryCaptureStore(),
          prepareWorld: (world) => {
            world.members.set(MARIA, "member");
            signalWrites(world.sessions, writes);
            const write = world.sessions.set.bind(world.sessions);
            world.sessions.set = (id, next) => {
              const before = world.sessions.get(id);
              if (before !== undefined && before.status !== next.status) {
                statuses.push(
                  before.settledAt === null && next.settledAt !== null
                    ? `settled ${next.status}`
                    : next.status,
                );
              }
              return write(id, next);
            };
          },
          sealantLayer: sealantLaunchLayer(
            [],
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            undefined,
            opened,
            undefined,
            [],
            undefined,
            { exec },
          ),
          protocolHostLayer: steeringHost(attached, stops),
          conversationLayer: Layer.succeed(AgentConversationRepo, {
            ...agentConversationStub,
            cancelOpenForProcess: (processId) => Effect.sync(() => void swept.push(processId)),
            failTurn: (turnId, words) =>
              Effect.sync(() => {
                failed.push({ turnId, words });
                return new AgentTurn({
                  id: turnId,
                  sessionId: sessionId ?? SessionId.make("no-session"),
                  processId: SessionProcessId.make("process-maria"),
                  ordinal: 1,
                  author: MARIA,
                  input: "go",
                  status: "failed",
                  providerTurnId: null,
                  error: words,
                  usage: null,
                  createdAt: now(),
                  startedAt: null,
                  endedAt: now(),
                });
              }),
          }),
          harnessLayout: {
            flag: "person",
            state,
            platform: personPlatform(
              calls,
              { person: true },
              undefined,
              options.logins,
              options.postFails,
            ),
          },
        },
      );
      if (sessionId === null) throw new Error("no session");
      return {
        sessionId,
        spawned,
        opened,
        calls,
        attached,
        stops,
        failed,
        swept,
        state,
        outcome: result.outcome,
        second: result.second,
        stopsBeforeSecond: result.stopsBeforeSecond,
        summary: result.summary,
        statuses,
      };
    });

  it.effect(
    "a change of sender is not a settle: the session stays running through the hand-over, and settles once when it goes idle (review 0.36, S1)",
    () =>
      Effect.gen(function* () {
        const run = yield* handOverToMaria({ thenIdle: true });
        expect(run.outcome).toBeNull();
        expect(run.stops).toHaveLength(1);
        expect(run.attached.map((entry) => entry.process.runsAs)).toEqual(["user-fixture", MARIA]);
        // Alice's process stopped before Maria's started, and the session never read as settled or
        // idle between them: nothing for review prep, Slack or a phone to take as the end of work.
        const handOver = run.statuses.slice(0, run.statuses.indexOf("stopping"));
        expect(handOver.filter((status) => status !== "running")).toEqual([]);
        // The idle stop after it is the session's one settle.
        expect(run.statuses.filter((status) => status.startsWith("settled"))).toEqual([
          "settled stopped",
        ]);
      }),
    30_000,
  );

  it.effect(
    "a hand-over that leaves no process running settles once it ends (review 0.36, S1)",
    () =>
      Effect.gen(function* () {
        // Every write into the home after the owner's first fails: Maria's, then Alice's restart.
        let intoHome = 0;
        const run = yield* handOverToMaria({
          postFails: (_onBehalfOf, home) => home.startsWith("/run/mend/conv/") && intoHome++ > 0,
        });
        expect(run.outcome?.message).toContain("Core did not answer");
        expect(run.statuses.filter((status) => status.startsWith("settled"))).toEqual([
          "settled stopped",
        ]);
      }),
    30_000,
  );

  it.effect(
    "a hand-over that fails after the stop starts the conversation again as the person before, on their login, and fails the waiting turn with its line (review of mend#572, P2-2)",
    () =>
      Effect.gen(function* () {
        const run = yield* handOverToMaria({
          // Her own home's write goes through; the one into the conversation's home does not.
          postFails: (onBehalfOf, home) =>
            onBehalfOf === MARIA && home.startsWith("/run/mend/conv/"),
        });
        const home = `/run/mend/conv/${run.sessionId}`;
        expect(run.outcome?.message).toContain("Core did not answer");
        // Alice's process was stopped for it; nothing of Maria's started.
        expect(run.stops).toHaveLength(1);
        expect(run.attached.map((entry) => entry.process.runsAs)).toEqual([
          "user-fixture",
          "user-fixture",
        ]);
        // The conversation goes on in a process of Alice's, on her own login, in its home.
        expect(run.calls.filter((call) => call.includes(home))).toEqual([
          `post:user-fixture:${home}`,
          `delete:${home}`,
          `post:${MARIA}:${home}`,
          `delete:${home}`,
          `post:user-fixture:${home}`,
        ]);
        expect(run.opened.at(-1)?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`${home}/.claude`);
        const restarted = run.attached.at(-1)?.process;
        expect(run.state.conversationHolders.get(run.sessionId)?.processId).toBe(restarted?.id);
        // Maria's turn fails with the line, and says what went wrong.
        expect(run.failed).toEqual([
          { turnId: "turn-maria", words: expect.stringContaining("Core did not answer") },
        ]);
        // The turns queued behind hers are not cancelled: Alice's restarted process takes them.
        expect(run.swept).not.toContain(run.attached[0]?.process.id);
      }),
    30_000,
  );

  it.effect(
    "a hand-over whose turn is withdrawn while it is prepared stops nothing and writes nothing into the home (review 2 of mend#572, P2-2)",
    () =>
      Effect.gen(function* () {
        // S6: Maria withdraws while Mend asks Core for her login; the host's look at the stop says so.
        let withdrawn = false;
        const run = yield* handOverToMaria({
          logins: (accountId) => {
            if (accountId === MARIA) withdrawn = true;
            return { _tag: "active" };
          },
          stillQuiescent: Effect.sync(() => !withdrawn),
        });
        const home = `/run/mend/conv/${run.sessionId}`;
        expect(withdrawn).toBe(true);
        expect(run.outcome?.code).toBe("hand_over_not_now");
        expect(run.stops).toEqual([]);
        expect(run.attached).toHaveLength(1);
        expect(run.calls).not.toContain(`post:${MARIA}:${home}`);
        expect(run.calls.filter((call) => call === `delete:${home}`)).toEqual([]);
        // Alice's process still holds the conversation.
        expect(run.state.conversationHolders.get(run.sessionId)?.processId).toBe(
          run.attached[0]?.process.id,
        );
        expect(run.failed).toEqual([]);
      }),
    30_000,
  );

  it.effect(
    "a hand-over that failed after its stop is not tried again at once, and a restart that fails too says why on the session line (review 2 of mend#572, P3-2 and P3-3)",
    () =>
      Effect.gen(function* () {
        const backoff = yield* handOverToMaria({
          postFails: (onBehalfOf, home) =>
            onBehalfOf === MARIA && home.startsWith("/run/mend/conv/"),
          again: true,
        });
        expect(backoff.second?.message).toContain("failed less than a minute ago");
        expect(backoff.stops).toHaveLength(backoff.stopsBeforeSecond);
        // Every write into the home after the owner's first fails: Maria's, then Alice's restart.
        let intoHome = 0;
        const restart = yield* handOverToMaria({
          postFails: (_onBehalfOf, home) => home.startsWith("/run/mend/conv/") && intoHome++ > 0,
        });
        expect(restart.outcome?.message).toContain("Core did not answer");
        expect(restart.summary).toContain("could not be started again");
        // The cause's own full stop is not doubled (RC 0.36.0-next.754, B-F4: `Nothing was sent..`).
        expect(restart.summary).toContain(
          "could not be started again: Core did not answer. Resume",
        );
        // No process takes the conversation's queue: what waited behind Maria's turn ends with the
        // stopped process, as at any stop.
        expect(restart.swept).toContain(restart.attached[0]?.process.id);
      }),
    30_000,
  );

  it.effect(
    "a hand-over whose sender's login went invalid while the turn waited stops nothing (review of mend#572, P2-2)",
    () =>
      Effect.gen(function* () {
        // Her turn was queued while her login stood; it needs reconnecting by the hand-over.
        const run = yield* handOverToMaria({
          logins: (accountId) => ({ _tag: accountId === MARIA ? "invalid" : "active" }),
        });
        expect(run.outcome).toEqual({
          code: "person_login_refused",
          message:
            "Your Claude login needs reconnecting. Reconnect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
        });
        expect(run.stops).toEqual([]);
        expect(run.attached).toHaveLength(1);
        expect(run.calls.some((call) => call.startsWith(`post:${MARIA}:`))).toBe(false);
        expect(run.failed).toEqual([]);
      }),
    30_000,
  );

  it("a follow-up and a launch that opens with a steerer's words check the steerer's own login (review of mend#572, P2-2)", async () => {
    const refusals: Array<string> = [];
    const calls: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(session.id, new Session({ ...row, sharedControlEnabledAt: now() }));
          const followUp = yield* engine
            .launchFollowUp(session.id, "fix the review comment", "corr-1", MARIA)
            .pipe(Effect.flip);
          refusals.push(followUp.message);
          const launched = yield* engine
            .launchProtocol(session.id, { mode: "protocol", prompt: "start here" }, MARIA)
            .pipe(Effect.flip);
          refusals.push(launched.message);
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        harnessLayout: {
          flag: "person",
          platform: personPlatform(calls, { person: true }, undefined, () => ({ _tag: "missing" })),
        },
      },
    );
    expect(refusals).toEqual([
      "Connect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
      "Connect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
    ]);
    expect(calls).toEqual([`login:${MARIA}`, `login:${MARIA}`]);
  }, 30_000);

  it("only the person a process runs as answers its agent's questions; a steerer sends a turn instead (owner's rule, review 2 of mend#572)", async () => {
    const answered: Array<string> = [];
    const refusals: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
    const askedBy = (processId: SessionProcessId, sessionId: SessionId) =>
      new AgentRequest({
        id: AgentRequestId.make("request-1"),
        sessionId,
        processId,
        turnId: AgentTurnId.make("turn-alice"),
        kind: "tool-permission",
        providerRequestId: "provider-request-1",
        providerItemId: null,
        title: "Run npm test?",
        detail: null,
        questions: null,
        status: "pending",
        decision: null,
        decidedBy: null,
        answers: null,
        createdAt: now(),
        decidedAt: null,
      });
    let asking: AgentRequest | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          // Alice's own process in a person executor: it runs as her.
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0]?.process;
          expect(alice?.runsAs).toBe("user-fixture");
          if (alice === undefined) return yield* Effect.die("no protocol process");
          asking = askedBy(alice.id, session.id);
          const steerer = yield* engine
            .respondRequest(AgentRequestId.make("request-1"), { decision: "accept" }, MARIA)
            .pipe(Effect.flip);
          refusals.push(steerer.message);
          yield* engine.respondRequest(
            AgentRequestId.make("request-1"),
            { decision: "accept" },
            "user-fixture",
          );
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
          undefined,
          { exec: answerLayout(LAYOUT_READY) },
        ),
        protocolHostLayer: Layer.succeed(ProtocolHost, {
          attach: (input) =>
            Effect.sync(() => {
              attached.push({ process: input.process, hooks: input.hooks, resumePath: null });
            }),
          rehydrate: () => Effect.void,
          submitTurn: () => Effect.die("not in test"),
          interruptTurn: () => Effect.void,
          respondRequest: (request, _response, decidedBy) =>
            Effect.sync(() => {
              answered.push(decidedBy);
              return request;
            }),
          detach: () => Effect.void,
          has: () => Effect.succeed(true),
          quiescence: () => Effect.succeed(null),
          awaitQuiescent: () => Effect.void,
          endWork: () => Effect.void,
          detachForHandOver: () => Effect.void,
        }),
        conversationLayer: Layer.succeed(AgentConversationRepo, {
          ...agentConversationStub,
          byRequestId: () => Effect.sync(() => asking),
        }),
        harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
      },
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/^Only .+ can answer this; send a turn instead\.$/);
    // The owner's own answer reaches the agent; Maria's never did.
    expect(answered).toEqual(["user-fixture"]);
  }, 30_000);

  /** A Claude conversation of Alice's in a person executor, shared, and a turn sent to it. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const submitScenario = async (options: {
    readonly harness: "claude" | "opencode";
    readonly author: string;
    readonly logins?: (accountId: string) => PersonLogin;
  }) => {
    const calls: Array<string> = [];
    const submitted: Array<string> = [];
    let refused: string | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: options.harness,
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({
              ...row,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              sharedControlEnabledAt: now(),
            }),
          );
          const sent = yield* engine
            .submitTurn(session.id, "please", options.author)
            .pipe(Effect.result);
          if (sent._tag === "Failure" && sent.failure._tag === "SessionTurnRefusedError") {
            refused = sent.failure.message;
          }
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        protocolHostLayer: recordingProtocolHostLayer([], submitted),
        harnessLayout: {
          flag: "person",
          platform: personPlatform(calls, { person: true }, undefined, options.logins),
        },
      },
    );
    return { calls, submitted, refused };
  };

  it("refuses a steerer whose own login is missing, unchosen or needs reconnecting, before anything is queued", async () => {
    const missing = await submitScenario({
      harness: "claude",
      author: MARIA,
      logins: () => ({ _tag: "missing" }),
    });
    expect(missing.refused).toBe(
      "Connect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
    );
    expect(missing.submitted).toEqual([]);
    const invalid = await submitScenario({
      harness: "claude",
      author: MARIA,
      logins: () => ({ _tag: "invalid" }),
    });
    expect(invalid.refused).toBe(
      "Your Claude login needs reconnecting. Reconnect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
    );
    const unchosen = await submitScenario({
      harness: "claude",
      author: MARIA,
      logins: () => ({ _tag: "unchosen", count: 2 }),
    });
    expect(unchosen.refused).toBe(
      "No Claude login chosen: Mend holds 2 of yours, and sessions use only the chosen one. Remove the others with mend connect claude --remove <name>, or Disconnect them in Settings → Connected accounts, then connect the one left again to choose it.",
    );
    expect(unchosen.submitted).toEqual([]);
    // Connected: queued, on the conversation, with one look at Core.
    const active = await submitScenario({ harness: "claude", author: MARIA });
    expect(active.refused).toBeNull();
    expect(active.submitted).toEqual(["please"]);
    expect(active.calls).toEqual([`login:${MARIA}`]);
  }, 30_000);

  it("the owner's own turns ask Core nothing", async () => {
    const own = await submitScenario({
      harness: "claude",
      author: "user-fixture",
      logins: () => ({ _tag: "missing" }),
    });
    expect(own.refused).toBeNull();
    expect(own.calls).toEqual([]);
  }, 30_000);

  it("refuses another person's turn to an opencode session: it is one person's", async () => {
    const run = await submitScenario({ harness: "opencode", author: MARIA });
    expect(run.refused).toBe(
      "opencode sessions are one person's. Shared control is not available for them; start your own session in this worktree.",
    );
    expect(run.submitted).toEqual([]);
  }, 30_000);

  it.effect(
    "a process whose person is not recorded, in a person executor, takes its owner's turns only (review of mend#572, P1-1)",
    () =>
      Effect.gen(function* () {
        // A Claude protocol process started before steering, so `runs_as` was never written, and
        // restored after Mend restarts: Maria's turn must never run on the owner's login there.
        const sessionId = SessionId.make("session-unrecorded");
        const runId = SealantRunId.make("run-unrecorded");
        const workspaceId = SealantWorkspaceId.make("workspace-1");
        const state = makeHarnessLayoutsMemoryState();
        const restored: Array<{
          readonly process: SessionProcess;
          readonly hooks: ProtocolHostHooks;
        }> = [];
        /** The boot pass restored the process: the host's rehydrate is the signal. */
        const restoredOnce = yield* Deferred.make<void>();
        const host = Layer.succeed(ProtocolHost, {
          attach: () => Effect.die("not in test"),
          rehydrate: (input) =>
            Effect.sync(() => {
              restored.push({ process: input.process, hooks: input.hooks });
            }).pipe(Effect.andThen(Deferred.succeed(restoredOnce, undefined))),
          submitTurn: () => Effect.die("not in test"),
          interruptTurn: () => Effect.void,
          respondRequest: () => Effect.die("not in test"),
          detach: () => Effect.void,
          has: () => Effect.succeed(true),
          quiescence: () => Effect.succeed(null),
          awaitQuiescent: () => Effect.void,
          endWork: () => Effect.void,
          detachForHandOver: () => Effect.void,
        });
        yield* withEngineEffect(
          (world) =>
            Effect.gen(function* () {
              yield* Deferred.await(restoredOnce);
              const steering = restored[0]?.hooks.steering;
              if (steering === undefined) return yield* Effect.die("no steering for the process");
              const processId = SessionProcessId.make("agent-boot");
              expect(yield* steering.decide(turnBy(MARIA, processId, sessionId))).toEqual({
                kind: "refuse",
                words: expect.stringContaining("owner"),
              });
              expect(yield* steering.decide(turnBy("user-fixture", processId, sessionId))).toEqual({
                kind: "send",
              });
              expect(yield* steering.decide(turnBy(null, processId, sessionId))).toEqual({
                kind: "send",
              });
              expect(world.processes.get("agent-boot")?.runsAs).toBeNull();
            }),
          {
            captured: makeMemoryCaptureStore(),
            prepareWorld: (world, tmp) => {
              world.members.set(MARIA, "member");
              seedStoppedBeforeRestart(world, tmp, {
                sessionId,
                runId,
                workspaceId,
                processLive: true,
              });
              const session = world.sessions.get(sessionId);
              const process = world.processes.get("agent-boot");
              if (session === undefined || process === undefined) throw new Error("not seeded");
              world.sessions.set(
                sessionId,
                new Session({
                  ...session,
                  harness: "claude",
                  sharedControlEnabledAt: now(),
                  sharedControlEverAt: now(),
                }),
              );
              world.processes.set(
                "agent-boot",
                new SessionProcess({
                  ...process,
                  kind: "agent-protocol",
                  harness: "claude",
                  label: "claude",
                  argv: ["claude"],
                  runsAs: null,
                }),
              );
              world.executorLaunches.set(sessionId, { workspaceId, launchId: "launch-unrecorded" });
              state.launches.set("launch-unrecorded", {
                launchId: "launch-unrecorded",
                worktreeId: WorktreeId.make("wt-boot"),
                sessionId,
                layout: "person",
                source: "flag",
                reason: null,
                imageKey: null,
                confirmed: true,
              });
            },
            sealantLayer: sealantLaunchLayer([]),
            protocolHostLayer: host,
            harnessLayout: {
              flag: "person",
              state,
              platform: personPlatform([], { person: true }),
            },
          },
        );
      }),
    30_000,
  );

  it("in a person executor, only the change owner's own Claude processes keep scheduled prompts", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const holder = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(holder.id, ["claude"]);
          const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: MARIA,
          });
          yield* engine.launch(joined.id, ["claude"]);
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
          undefined,
          { exec: answerLayout(LAYOUT_READY) },
        ),
        harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
      },
    );
    const claudes = spawned.filter((argv) => argv.includes("claude"));
    expect(claudes).toHaveLength(2);
    // Alice made the worktree: hers keep crons, with only the session-state switch.
    expect(claudes[0]?.slice(-2)).toEqual([
      "--settings",
      JSON.stringify({
        env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
        hooks: CLAUDE_AGENT_HOOKS,
      }),
    ]);
    // Maria's personal Claude in Alice's worktree: no scheduled prompts, whatever the repository says.
    expect(claudes[1]?.slice(-2)).toEqual([
      "--settings",
      JSON.stringify({
        env: { CLAUDE_CODE_DISABLE_CRON: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
        hooks: CLAUDE_AGENT_HOOKS,
      }),
    ]);
  }, 30_000);
});
