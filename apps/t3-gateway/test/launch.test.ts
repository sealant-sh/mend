import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { labelOf, MEND_LABEL_LIMIT, planLaunch, worktreeNameOf } from "../src/launch.ts";
import { openGatewayState } from "../src/state.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer, PERSON } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * Phase 2's thread lifecycle (ADR 0012, "The surface"): `orchestration.launchThread` creates a
 * session the person owns and sends its opening message once the agent runs; rename, stop and
 * delete go through Mend's own routes, with Mend's ownership rules.
 */

const withGateway = <A, E, R>(
  test: (mend: FakeMend) => Effect.Effect<A, E, R>,
  statePath?: string,
) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(
      Effect.scoped,
      Effect.provide(gatewayTestLayer(mend.url, statePath)),
    );
  });

type Item = OrchestrationV2ThreadStreamItem;
type ShellItem = OrchestrationV2ShellStreamItem;

let commands = 0;
const commandId = () => CommandId.make(`launch-command-${++commands}`);

const launchInput = (
  overrides: Partial<OrchestrationV2ThreadLaunchInput> = {},
): OrchestrationV2ThreadLaunchInput => ({
  commandId: commandId(),
  threadId: ThreadId.make("draft-thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Add a health check",
  generateTitle: true,
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "worktree", baseRef: "main", branch: "t3code/health-check" },
  initialMessage: {
    messageId: MessageId.make("message-first"),
    text: "Add a health check",
    attachments: [],
  },
  ...overrides,
});

const runEvent =
  (accept: (run: OrchestrationV2Run) => boolean) =>
  (item: Item): item is Extract<Item, { kind: "event" }> =>
    item.kind === "event" && item.event.type === "run.updated" && accept(item.event.payload);

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const calls = (mend: FakeMend, method: string, suffix: string) =>
  mend.workbench.calls.filter((call) => call.method === method && call.path.endsWith(suffix));

const errorTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;
};

const shellThread =
  (threadId: string, accept: (thread: { readonly title: string }) => boolean = () => true) =>
  (item: ShellItem): item is Extract<ShellItem, { kind: "thread.updated" }> =>
    item.kind === "thread.updated" && item.thread.id === threadId && accept(item.thread);

