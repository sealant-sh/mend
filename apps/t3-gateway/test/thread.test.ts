import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadTranscript,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@mend/t3-contracts";
import { threadTranscriptHeader } from "@mend/t3-contracts/thread-transcript";
import { compactDynamicToolOutput, htmlRenderFromToolItem } from "@mend/t3-contracts/tool-output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { NO_LIFECYCLE } from "../src/lifecycle.ts";
import type { MendItem, MendProcess, MendProject, MendSession } from "../src/mend-workbench.ts";
import { NO_NOTICES } from "../src/notices.ts";
import { threadProjectionOf, TURN_ORDINAL_STRIDE } from "../src/thread-projection.ts";
import { assert, describe, it, TestClock } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { pageItem } from "./support/fake-workbench.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { GatewayTimers, withGatewayTimers } from "./support/timers.ts";

/**
 * Phase 1's thread (ADR 0012, "The surface"): one protocol session in full, its turns as runs,
 * its items as turn items and its requests as runtime requests, kept live while watched.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

type Item = OrchestrationV2ThreadStreamItem;
type EventItem = Extract<Item, { kind: "event" }>;

/** The next event that upserts a turn item matching `accept`. */
const turnItemEvent =
  (accept: (item: OrchestrationV2TurnItem) => boolean) =>
  (item: Item): item is EventItem =>
    item.kind === "event" && item.event.type === "turn-item.updated" && accept(item.event.payload);

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** What the old check measured: the transcript as the HTTP response encodes it. */
const responseBytes = (transcript: OrchestrationV2ThreadTranscript) =>
  byteLength(
    JSON.stringify(
      Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadTranscript))(transcript),
    ),
  );

/** The JSONL file t3code's client attaches (`t3:apps/web/src/lib/threadContextAttachment.ts`). */
const attachmentBytes = (
  environmentId: EnvironmentId,
  transcript: OrchestrationV2ThreadTranscript,
) =>
  byteLength(
    [
      threadTranscriptHeader(environmentId, transcript),
      ...transcript.items.map((row) => `${JSON.stringify(row)}\n`),
    ].join(""),
  );

