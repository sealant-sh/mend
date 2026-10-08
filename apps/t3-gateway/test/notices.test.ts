import { assert, describe, it } from "@effect/vitest";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import type {
  MendConversationWait,
  MendProcess,
  MendProject,
  MendSession,
  MendTurn,
} from "../src/mend-workbench.ts";
import {
  NO_NOTICES,
  sharedWorkspaceLine,
  threadNoticesOf,
  workspaceRetirementLine,
  type ThreadNotices,
} from "../src/notices.ts";
import { threadShellOf, type ThreadSource } from "../src/shell.ts";
import { threadProjectionOf, TURN_ORDINAL_STRIDE } from "../src/thread-projection.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer, PERSON } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * What Mend says about people sharing a workspace (docs/adr/0016, decisions 6, 13 and 14), carried
 * to t3code's clients: the shared-workspace, waiting and retirement lines as system notices of the
 * thread, and what a waiting turn waits for as the shell's "Waiting" roster.
 */

const anna = { accountId: "anna", name: "Anna" };
const bob = { accountId: "bob", name: "Bob" };
const cleo = { accountId: "cleo", name: "Cleo" };

describe("the words, mirrored from @mend/domain", () => {
  // The same expectations as packages/domain/src/workbench/shared-workspace.test.ts.
  it("names the others on a session while someone else's process is live", () => {
    assert.strictEqual(
      sharedWorkspaceLine([anna, bob], "bob"),
      "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.",
    );
    assert.strictEqual(
      sharedWorkspaceLine([anna, bob, cleo], "bob"),
      "Shared workspace with Anna and Cleo · each of you runs as yourself · any of you can read the others' files.",
    );
    assert.strictEqual(
      sharedWorkspaceLine([anna, bob], "cleo"),
      "Shared workspace: Anna and Bob · each runs as themselves · either can read the other's files.",
    );
    assert.isNull(sharedWorkspaceLine([anna], "anna"));
    assert.isNull(sharedWorkspaceLine([], "anna"));
  });

  it("says what a retiring workspace takes", () => {
    assert.strictEqual(
      workspaceRetirementLine(
        { state: "marked", preRelease: true, reason: "not replaced · 1 shell" },
        "Anna",
      ),
      "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced · not replaced · 1 shell",
    );
    assert.strictEqual(
      workspaceRetirementLine({ state: "retiring", preRelease: true, reason: null }, "Anna"),
      "Replacing this workspace so that each person runs as themselves · nothing new starts until it has been saved and replaced",
    );
  });

  it("names a launcher it does not know as Mend's clients do", () => {
    const notices = threadNoticesOf({
      livePeople: [],
      viewerId: null,
      wait: null,
      retirement: {
        state: "marked",
        preRelease: false,
        launcher: "carol",
        stops: [],
        reason: null,
        canReplace: false,
      },
      names: new Map(),
    });
    assert.strictEqual(
      notices.retirement,
      "This workspace shares one home · it takes only its launcher's sessions and turns until it is replaced",
    );
  });
});