describe("orchestration.launchThread", () => {
  it.live(
    "keeps a launched thread's id the launcher's: everyone else sees the session by its Mend id",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          const { rpc } = yield* pairAndConnect(mend, "LAUNCHER");
          const launched = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](
            launchInput({ threadId: ThreadId.make("draft-mine") }),
          );
          assert.strictEqual(launched.threadId, "draft-mine");
          const sessionId = Array.from(mend.workbench.sessions.keys())[0] ?? "";
          const other = yield* pairAndConnect(mend, "TEAMMATE", {
            id: "user-2",
            name: "Bea",
            email: "bea@example.com",
          });
          const shell = yield* feed(other.rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
          const seen = yield* shell.next(
            (item): item is Extract<ShellItem, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          const ids = seen.snapshot.threads.map((thread) => String(thread.id));
          assert.notInclude(ids, "draft-mine");
          // The teammate cannot reach the session through the launcher's id.
          const exit = yield* Effect.exit(
            other.rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: ThreadId.make("draft-mine"),
            }),
          );
          assert.isTrue(Exit.isFailure(exit));
          void sessionId;
        }),
      ),
  );

  it.live("names a launch's options only until Mend has recorded the agent", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "OPTIONS");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](
          launchInput({ threadId: ThreadId.make("draft-options") }),
        );
        yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the first turn");
        const sessionId = Array.from(mend.workbench.sessions.keys())[0] ?? "";
        // The idle stop; a follow-up relaunches on what Mend recorded, naming nothing.
        mend.workbench.stopAgent(sessionId);
        const turn = mend.workbench.turns.get(sessionId)?.[0];
        if (turn !== undefined) mend.workbench.setTurn(turn, "completed");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "message.dispatch",
          commandId: commandId(),
          createdBy: "user",
          creationSource: "web",
          threadId: ThreadId.make("draft-options"),
          messageId: MessageId.make("message-later"),
          text: "Pick it up",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        yield* eventually(() => mend.workbench.launches.length === 2, "the relaunch");
        assert.deepStrictEqual(mend.workbench.launches[1]?.body, { mode: "protocol" });
      }),
    ),
  );

  it.live("never drops the opening message when Mend does not answer the first reads", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "FLAKY");
        // The hub has read Mend once; the reads after the create fail twice.
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        yield* shell.next(
          (item): item is Extract<ShellItem, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        mend.workbench.projectDetailFailures = 2;
        const launched = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](
          launchInput({ threadId: ThreadId.make("draft-flaky") }),
        );
        assert.strictEqual(launched.projection.runs[0]?.userMessageId, "message-first");
        yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the first turn");
        assert.deepStrictEqual(calls(mend, "POST", "/turns")[0]?.body, {
          input: "Add a health check",
        });
      }),
    ),
  );

  it.live("never joins an existing worktree by name, even when launched at once (590-R2-1)", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "NAMES");
        // Two launches of the same branch at once: both saw the name free; neither may join.
        yield* Effect.all(
          ["draft-one", "draft-two"].map((thread) =>
            rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](
              launchInput({ threadId: ThreadId.make(thread), initialMessage: undefined }),
            ),
          ),
          { concurrency: 2 },
        );
        const names = calls(mend, "POST", "/projects/project-1/sessions").map((call) =>
          typeof call.body === "object" && call.body !== null && "name" in call.body
            ? String(call.body.name)
            : "",
        );
        assert.strictEqual(names.length, 2);
        for (const name of names) assert.match(name, /^health-check-[a-z0-9]{6}$/);
        assert.notStrictEqual(names[0], names[1]);
        const worktrees = Array.from(mend.workbench.sessions.values()).map(
          (session) => session.worktree,
        );
        assert.strictEqual(new Set(worktrees).size, 2);
      }),
    ),
  );

  it.live(
    "creates a session the person owns, under the client's thread id, and sends its first message once the agent runs",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          const { rpc } = yield* pairAndConnect(mend, "LAUNCH");
          const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));

          const input = launchInput();
          const result = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](input);
          assert.strictEqual(result.threadId, "draft-thread-1");
          assert.isFalse(result.resumed);
          assert.strictEqual(result.projection.thread.id, "draft-thread-1");
          assert.strictEqual(result.projection.thread.runtimeMode, "approval-required");
          // The opening message is the thread's first run, preparing while the session launches.
          assert.strictEqual(result.projection.runs[0]?.status, "preparing");
          assert.strictEqual(result.projection.runs[0]?.userMessageId, "message-first");

          // One session, in a new worktree named from the branch, on the base asked for.
          const created = calls(mend, "POST", "/projects/project-1/sessions");
          assert.strictEqual(created.length, 1);
          const { name, ...body } =
            typeof created[0]?.body === "object" && created[0].body !== null
              ? { name: "", ...created[0].body }
              : { name: "" };
          assert.deepStrictEqual(body, {
            harness: "codex",
            // t3code asked to generate the title: the first line of the first message names it.
            label: "Add a health check",
            base: "main",
            mode: "protocol",
          });
          assert.match(String(name), /^health-check-[a-z0-9]{6}$/);
          // The client opens a launched thread once the shell shows it, by its own id.
          const shown = yield* shell.next(shellThread("draft-thread-1"));
          assert.isNotNull(shown.thread.latestUserMessageAt);

          // Launched on what the client chose, then the message as an exact turn.
          yield* eventually(() => mend.workbench.launches.length === 1, "the launch");
          assert.deepStrictEqual(mend.workbench.launches[0]?.body, {
            mode: "protocol",
            model: "gpt-6.1-sol",
            effort: "high",
            permissionMode: "ask",
          });
          yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the first turn");
          assert.deepStrictEqual(calls(mend, "POST", "/turns")[0]?.body, {
            input: "Add a health check",
          });

          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("draft-thread-1"),
            }),
          );
          const snapshot = yield* thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          assert.strictEqual(snapshot.projection.thread.id, "draft-thread-1");
          assert.strictEqual(snapshot.projection.runs[0]?.userMessageId, "message-first");
          assert.include(["starting", "running"], snapshot.projection.runs[0]?.status);

          // The same command again is the same thread.
          const again = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](input);
          assert.isTrue(again.resumed);
          assert.strictEqual(again.threadId, "draft-thread-1");
          assert.strictEqual(calls(mend, "POST", "/projects/project-1/sessions").length, 1);

          // A follow-up addresses the thread by the client's id.
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            commandId: commandId(),
            createdBy: "user",
            creationSource: "web",
            threadId: ThreadId.make("draft-thread-1"),
            messageId: MessageId.make("message-second"),
            text: "And document it",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
          yield* thread.next(
            runEvent((run) => run.userMessageId === "message-second" && run.status === "queued"),
          );
        }),
      ),
  );

  it.live(
    "joins the worktree of an existing session, and the thread says the workspace is shared",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          const anna = mend.workbench.addSession({ id: "session-anna", projectId: "project-1" });
          const { rpc } = yield* pairAndConnect(mend, "JOIN");
          const result = yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](
            launchInput({
              threadId: ThreadId.make("draft-join"),
              generateTitle: false,
              title: "Pair on the parser",
              runtimeMode: "full-access",
              workspaceStrategy: {
                type: "existing_worktree",
                worktreePath: `/var/lib/mend/store/project-1/worktrees/${anna.worktree}`,
              },
            }),
          );
          assert.strictEqual(result.projection.thread.title, "Pair on the parser");
          const joined = calls(mend, "POST", `/worktrees/${anna.worktreeId}/sessions`);
          assert.deepStrictEqual(joined[0]?.body, {
            harness: "codex",
            label: "Pair on the parser",
            mode: "protocol",
          });
          assert.strictEqual(calls(mend, "POST", "/projects/project-1/sessions").length, 0);
          assert.strictEqual(
            result.projection.thread.worktreePath,
            `/var/lib/mend/store/project-1/worktrees/${anna.worktree}`,
          );

          // ADR 0016's line, word for word, once Anna and Ada are both live in the executor.
          const sessionId = Array.from(mend.workbench.sessions.keys()).find(
            (id) => id !== "session-anna",
          );
          assert.isDefined(sessionId);
          if (sessionId === undefined) return;
          yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the first turn");
          const live = [
            { accountId: "user-anna", name: "Anna" },
            { accountId: "user-1", name: "Ada" },
          ];
          mend.workbench.livePeople.set(sessionId, live);
          mend.workbench.livePeople.set("session-anna", live);
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("draft-join"),
            }),
          );
          const LINE =
            "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.";
          const snapshot = yield* thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          // A read already under way may have seen both of them live before the snapshot.
          const inSnapshot = snapshot.projection.turnItems.some(
            (item) => item.type === "system_notice" && item.message === LINE,
          );
          if (!inSnapshot) {
            mend.workbench.emit({ type: "session-process", sessionId, projectId: "project-1" });
            yield* thread.next(
              (item): item is Extract<Item, { kind: "event" }> =>
                item.kind === "event" &&
                item.event.type === "turn-item.updated" &&
                item.event.payload.type === "system_notice" &&
                item.event.payload.message === LINE,
            );
          }
        }),
      ),
  );

  it.live("refuses what Mend cannot run, with the launch's own typed error", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "REFUSE");
        const launch = (input: OrchestrationV2ThreadLaunchInput) =>
          Effect.exit(rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](input));
        for (const input of [
          launchInput({ workspaceStrategy: { type: "root" } }),
          launchInput({ runtimeMode: "auto-accept-edits" }),
          launchInput({
            modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "x" },
          }),
          launchInput({ projectId: ProjectId.make("project-nobody-sees") }),
          launchInput({
            workspaceStrategy: { type: "existing_worktree", worktreePath: "/nowhere" },
          }),
          // Mend's own refusal, in Mend's words.
          launchInput({ workspaceStrategy: { type: "worktree", baseRef: "no-such-branch" } }),
        ]) {
          const exit = yield* launch(input);
          assert.strictEqual(errorTag(exit), "OrchestrationV2ThreadLaunchError");
          assert.isFalse(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
        }
        assert.strictEqual(mend.workbench.launches.length, 0);
        assert.strictEqual(mend.workbench.sessions.size, 0);
      }),
    ),
  );

  it.live("keeps a launched thread's id across a restart of the gateway", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-launch-")), "state.sqlite");
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "BEFORE");
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread](
            launchInput({ threadId: ThreadId.make("draft-kept") }),
          );
          yield* eventually(() => calls(mend, "POST", "/turns").length === 1, "the first turn");
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));

      const threads = yield* Effect.scoped(
        openGatewayState(statePath).pipe(Effect.flatMap((state) => state.listThreads(PERSON.id))),
      );
      assert.strictEqual(threads[0]?.threadId, "draft-kept");
      assert.strictEqual(threads[0]?.options.permissionMode, "ask");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "AFTER");
          const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: ThreadId.make("draft-kept"),
          });
          assert.strictEqual(projection.thread.id, "draft-kept");
          assert.strictEqual(projection.runs[0]?.userMessageId, "message-first");
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });
});