describe("a thread", () => {
  it.live("reads a session in full, and follows a turn as it streams", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          harness: "claude",
          permissionMode: "ask",
        });
        const done = workbench.addTurn("session-1", "What is in docs/adr?", "completed");
        workbench.addItem(done, { kind: "reasoning", text: "Listing the directory." });
        workbench.addItem(done, {
          kind: "command-execution",
          title: "Bash",
          data: { type: "tool_use", name: "Bash", input: { command: "ls docs/adr" } },
        });
        workbench.addItem(done, { kind: "assistant-message", text: "Twelve decisions." });

        const { rpc, access, client } = yield* pairAndConnect(mend, "THREAD");
        const headers = {
          authorization: `Bearer ${access.access_token}`,
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        } as const;

        // The client's cold open: the bounded snapshot over HTTP.
        const bounded = yield* client.orchestration.threadBoundedSnapshot({
          headers,
          params: { threadId: ThreadId.make("session-1") },
          query: {},
        });
        assert.isFalse(bounded.hasMoreHistory);
        assert.isNull(bounded.historyCursor);
        const { projection } = bounded;
        assert.strictEqual(projection.thread.runtimeMode, "approval-required");
        assert.deepStrictEqual(
          projection.runs.map((run) => [run.id, run.ordinal, run.status]),
          [[done.id, 1, "completed"]],
        );
        assert.deepStrictEqual(
          projection.visibleTurnItems.map((row) => [row.position, row.item.type]),
          [
            [0, "user_message"],
            [1, "reasoning"],
            [2, "command_execution"],
            [3, "assistant_message"],
          ],
        );
        const [input, , command, answer] = projection.visibleTurnItems.map((row) => row.item);
        assert.strictEqual(input?.type === "user_message" ? input.text : null, done.input);
        assert.strictEqual(input?.ordinal, TURN_ORDINAL_STRIDE);
        assert.strictEqual(
          command?.type === "command_execution" ? command.input : null,
          "ls docs/adr",
        );
        assert.strictEqual(
          answer?.type === "assistant_message" ? answer.text : null,
          "Twelve decisions.",
        );
        assert.strictEqual(bounded.latestLocalTurnOrdinal, answer?.ordinal);

        const transcript = yield* client.orchestration.threadTranscript({
          headers,
          params: { threadId: ThreadId.make("session-1") },
        });
        assert.strictEqual(transcript.threadId, "session-1");
        assert.strictEqual(transcript.title, projection.thread.title);
        assert.deepStrictEqual(transcript.items, projection.visibleTurnItems);
        assert.deepStrictEqual(
          projection.messages.map((message) => [message.role, message.text]),
          [
            ["user", done.input],
            ["assistant", "Twelve decisions."],
          ],
        );
        assert.strictEqual(projection.providerSessions[0]?.status, "ready");
        assert.strictEqual(
          projection.thread.activeProviderThreadId,
          projection.providerThreads[0]?.id,
        );

        // Then the socket, resuming after the snapshot.
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
            afterSequence: bounded.snapshotSequence,
            requestCompletionMarker: true,
          }),
        );
        const snapshot = yield* thread.next(
          (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
        );
        assert.strictEqual(snapshot.projection.turnItems.length, 4);
        yield* thread.next(
          (item): item is Extract<Item, { kind: "synchronized" }> => item.kind === "synchronized",
        );

        // A follow-up from Mend's web app: a new run, its input, then the answer as it streams.
        const turn = workbench.addTurn("session-1", "And which is newest?");
        const run = yield* thread.next(
          (item): item is EventItem =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.id === turn.id &&
            item.event.payload.status === "running",
        );
        assert.isAbove(run.sequence, snapshot.snapshotSequence);
        yield* thread.next(
          turnItemEvent((item) => item.type === "user_message" && item.text === turn.input),
        );
        const streaming = workbench.addItem(turn, {
          kind: "assistant-message",
          text: "ADR",
          status: "in-progress",
        });
        const partial = yield* thread.next(
          turnItemEvent((item) => item.type === "assistant_message" && item.id === streaming.id),
        );
        assert.isTrue(
          partial.event.type === "turn-item.updated" &&
            partial.event.payload.type === "assistant_message" &&
            partial.event.payload.streaming,
        );
        workbench.updateItem(streaming, {
          text: "ADR 0012, the t3code gateway.",
          status: "completed",
        });
        const whole = yield* thread.next(
          turnItemEvent(
            (item) =>
              item.type === "assistant_message" && item.id === streaming.id && !item.streaming,
          ),
        );
        assert.isTrue(
          whole.event.type === "turn-item.updated" &&
            whole.event.payload.type === "assistant_message" &&
            whole.event.payload.text === "ADR 0012, the t3code gateway.",
        );
        assert.isAbove(whole.sequence, partial.sequence);

        // The agent asks before it runs a command: a pending request and the item that shows it.
        const request = workbench.addRequest(turn, {
          kind: "command-approval",
          title: "Run a command",
          detail: { command: "git log -1" },
        });
        const asked = yield* thread.next(
          (item): item is EventItem =>
            item.kind === "event" &&
            item.event.type === "runtime-request.updated" &&
            item.event.payload.id === request.id,
        );
        assert.isTrue(
          asked.event.type === "runtime-request.updated" &&
            asked.event.payload.status === "pending" &&
            asked.event.payload.kind === "command" &&
            asked.event.payload.responseCapability.type === "live",
        );
        const shown = yield* thread.next(turnItemEvent((item) => item.type === "approval_request"));
        assert.isTrue(
          shown.event.type === "turn-item.updated" &&
            shown.event.payload.type === "approval_request" &&
            shown.event.payload.prompt === "Run a command\ngit log -1",
        );

        // Items were read by cursor, never the whole list again.
        const itemReads = workbench.calls.filter((call) => call.path.endsWith("/items"));
        assert.isTrue(itemReads.some((call) => !call.query.includes("after=0&")));

        // The session removed in Mend: the thread is deleted.
        workbench.removeSession("session-1");
        yield* thread.next(
          (item): item is EventItem =>
            item.kind === "event" && item.event.type === "thread.deleted",
        );
      }),
    ),
  );

  it.effect("catches up a watched thread's items after Mend's stream drops", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const timers = yield* GatewayTimers;
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({ id: "session-1", projectId: "project-1" });
        const turn = workbench.addTurn("session-1", "Explain it");
        const answer = workbench.addItem(turn, {
          kind: "assistant-message",
          text: "Partial",
          status: "in-progress",
        });
        const { rpc } = yield* pairAndConnect(mend, "CATCHUP");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
            threadId: ThreadId.make("session-1"),
          }),
        );
        yield* TestClock.withLive(
          thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          ),
        );

        // The final answer lands while the gateway is not listening.
        workbench.dropStreams();
        workbench.updateItem(answer, { text: "The whole answer.", status: "completed" });
        workbench.setTurn(turn, "completed");
        yield* timers.runOut("1 second", "the reconnect to Mend's event stream");

        const caught = yield* TestClock.withLive(
          thread.next(
            turnItemEvent(
              (item) =>
                item.type === "assistant_message" && item.id === answer.id && !item.streaming,
            ),
            "10 seconds",
          ),
        );
        assert.isTrue(
          caught.event.type === "turn-item.updated" &&
            caught.event.payload.type === "assistant_message" &&
            caught.event.payload.text === "The whole answer.",
        );
      }),
    ).pipe(withGatewayTimers),
  );

  it.live("refuses a transcript whose attachment, not its response, passes 50 MiB", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const turn = mend.workbench.addTurn("session-1", "Write it all out.", "completed");
        const answer = mend.workbench.addItem(turn, { kind: "assistant-message", text: "" });
        const { access, client } = yield* pairAndConnect(mend, "BIGTHREAD");
        const { environmentId } = yield* client.metadata.descriptor();
        const request = {
          headers: {
            authorization: `Bearer ${access.access_token}`,
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          },
          params: { threadId: ThreadId.make("session-1") },
        } as const;
        const transcriptOf = Effect.gen(function* () {
          const { projection } = yield* client.orchestration.threadSnapshot(request);
          return {
            threadId: projection.thread.id,
            title: projection.thread.title,
            updatedAt: projection.updatedAt,
            items: projection.visibleTurnItems,
          };
        });
        const answerOf = (bytes: number) => {
          mend.workbench.updateItem(answer, { text: "a".repeat(bytes) });
          return transcriptOf;
        };

        // The answer grows the response and the attachment byte for byte; the attachment's
        // header and newlines cost more than the response's envelope.
        const empty = yield* transcriptOf;
        const atResponseLimit = yield* answerOf(
          PROVIDER_SEND_TURN_MAX_FILE_BYTES - responseBytes(empty),
        );
        assert.strictEqual(responseBytes(atResponseLimit), PROVIDER_SEND_TURN_MAX_FILE_BYTES);
        const over =
          attachmentBytes(environmentId, atResponseLimit) - PROVIDER_SEND_TURN_MAX_FILE_BYTES;
        assert.isAbove(over, 0);
        const refused = yield* Effect.exit(client.orchestration.threadTranscript(request));
        const error = Exit.isFailure(refused)
          ? Option.getOrUndefined(Cause.findErrorOption(refused.cause))
          : undefined;
        assert.strictEqual(
          error?._tag === "EnvironmentRequestInvalidError" ? error.reason : error?._tag,
          "thread_transcript_too_large",
        );

        const atAttachmentLimit = yield* answerOf(
          PROVIDER_SEND_TURN_MAX_FILE_BYTES - responseBytes(empty) - over,
        );
        const transcript = yield* client.orchestration.threadTranscript(request);
        assert.deepStrictEqual(transcript, atAttachmentLimit);
        assert.strictEqual(
          attachmentBytes(environmentId, transcript),
          PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        );
      }),
    ),
  );

  it.live("answers a thread the person does not have with t3code's typed refusals", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-pty", projectId: "project-1", kind: "agent-pty" });
        const { rpc, access, client } = yield* pairAndConnect(mend, "NOTHREAD");

        for (const threadId of ["session-pty", "nowhere"]) {
          const projection = yield* Effect.exit(
            rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: ThreadId.make(threadId),
            }),
          );
          assert.isTrue(Exit.isFailure(projection));
          if (Exit.isFailure(projection)) {
            assert.strictEqual(
              Option.getOrUndefined(Cause.findErrorOption(projection.cause))?._tag,
              "OrchestrationV2GetThreadProjectionError",
            );
            assert.isFalse(Cause.hasDies(projection.cause));
          }
          const viaHttp = yield* Effect.exit(
            client.orchestration.threadSnapshot({
              headers: {
                authorization: `Bearer ${access.access_token}`,
                [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
              },
              params: { threadId: ThreadId.make(threadId) },
            }),
          );
          assert.isTrue(Exit.isFailure(viaHttp));
          if (Exit.isFailure(viaHttp)) {
            assert.strictEqual(
              Option.getOrUndefined(Cause.findErrorOption(viaHttp.cause))?._tag,
              "EnvironmentResourceNotFoundError",
            );
          }
          const transcript = yield* Effect.exit(
            client.orchestration.threadTranscript({
              headers: {
                authorization: `Bearer ${access.access_token}`,
                [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
              },
              params: { threadId: ThreadId.make(threadId) },
            }),
          );
          assert.strictEqual(
            Exit.isFailure(transcript)
              ? Option.getOrUndefined(Cause.findErrorOption(transcript.cause))?._tag
              : "succeeded",
            "EnvironmentResourceNotFoundError",
          );
        }
      }),
    ),
  );
});

