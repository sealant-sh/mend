import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
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
  type WorktreeSetupSnapshot,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import {
  setupCommandLineOf,
  setupOutputReader,
  setupSentinelOf,
  setupSourceOf,
} from "../src/worktree-setup.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * t3code's new-thread preparation against Mend: "start from origin" fetches origin into the store
 * before the worktree is made, and a new worktree's t3.json setup script runs in a Mend shell,
 * shown on t3code's setup card, before the opening message goes. A failed setup is t3code's
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
    "runs t3.json's setup in a Mend shell on the setup card, and holds the opening message until it exits",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.newWorktreeFiles.set("t3.json", t3json({ async: false }));
          mend.tty.scripts.set("pnpm install", {
            lines: ["Lockfile is up to date", "Done in 1.2s"],
            exitCode: 0,
            delayMs: 300,
          });
          const { rpc } = yield* pairAndConnect(mend, "SETUP");
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

          const typed = mend.tty.typed.join("");
          assert.include(typed, 'T3CODE_WORKTREE_PATH="$PWD"');
          assert.include(typed, "pnpm install");
          assert.lengthOf(mend.tty.scriptRuns, 1);
          const shell = mend.tty.scriptRuns[0] ?? "";
          yield* eventually(
            () => mend.tty.shells.get(shell)?.running === false,
            "the setup shell to stop",
          );
        }),
      ),
  );

  it.live("sends the opening message once an async setup script has started", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.newWorktreeFiles.set("t3.json", t3json({}));
        mend.tty.scripts.set("pnpm install", { lines: ["resolving"], exitCode: "hang" });
        const { rpc } = yield* pairAndConnect(mend, "ASYNC");
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
        assert.isFalse(cancel.cancelled);
      }),
    ),
  );

  it.live("skips the stage and sends the message when the worktree has no t3.json", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "NOFILE");
        const card = yield* feed(rpc[WS_METHODS.subscribeWorktreeSetup]({ threadId: THREAD }));
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](launchInput());
        const done = yield* card.next(isSnapshot((snapshot) => snapshot.phase === "done"));
        assert.strictEqual(stageOf(done, "setup-script")?.status, "skipped");
        assert.strictEqual(stageOf(done, "setup-script")?.detail, "No t3.json in this worktree.");
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
          mend.workbench.newWorktreeFiles.set("t3.json", t3json({ async: false }));
          mend.tty.scripts.set("pnpm install", {
            lines: ["ERR_PNPM_NO_LOCKFILE"],
            exitCode: 1,
          });
          const { rpc } = yield* pairAndConnect(mend, "FAILS");
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
          assert.lengthOf(calls(mend, "POST", "/projects/project-1/sessions"), 1);
        }),
      ),
  );

  it.live("cancels a setup still running: its shell stops and the message fails, retryable", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.newWorktreeFiles.set("t3.json", t3json({ async: false }));
        mend.tty.scripts.set("pnpm install", { lines: ["fetching"], exitCode: "hang" });
        const { rpc } = yield* pairAndConnect(mend, "CANCEL");
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

describe("a preparation across a restart", () => {
  it.live("fails what a restart cut short as a preparation, and its retry prepares again", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-setup-")), "state.sqlite");
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.newWorktreeFiles.set("t3.json", t3json({ async: false }));
      mend.tty.scripts.set("pnpm install", { lines: ["fetching"], exitCode: "hang" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "BEFORE");
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

describe("the setup script's source and output", () => {
  it("takes t3.json's first worktree setup script, and says why there is none", () => {
    assert.deepStrictEqual(setupSourceOf(t3json({})), {
      _tag: "Script",
      name: "Install",
      command: "pnpm install",
      async: true,
    });
    assert.deepStrictEqual(setupSourceOf(t3json({ async: false })), {
      _tag: "Script",
      name: "Install",
      command: "pnpm install",
      async: false,
    });
    assert.deepStrictEqual(setupSourceOf(null), {
      _tag: "None",
      reason: "No t3.json in this worktree.",
    });
    assert.deepStrictEqual(setupSourceOf("{ not json"), {
      _tag: "None",
      reason: "t3.json is invalid, so it names no setup script.",
    });
    assert.deepStrictEqual(setupSourceOf(JSON.stringify({ scripts: [] })), {
      _tag: "None",
      reason: "t3.json names no setup script.",
    });
  });

  it("reads the script's own lines and its exit, never the shell's echo of what was typed", () => {
    const sentinel = setupSentinelOf("abc123");
    const line = setupCommandLineOf("pnpm install\necho done", sentinel);
    const read = setupOutputReader(sentinel, line);
    // A POSIX shell echoes the first typed line after its prompt, the rest after `> `.
    const typed = line.split("\r").filter((part) => part.length > 0);
    const echo = read(`$ ${typed.join("\r\n> ")}\r\n`);
    assert.deepStrictEqual(echo.lines, []);
    assert.isUndefined(echo.exitCode);
    const output = read("\x1b[32mProgress: resolved 12\x1b[0m\r\nProgress: resolved 40\rdone\r\n");
    assert.deepStrictEqual(output.lines, [
      "Progress: resolved 12",
      "Progress: resolved 40",
      "done",
    ]);
    assert.isUndefined(read("__T3_SETUP_DONE__other:0\r\n").exitCode);
    assert.strictEqual(read(`\r\n${sentinel}3\r\n$ `).exitCode, 3);
  });
});