const setup = (mend: FakeMend, steer = true) => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({ id: "session-1", projectId: "project-1", steer });
};

describe("rename, stop and delete", () => {
  it.live("renames the session in Mend, and refuses one that is not the person's", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        mend.workbench.addSession({ id: "session-2", projectId: "project-1", steer: false });
        const { rpc } = yield* pairAndConnect(mend, "RENAME");
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.metadata.update",
          commandId: commandId(),
          threadId: ThreadId.make("session-1"),
          title: "Parser cleanup",
        });
        assert.deepStrictEqual(calls(mend, "POST", "/sessions/session-1/label")[0]?.body, {
          label: "Parser cleanup",
        });
        yield* shell.next(shellThread("session-1", (thread) => thread.title === "Parser cleanup"));

        const notMine = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.metadata.update",
            commandId: commandId(),
            threadId: ThreadId.make("session-2"),
            title: "Mine now",
          }),
        );
        assert.strictEqual(errorTag(notMine), "EnvironmentAuthorizationError");

        // Only the name moves through Mend.
        const branch = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.metadata.update",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
            branch: "feature/x",
          }),
        );
        assert.strictEqual(errorTag(branch), "OrchestrationV2DispatchCommandError");
      }),
    ),
  );

  it.live("deletes a live session by stopping it first, and the thread goes from the shell", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "DELETE");
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.delete",
          commandId: commandId(),
          threadId: ThreadId.make("session-1"),
        });
        assert.deepStrictEqual(
          mend.workbench.calls
            .filter(
              (call) => call.path.startsWith("/api/sessions/session-1") && call.method !== "GET",
            )
            .map((call) => `${call.method} ${call.path}`),
          [
            "DELETE /api/sessions/session-1",
            "POST /api/sessions/session-1/stop",
            "DELETE /api/sessions/session-1",
          ],
        );
        assert.isFalse(mend.workbench.sessions.has("session-1"));
        yield* shell.next(
          (item): item is Extract<ShellItem, { kind: "thread.removed" }> =>
            item.kind === "thread.removed" && item.threadId === "session-1",
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" && item.event.type === "thread.deleted",
        );
      }),
    ),
  );

  it.live("hides a deleted session Mend keeps until its workspace stops, across a restart", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-removal-")), "state.sqlite");
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      mend.workbench.stopAgent("session-1");
      mend.workbench.removalLeavesWorkspace = true;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "LEFTOVER");
          const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.delete",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
          });
          yield* shell.next(
            (item): item is Extract<ShellItem, { kind: "thread.removed" }> =>
              item.kind === "thread.removed" && item.threadId === "session-1",
          );
          // Mend still lists it; the gateway does not bring it back.
          mend.workbench.emit({ type: "session", sessionId: "session-1", projectId: "project-1" });
          assert.isTrue(yield* shell.quiet((item) => item.kind === "thread.updated"));
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));

      // A restart while Mend still keeps the session: it stays hidden.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "RESTARTED");
          const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
          const first = yield* shell.next(
            (item): item is Extract<ShellItem, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          assert.deepStrictEqual(
            first.snapshot.threads.map((thread) => String(thread.id)),
            [],
          );
          // Mend finishes the removal: the pending removal is forgotten.
          mend.workbench.removeSession("session-1");
          yield* eventually(() => mend.workbench.sessions.size === 0, "the removal");
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "AFTER");
          const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
          yield* shell.next(
            (item): item is Extract<ShellItem, { kind: "snapshot" }> => item.kind === "snapshot",
          );
        }),
      ).pipe(Effect.provide(gatewayTestLayer(mend.url, statePath)));
      const pending = yield* Effect.scoped(
        openGatewayState(statePath).pipe(Effect.flatMap((state) => state.listRemovals(PERSON.id))),
      );
      assert.deepStrictEqual(pending, []);
    });
  });

  it.live(
    "a shared-control steerer's delete stops the owner's session, and Mend refuses the delete",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.workbench.addProject("project-1", "mend");
          mend.workbench.addSession({ id: "session-1", projectId: "project-1", own: false });
          const { rpc } = yield* pairAndConnect(mend, "STEERER");
          // t3code's client detaches a live agent before it deletes the thread.
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "provider-session.detach",
            commandId: commandId(),
            threadId: ThreadId.make("session-1"),
            providerSessionId: ProviderSessionId.make("provider-session:session-1"),
          });
          const deleted = yield* Effect.exit(
            rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "thread.delete",
              commandId: commandId(),
              threadId: ThreadId.make("session-1"),
            }),
          );
          assert.strictEqual(errorTag(deleted), "EnvironmentAuthorizationError");
          assert.strictEqual(calls(mend, "POST", "/sessions/session-1/stop").length, 1);
          assert.isTrue(mend.workbench.sessions.has("session-1"));
        }),
      ),
  );

  it.live("stops the session for provider-session.detach and holds what is queued", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        mend.workbench.addTurn("session-1", "A long job");
        const { rpc } = yield* pairAndConnect(mend, "STOP");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "message.dispatch",
          commandId: commandId(),
          createdBy: "user",
          creationSource: "web",
          threadId: ThreadId.make("session-1"),
          messageId: MessageId.make("message-behind"),
          text: "Behind the long job",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        yield* thread.next(
          runEvent((run) => run.userMessageId === "message-behind" && run.status === "queued"),
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "provider-session.detach",
          commandId: commandId(),
          threadId: ThreadId.make("session-1"),
          providerSessionId: ProviderSessionId.make("provider-session:session-1"),
        });
        assert.strictEqual(calls(mend, "POST", "/sessions/session-1/stop").length, 1);
        const agent = mend.workbench.agents.get("session-1");
        assert.isNotNull(agent?.exitedAt);
        // Held: the stop ended the turn, and nothing relaunches the session unasked.
        yield* thread.next(
          runEvent((run) => run.userMessageId === "message-behind" && run.queueHeld === true),
        );
        assert.isTrue(
          yield* thread.quiet(
            (item) =>
              item.kind === "event" &&
              item.event.type === "run.updated" &&
              item.event.payload.status === "starting",
          ),
        );
        assert.strictEqual(calls(mend, "POST", "/launch").length, 0);
        assert.strictEqual(calls(mend, "POST", "/turns").length, 0);
      }),
    ),
  );
});

