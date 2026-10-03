import { assert, describe, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellStreamItem,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import { refreshKeyOf } from "../src/hub.ts";
import { pointerOfSseLine } from "../src/mend-client.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * Phase 1's shell (ADR 0012, "The surface"): Mend's projects and protocol sessions, kept live from
 * the person's SSE stream. A session started anywhere in Mend (its web app, the CLI, Slack)
 * appears without the client asking again.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

type Item = OrchestrationV2ShellStreamItem;
const isKind =
  <K extends Item["kind"]>(kind: K) =>
  (item: Item): item is Extract<Item, { kind: K }> =>
    item.kind === kind;

describe("the shell", () => {
  it.live("projects Mend's projects and protocol sessions, and follows Mend live", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({ id: "session-codex", projectId: "project-1", label: "fix login" });
        workbench.addSession({
          id: "session-claude",
          projectId: "project-1",
          harness: "claude",
          permissionMode: "ask",
        });
        // A terminal session and a shell are not threads.
        workbench.addSession({ id: "session-pty", projectId: "project-1", kind: "agent-pty" });
        workbench.addSession({
          id: "session-opencode",
          projectId: "project-1",
          harness: "opencode",
        });
        const first = workbench.addTurn(
          "session-claude",
          "Read the README\nand summarise it",
          "completed",
        );

        const { rpc, access, client } = yield* pairAndConnect(mend, "SHELL");
        const shell = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({ requestCompletionMarker: true }),
        );

        const { snapshot } = yield* shell.next(isKind("snapshot"));
        assert.deepStrictEqual(
          snapshot.projects.map((project) => [project.id, project.title, project.workspaceRoot]),
          [["project-1", "mend", "/var/lib/mend/store/project-1/repo.git"]],
        );
        assert.deepStrictEqual(snapshot.threads.map((thread) => thread.id).toSorted(), [
          "session-claude",
          "session-codex",
        ]);
        const claude = snapshot.threads.find((thread) => thread.id === "session-claude");
        assert.strictEqual(claude?.providerInstanceId, "claudeAgent");
        assert.strictEqual(claude?.runtimeMode, "approval-required");
        // No label: the first line of the first message names it.
        assert.strictEqual(claude?.title, "Read the README");
        assert.strictEqual(claude?.status, "completed");
        assert.strictEqual(claude?.latestRunId, first.id);
        assert.strictEqual(
          claude?.worktreePath,
          "/var/lib/mend/store/project-1/worktrees/wt-session-claude",
        );
        const codex = snapshot.threads.find((thread) => thread.id === "session-codex");
        assert.strictEqual(codex?.title, "fix login");
        assert.strictEqual(codex?.runtimeMode, "full-access");
        assert.strictEqual(codex?.status, "idle");
        assert.strictEqual(codex?.modelSelection.model, "gpt-6.1-sol");
        yield* shell.next(isKind("synchronized"));

        // Read as the person who paired, over one event stream.
        const token = `Bearer ${mend.claims[0]?.token}`;
        assert.isTrue(workbench.calls.every((call) => call.authorization === token));
        assert.strictEqual(workbench.eventStreams, 1);

        // A session started from Mend's web app appears.
        workbench.addSession({ id: "session-web", projectId: "project-1", label: "from the web" });
        const added = yield* shell.next(
          (item): item is Extract<Item, { kind: "thread.updated" }> =>
            item.kind === "thread.updated" && item.thread.id === "session-web",
        );
        assert.isAbove(added.sequence, snapshot.snapshotSequence);
        assert.strictEqual(added.thread.title, "from the web");

        // A turn starts on it: the thread runs.
        const turn = workbench.addTurn("session-web", "Add a test");
        const running = yield* shell.next(
          (item): item is Extract<Item, { kind: "thread.updated" }> =>
            item.kind === "thread.updated" &&
            item.thread.id === "session-web" &&
            item.thread.status === "running",
        );
        assert.strictEqual(running.thread.activeRunId, turn.id);
        assert.isAbove(running.sequence, added.sequence);

        // The agent asks: the thread waits on the person, and says what for.
        const request = workbench.addRequest(turn, {
          kind: "command-approval",
          title: "rm -rf dist",
        });
        const waiting = yield* shell.next(
          (item): item is Extract<Item, { kind: "thread.updated" }> =>
            item.kind === "thread.updated" &&
            item.thread.id === "session-web" &&
            item.thread.status === "waiting",
        );
        assert.strictEqual(waiting.thread.pendingRuntimeRequest?.id, request.id);
        assert.strictEqual(waiting.thread.pendingRuntimeRequest?.kind, "command");

        // The same shell over HTTP.
        const viaHttp = yield* client.orchestration.shellSnapshot({
          headers: {
            authorization: `Bearer ${access.access_token}`,
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          },
        });
        assert.strictEqual(viaHttp.snapshotSequence, waiting.sequence);
        assert.strictEqual(
          viaHttp.threads.find((thread) => thread.id === "session-web")?.status,
          "waiting",
        );

        // A session removed in Mend leaves the shell.
        workbench.removeSession("session-web");
        const removed = yield* shell.next(isKind("thread.removed"));
        assert.strictEqual(removed.threadId, "session-web");
      }),
    ),
  );

  it.live("reads everything again after Mend's stream drops", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        const { rpc } = yield* pairAndConnect(mend, "RECONNECT");
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        yield* shell.next(isKind("snapshot"));

        // Mend restarts; a session is started while the gateway is not listening, and Mend's
        // reads fail for a while after its event stream is back.
        workbench.projectsDown = true;
        workbench.dropStreams();
        workbench.addSession({ id: "session-missed", projectId: "project-1" });
        yield* Effect.sleep("1500 millis");
        workbench.projectsDown = false;
        const caught = yield* shell.next(
          (item): item is Extract<Item, { kind: "thread.updated" }> =>
            item.kind === "thread.updated" && item.thread.id === "session-missed",
          "10 seconds",
        );
        assert.strictEqual(caught.thread.status, "idle");
      }),
    ),
  );
});

describe("Mend's pointers", () => {
  it("reads SSE data lines and skips heartbeats", () => {
    assert.deepStrictEqual(
      pointerOfSseLine('data: {"type":"agent-conversation","sessionId":"s","projectId":"p"}'),
      { type: "agent-conversation", sessionId: "s", projectId: "p" },
    );
    assert.isNull(pointerOfSseLine(": ping"));
    assert.isNull(pointerOfSseLine(""));
    assert.isNull(pointerOfSseLine("data: not json"));
  });

  it("refreshes what each pointer names, and nothing for record lines", () => {
    assert.strictEqual(
      refreshKeyOf({ type: "session", sessionId: "s", projectId: "p" }),
      "project:p",
    );
    assert.strictEqual(
      refreshKeyOf({ type: "agent-conversation", sessionId: "s", projectId: "p" }),
      "conversation:s",
    );
    assert.strictEqual(refreshKeyOf({ type: "resync" }), "all");
    assert.isNull(refreshKeyOf({ type: "session-progress", sessionId: "s", projectId: "p" }));
  });
});