const project: MendProject = {
  id: "project-1",
  name: "mend",
  storePath: "/var/lib/mend/store/project-1/repo.git",
  defaultBranch: "main",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const session: MendSession = {
  id: "session-1",
  projectId: "project-1",
  worktreeId: "worktree-1",
  harness: "claude",
  model: "fable",
  label: null,
  worktree: "calm-fox",
  branch: "mend/calm-fox",
  baseSha: "6abd2ab9fee56f5a5fa3eaafa7bbad52ae65bdd4",
  baseRef: "main",
  status: "running",
  ownerUserId: "anna",
  createdAt: "2026-10-04T09:00:00.000Z",
  updatedAt: "2026-10-04T09:00:00.000Z",
};
const agent: MendProcess = {
  id: "process-1",
  kind: "agent-protocol",
  harness: "claude",
  status: "running",
  providerSessionId: "thread-1",
  protocolOptions: { model: "fable", effort: null, permissionMode: "bypass" },
  createdAt: "2026-10-04T09:00:00.000Z",
  exitedAt: null,
};
const turn = (id: string, ordinal: number, status: string, author: string): MendTurn => ({
  id,
  sessionId: "session-1",
  ordinal,
  author,
  origin: "request",
  input: `turn ${ordinal}`,
  status,
  error: null,
  createdAt: `2026-10-04T09:00:0${ordinal}.000Z`,
  startedAt: status === "queued" ? null : `2026-10-04T09:00:0${ordinal}.000Z`,
  endedAt: status === "completed" ? `2026-10-04T09:00:0${ordinal}.500Z` : null,
});
const WAIT: MendConversationWait = {
  turnId: "turn-2",
  line: "Waits for Anna's background task and sub-agent before Bob's turn starts.",
  since: "2026-10-04T09:00:02.000Z",
  work: [
    { kind: "task", id: "bash-1", description: "npm test" },
    { kind: "sub-agent", id: "agent-1", description: null },
  ],
};
const sourceWith = (notices: ThreadNotices): ThreadSource => ({
  project,
  session,
  agent,
  changeId: null,
  turns: [turn("turn-1", 1, "completed", "anna"), turn("turn-2", 2, "queued", "bob")],
  requests: [],
  runIds: new Map(),
  messageIds: new Map(),
  pending: [],
  queueHeld: false,
  notices,
});

/** Each system notice: what it says, the run it belongs to, and where it sits. */
const notices = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<readonly [string, string | null, number]> =>
  items.flatMap((item) =>
    item.type === "system_notice" ? [[item.message, item.runId, item.ordinal] as const] : [],
  );

describe("a thread's notices", () => {
  it("says the waiting line after the waiting turn's input, and the others where it stands", () => {
    const projection = threadProjectionOf(
      sourceWith({
        sharedWorkspace: sharedWorkspaceLine([anna, bob], "bob"),
        waiting: WAIT,
        retirement:
          "This workspace shares one home · it takes only Anna's sessions and turns until it is replaced",
      }),
      [],
    );
    assert.deepStrictEqual(notices(projection.turnItems), [
      [
        "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.",
        null,
        3 * TURN_ORDINAL_STRIDE,
      ],
      [
        "This workspace shares one home · it takes only Anna's sessions and turns until it is replaced",
        null,
        3 * TURN_ORDINAL_STRIDE + 1,
      ],
      [WAIT.line, "turn-2", 3 * TURN_ORDINAL_STRIDE - 1],
    ]);
    // In the timeline: the waiting turn's input, then its line, then the thread's lines.
    assert.deepStrictEqual(
      projection.visibleTurnItems.slice(-4).map((row) => row.item.type),
      ["user_message", "system_notice", "system_notice", "system_notice"],
    );
  });

  it("says nothing when nothing applies", () => {
    assert.deepStrictEqual(notices(threadProjectionOf(sourceWith(NO_NOTICES), []).turnItems), []);
  });

  it("lists what the waiting turn waits for as the shell's Waiting roster", () => {
    const counts = { itemCount: 2, visibleItemCount: 2 };
    const shell = threadShellOf(sourceWith({ ...NO_NOTICES, waiting: WAIT }), counts);
    assert.deepStrictEqual(shell.pendingBackgroundTasks, [
      { taskId: "bash-1", kind: "background_task", description: "npm test" },
      { taskId: "agent-1", kind: "subagent" },
    ]);
    assert.deepStrictEqual(
      threadShellOf(sourceWith(NO_NOTICES), counts).pendingBackgroundTasks,
      [],
    );
  });
});

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

type ShellItem = OrchestrationV2ShellStreamItem;
type ThreadItem = OrchestrationV2ThreadStreamItem;

describe("the lines, from Mend to a t3code client", () => {
  it.live("follows who is live, what a turn waits for, and the workspace's retirement", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
        const first = workbench.addTurn("session-1", "Run the suite", "completed");
        const waiting = workbench.addTurn("session-1", "Now fix it", "queued");
        workbench.livePeople.set("session-1", [
          { accountId: PERSON.id, name: PERSON.name },
          { accountId: "anna", name: "Anna" },
        ]);
        workbench.waits.set("session-1", {
          sessionId: "session-1",
          turnId: waiting.id,
          runsAs: "anna",
          sender: PERSON.id,
          openTurn: false,
          work: [{ kind: "task", id: "bash-1", description: "npm test", endable: true }],
          line: `Waits for Anna's background task before ${PERSON.name}'s turn starts.`,
          since: "2026-10-04T09:00:30.000Z",
        });
        workbench.retirements.set("session-1", {
          state: "marked",
          preRelease: true,
          launcher: "anna",
          stops: [{ kind: "shell", label: "shell 1" }],
          reason: null,
          canReplace: false,
        });

        const { rpc } = yield* pairAndConnect(mend, "NOTICES");
        const shell = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({ requestCompletionMarker: true }),
        );
        const { snapshot } = yield* shell.next(
          (item): item is Extract<ShellItem, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        assert.deepStrictEqual(snapshot.threads[0]?.pendingBackgroundTasks, [
          { taskId: "bash-1", kind: "background_task", description: "npm test" },
        ]);

        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        const opened = yield* thread.next(
          (item): item is Extract<ThreadItem, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        assert.deepStrictEqual(notices(opened.projection.turnItems), [
          [
            "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.",
            null,
            3 * TURN_ORDINAL_STRIDE,
          ],
          [
            "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced",
            null,
            3 * TURN_ORDINAL_STRIDE + 1,
          ],
          [
            `Waits for Anna's background task before ${PERSON.name}'s turn starts.`,
            waiting.id,
            3 * TURN_ORDINAL_STRIDE - 1,
          ],
        ]);
        assert.strictEqual(first.status, "completed");

        // Anna's work ends and the turn starts: the waiting line goes, with a fresh snapshot.
        workbench.waits.delete("session-1");
        workbench.setTurn(waiting, "running");
        const after = yield* thread.next(
          (item): item is Extract<ThreadItem, { kind: "snapshot" }> =>
            item.kind === "snapshot" &&
            !item.projection.turnItems.some((entry) => entry.id.startsWith("notice:waiting:")),
        );
        assert.strictEqual(notices(after.projection.turnItems).length, 2);
        const cleared = yield* shell.next(
          (item): item is Extract<ShellItem, { kind: "thread.updated" }> =>
            item.kind === "thread.updated" &&
            (item.thread.pendingBackgroundTasks ?? []).length === 0,
        );
        assert.strictEqual(cleared.thread.id, "session-1");
      }),
    ),
  );
});