describe("planLaunch", () => {
  it("never leaves a session unnamed: the first line with words, cut to Mend's limit", () => {
    assert.strictEqual(labelOf("\n  Fix   the parser \nand its tests"), "Fix the parser");
    const long = labelOf("word ".repeat(40)) ?? "";
    assert.isAtMost(long.length, MEND_LABEL_LIMIT);
    assert.isFalse(long.endsWith(" "));
    assert.isNull(labelOf("  \n "));
    const plan = planLaunch(
      launchInput({ title: "", initialMessage: undefined, generateTitle: true }),
    );
    assert.strictEqual(plan.kind === "launch" ? plan.launch.label : null, "t3code thread");
  });

  it("names a worktree from the branch the client asked for, when Mend can take the name", () => {
    assert.strictEqual(worktreeNameOf("t3code/Fix the Parser"), "fix-the-parser");
    assert.strictEqual(worktreeNameOf("feature/x"), "x");
    assert.isNull(worktreeNameOf("///"));
    assert.isNull(worktreeNameOf(undefined));
  });

  it("names fast service and leaves an effort Mend does not take to Mend", () => {
    const plan = planLaunch(
      launchInput({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6.1-sol",
          options: [
            { id: "reasoningEffort", value: "enormous" },
            { id: "serviceTier", value: "fast" },
          ],
        },
        runtimeMode: "full-access",
      }),
    );
    assert.strictEqual(plan.kind, "launch");
    if (plan.kind !== "launch") return;
    assert.deepStrictEqual(plan.launch.options, {
      model: "gpt-6.1-sol",
      permissionMode: "bypass",
      speed: "fast",
    });
  });

  it("carries the opening message's images by id, and refuses a file", () => {
    const withAttachment = (type: "image" | "file") =>
      planLaunch(
        launchInput({
          initialMessage: {
            text: "See this",
            attachments: [
              {
                type,
                id: "image-1",
                name: "screen.png",
                mimeType: type === "image" ? "image/png" : "text/plain",
                sizeBytes: 10,
              },
            ],
          },
        }),
      );
    const image = withAttachment("image");
    assert.strictEqual(image.kind, "launch");
    assert.deepStrictEqual(image.kind === "launch" ? image.launch.message?.imageIds : null, [
      "image-1",
    ]);
    assert.strictEqual(withAttachment("file").kind, "refused");
  });
});