// ─── Mapping ─────────────────────────────────────────────────────────────────

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
  harness: "codex",
  model: "gpt-6.1-sol",
  label: null,
  worktree: "calm-fox",
  branch: "mend/calm-fox",
  baseSha: "6abd2ab9fee56f5a5fa3eaafa7bbad52ae65bdd4",
  baseRef: "main",
  status: "running",
  ownerUserId: "user-1",
  createdAt: "2026-10-04T09:00:00.000Z",
  updatedAt: "2026-10-04T09:00:00.000Z",
};
const agent: MendProcess = {
  id: "process-1",
  kind: "agent-protocol",
  harness: "codex",
  status: "running",
  providerSessionId: "thread-1",
  protocolOptions: { model: "gpt-6.1-sol", effort: null, permissionMode: "bypass" },
  createdAt: "2026-10-04T09:00:00.000Z",
  exitedAt: null,
};
const item = (overrides: Partial<MendItem> & Pick<MendItem, "id" | "kind">): MendItem => ({
  turnId: "turn-1",
  seq: 1,
  status: "completed",
  title: null,
  text: null,
  data: null,
  createdAt: "2026-10-04T09:00:01.000Z",
  updatedAt: "2026-10-04T09:00:01.000Z",
  ...overrides,
});

describe("Mend's items as turn items", () => {
  const projectionWith = (
    items: ReadonlyArray<MendItem>,
    turnStatus = "completed",
    error: string | null = null,
  ) =>
    threadProjectionOf(
      {
        threadId: ThreadId.make(session.id),
        imagesOf: () => [],
        steers: [],
        turnCheckpoints: new Map(),
        sharedWorktree: false,
        nextMode: null,
        archivedAt: null,
        lifecycle: NO_LIFECYCLE,
        lastVisitedAt: null,
        nextEffort: null,
        nextModel: null,
        project,
        session,
        agent,
        changeId: null,
        turns: [
          {
            id: "turn-1",
            sessionId: "session-1",
            ordinal: 0,
            author: "user-1",
            origin: "request",
            input: "Go",
            status: turnStatus,
            error,
            createdAt: "2026-10-04T09:00:00.000Z",
            startedAt: "2026-10-04T09:00:00.000Z",
            endedAt: "2026-10-04T09:00:09.000Z",
          },
        ],
        requests: [],
        runIds: new Map(),
        messageIds: new Map(),
        pending: [],
        queueHeld: false,
        notices: NO_NOTICES,
      },
      items,
    );

  it("projects a page, hides its published call, and keeps a call that failed", () => {
    const call = (id: string, attachmentId: string | null) =>
      item({
        id,
        kind: "tool-call",
        title: "mcp__mend__html_render",
        status: attachmentId === null ? "failed" : "completed",
        data: {
          type: "tool_use",
          name: "mcp__mend__html_render",
          input: { title: "Latency", height: 420 },
          mendPageCall: {
            attachmentId,
            failure: attachmentId === null ? { code: "invalid_request", message: "vh" } : null,
          },
        },
      });
    const { turnItems } = projectionWith([
      call("item-published", "page-1"),
      item({
        id: "item-page",
        ...pageItem({ id: "page-1", sessionId: "session-1", title: "Latency", height: 420 }),
      }),
      call("item-refused", null),
    ]);
    assert.deepStrictEqual(
      turnItems.map((entry) => [entry.id, entry.type]),
      [
        ["input:turn-1", "user_message"],
        ["item-page", "dynamic_tool"],
        ["item-refused", "dynamic_tool"],
      ],
    );
    const page = turnItems[1];
    if (page?.type !== "dynamic_tool") throw new Error("Expected the page tool item");
    assert.strictEqual(page.status, "completed");
    assert.deepStrictEqual(htmlRenderFromToolItem(page), {
      attachmentId: "page-1",
      title: "Latency",
      height: 420,
    });
    assert.deepStrictEqual(compactDynamicToolOutput(page.output), {
      htmlRender: { attachmentId: "page-1", title: "Latency", height: 420 },
    });
    assert.isBelow(Buffer.byteLength(JSON.stringify(page.output)), 16_384);
  });

  it("bounds page metadata for the pinned reader", () => {
    const { turnItems } = projectionWith([
      item({
        id: "page-item",
        ...pageItem({
          id: "x".repeat(256),
          sessionId: "session-1",
          title: "\u0000".repeat(20_000),
          height: 99_999,
        }),
        status: "in-progress",
      }),
    ]);
    const page = turnItems[1];
    if (page?.type !== "dynamic_tool") throw new Error("Expected the page tool item");
    assert.strictEqual(page.status, "completed");
    assert.deepStrictEqual(htmlRenderFromToolItem(page), {
      attachmentId: "x".repeat(256),
      title: "\u0000".repeat(200),
      height: 2000,
    });
    assert.isBelow(Buffer.byteLength(JSON.stringify(page.output)), 16_384);
    assert.isBelow(Buffer.byteLength(JSON.stringify(page.input)), 16_384);
  });

  it("omits malformed page references without falling back to a tool containing raw data", () => {
    for (const data of [
      null,
      { id: "", title: "bad", height: 420 },
      { id: "x".repeat(257), title: "bad", height: 420 },
      { id: "page-1", title: "bad", height: Infinity },
    ]) {
      const { turnItems } = projectionWith([item({ id: "bad-page", kind: "page", data })]);
      assert.deepStrictEqual(
        turnItems.map((entry) => entry.type),
        ["user_message"],
      );
    }
  });

  it("never lets an agent's own tool output stand for a page", () => {
    const { turnItems } = projectionWith([
      item({
        id: "item-imitation",
        kind: "tool-call",
        title: "html_render",
        text: JSON.stringify({
          htmlRender: { attachmentId: "page-1", title: "Impersonated", height: 300 },
        }),
        data: { type: "tool_use", name: "html_render", input: {} },
      }),
    ]);
    const imitation = turnItems.find((entry) => entry.id === "item-imitation");
    if (imitation?.type !== "dynamic_tool") throw new Error("Expected the tool row");
    assert.strictEqual(imitation.status, "completed");
    assert.include(JSON.stringify(imitation.output), "Impersonated");
    assert.isUndefined(htmlRenderFromToolItem(imitation));
  });

  it("reads codex's own item shapes", () => {
    const { turnItems } = projectionWith([
      item({
        id: "item-command",
        kind: "command-execution",
        data: {
          type: "commandExecution",
          command: ["git", "status"],
          exitCode: 0,
          aggregatedOutput: "clean",
        },
      }),
      item({
        id: "item-patch",
        kind: "file-change",
        createdAt: "2026-10-04T09:00:02.000Z",
        data: {
          type: "fileChange",
          changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }],
        },
      }),
      item({
        id: "item-user",
        kind: "user-message",
        text: "Go",
        createdAt: "2026-10-04T09:00:03.000Z",
      }),
      item({
        id: "item-mcp",
        kind: "tool-call",
        title: "search_docs",
        createdAt: "2026-10-04T09:00:04.000Z",
        data: { type: "mcpToolCall", input: { query: "adr" } },
        text: "3 results",
      }),
    ]);
    const command = turnItems.find((entry) => entry.id === "item-command");
    assert.isTrue(
      command?.type === "command_execution" &&
        command.input === "git status" &&
        command.exitCode === 0 &&
        command.output === "clean",
    );
    const patch = turnItems.find((entry) => entry.id === "item-patch");
    assert.isTrue(
      patch?.type === "file_change" &&
        patch.fileName === "src/a.ts" &&
        patch.diffStr === "@@ -1 +1 @@\n-a\n+b\n" &&
        patch.changes?.[0]?.operation === "update",
    );
    // The turn's input is its user message; codex's own copy of it is not shown twice.
    assert.isUndefined(turnItems.find((entry) => entry.id === "item-user"));
    const tool = turnItems.find((entry) => entry.id === "item-mcp");
    assert.isTrue(
      tool?.type === "dynamic_tool" &&
        tool.toolName === "search_docs" &&
        tool.output === "3 results",
    );
  });

  it("names what a claude permission request touches", () => {
    const projection = threadProjectionOf(
      {
        threadId: ThreadId.make(session.id),
        imagesOf: () => [],
        steers: [],
        turnCheckpoints: new Map(),
        sharedWorktree: false,
        nextMode: null,
        archivedAt: null,
        lifecycle: NO_LIFECYCLE,
        lastVisitedAt: null,
        nextEffort: null,
        nextModel: null,
        project,
        session,
        agent,
        changeId: null,
        turns: [
          {
            id: "turn-1",
            sessionId: "session-1",
            ordinal: 0,
            author: "user-1",
            origin: "request",
            input: "Write it",
            status: "running",
            error: null,
            createdAt: "2026-10-04T09:00:00.000Z",
            startedAt: "2026-10-04T09:00:00.000Z",
            endedAt: null,
          },
        ],
        requests: [
          {
            id: "request-1",
            turnId: "turn-1",
            kind: "tool-permission",
            title: "Write",
            // As the live box recorded it (2026-10-04).
            detail: {
              input: { content: "hello", file_path: "/workspace/repo/t3.txt" },
              toolName: "Write",
              suggestions: [{ mode: "acceptEdits", type: "setMode", destination: "session" }],
            },
            questions: null,
            status: "pending",
            decision: null,
            answers: null,
            createdAt: "2026-10-04T09:00:01.000Z",
            decidedAt: null,
          },
        ],
        runIds: new Map(),
        messageIds: new Map(),
        pending: [],
        queueHeld: false,
        notices: NO_NOTICES,
      },
      [],
    );
    const approval = projection.turnItems.find((entry) => entry.type === "approval_request");
    assert.isTrue(
      approval?.type === "approval_request" &&
        approval.prompt === "Write\nWrite /workspace/repo/t3.txt" &&
        approval.requestKind === "permission",
    );
  });

  it("says why a turn failed, after what it did", () => {
    const { turnItems } = projectionWith([], "failed", "usage limit reached");
    const last = turnItems.at(-1);
    assert.isTrue(last?.type === "error" && last.failure.message === "usage limit reached");
  });
});
