import { assert, describe, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
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
        // A new thread starts in a new worktree: every Mend session has one (`launch.ts`).
        assert.strictEqual(snapshot.projects[0]?.defaultThreadEnvMode, "worktree");
        // t3code's onboarding asks what it could import; Mend's projects are here already.
        const scan = yield* rpc[WS_METHODS.agentSessionsScan]({});
        assert.deepStrictEqual(scan.candidates, []);
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

describe("devices and late pointers", () => {
  it.live(
    "a device revoked in Mend loses its socket while the person's other device keeps reading",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const { workbench } = mend;
          workbench.addProject("project-1", "mend");
          const laptop = yield* pairAndConnect(mend, "LAPTOP");
          const tablet = yield* pairAndConnect(mend, "TABLET");
          const laptopShell = yield* feed(
            laptop.rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}),
          );
          yield* laptopShell.next(isKind("snapshot"));
          const tabletShell = yield* feed(
            tablet.rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}),
          );
          yield* tabletShell.next(isKind("snapshot"));

          // The tablet is revoked in Mend; Mend tells the person's stream their devices moved.
          mend.revoke(mend.claims[1]?.token ?? "");
          workbench.emit({ type: "user", userId: "user-1", facet: "devices" });

          // Its socket closes: nothing more answers on it.
          yield* Effect.gen(function* () {
            for (;;) {
              const probe = yield* Effect.exit(
                tablet.rpc[WS_METHODS.serverProbe]({}).pipe(Effect.timeout("1 second")),
              );
              if (probe._tag === "Failure") return;
              yield* Effect.sleep("100 millis");
            }
          }).pipe(Effect.timeout("5 seconds"));
          // Its bearer no longer authenticates over HTTP either.
          const viaHttp = yield* Effect.exit(
            tablet.client.orchestration.shellSnapshot({
              headers: {
                authorization: `Bearer ${tablet.access.access_token}`,
                [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
              },
            }),
          );
          assert.isTrue(viaHttp._tag === "Failure");

          // The laptop still follows Mend.
          workbench.addSession({ id: "session-after", projectId: "project-1" });
          yield* laptopShell.next(
            (item): item is Extract<Item, { kind: "thread.updated" }> =>
              item.kind === "thread.updated" && item.thread.id === "session-after",
          );
          assert.deepStrictEqual(yield* laptop.rpc[WS_METHODS.serverProbe]({}), {});
        }),
      ),
  );

  it.live("a device the session check finds revoked loses its socket too", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const { rpc, client, access } = yield* pairAndConnect(mend, "SESSIONCHECK");
        assert.deepStrictEqual(yield* rpc[WS_METHODS.serverProbe]({}), {});
        // Revoked in Mend with no pointer: the client's own session check finds it.
        mend.revoke(mend.claims[0]?.token ?? "");
        const state = yield* client.auth.session({
          headers: { authorization: `Bearer ${access.access_token}` },
        });
        assert.isFalse(state.authenticated);
        yield* Effect.gen(function* () {
          for (;;) {
            const probe = yield* Effect.exit(
              rpc[WS_METHODS.serverProbe]({}).pipe(Effect.timeout("1 second")),
            );
            if (probe._tag === "Failure") return;
            yield* Effect.sleep("100 millis");
          }
        }).pipe(Effect.timeout("3 seconds"));
      }),
    ),
  );

  it.live("revoking a person's last device stops the hub reading Mend for them", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        const only = yield* pairAndConnect(mend, "ONLYDEVICE");
        const shell = yield* feed(only.rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        yield* shell.next(isKind("snapshot"));
        assert.strictEqual(workbench.eventStreams, 1);

        // Mend keeps the event stream open on a revocation (it closes it only when the account
        // goes); the gateway closes it itself.
        mend.revoke(mend.claims[0]?.token ?? "");
        workbench.emit({ type: "user", userId: "user-1", facet: "devices" });
        yield* Effect.gen(function* () {
          while (workbench.eventStreams > 0) yield* Effect.sleep("100 millis");
        }).pipe(Effect.timeout("5 seconds"));
        const reads = workbench.calls.length;
        yield* Effect.sleep("1500 millis");
        assert.strictEqual(workbench.eventStreams, 0);
        assert.strictEqual(workbench.calls.length, reads);
      }),
    ),
  );

  it.live("a pointer that arrives during the first full read is applied after it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({ id: "session-1", projectId: "project-1" });
        const turn = workbench.addTurn("session-1", "A turn that ends during the read");
        const { rpc } = yield* pairAndConnect(mend, "LATEPOINTER");
        // The read holds on requests after it read the turn as running; the turn ends meanwhile.
        workbench.requestsDelayMs = 800;
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        yield* Effect.sleep("300 millis");
        workbench.setTurn(turn, "completed");
        const { snapshot } = yield* shell.next(isKind("snapshot"));
        workbench.requestsDelayMs = 0;
        assert.strictEqual(snapshot.threads[0]?.status, "running");
        const caught = yield* shell.next(
          (item): item is Extract<Item, { kind: "thread.updated" }> =>
            item.kind === "thread.updated" && item.thread.status === "completed",
        );
        assert.strictEqual(caught.thread.id, "session-1");
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
    assert.strictEqual(refreshKeyOf({ type: "user", facet: "devices" }), "devices");
    assert.strictEqual(refreshKeyOf({ type: "user", facet: "access" }), "all");
    assert.isNull(refreshKeyOf({ type: "user", facet: "git-access" }));
    assert.isNull(refreshKeyOf({ type: "session-progress", sessionId: "s", projectId: "p" }));
  });
});
