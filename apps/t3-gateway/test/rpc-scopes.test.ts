import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  WsRpcGroup,
  type TerminalAttachStreamEvent,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { grantedScopesOf } from "../src/auth.ts";
import { requiredScopesFor, RPC_REQUIRED_SCOPES } from "../src/rpc-scopes.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { bearer, gatewayTestLayer, PERSON, t3Client, tokenRequest } from "./support/gateway.ts";
import { connectWsRpc, pairAndConnect, socketUrl } from "./support/rpc.ts";

/**
 * t3code's per-RPC scopes (`RpcScopeAuthorization`, from the 2026-10-10 pin): every call is checked
 * against the bearer's grant before its handler runs, and a refusal names the scope as t3code does,
 * decodable by clients from before granular permissions.
 */

const withGateway = <A, E, R>(
  test: (mend: FakeMend) => Effect.Effect<A, E, R>,
  statePath = ":memory:",
) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(
      Effect.scoped,
      Effect.provide(gatewayTestLayer(mend.url, statePath)),
    );
  });

const CWD = "/var/lib/mend/store/project-1/worktrees/wt-session-1";

const setup = (mend: FakeMend) => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
};

/** The typed failure an exit carries, if any. */
const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

/** A socket for a bearer that asked for only these scopes when it paired. */
const connectWithScopes = (mend: FakeMend, code: string, scope: string) =>
  Effect.gen(function* () {
    mend.addPairingCode(code, PERSON);
    const client = yield* t3Client;
    const access = yield* client.auth.token(tokenRequest(code, { scope }));
    const ticket = yield* client.auth.webSocketTicket({ headers: bearer(access.access_token) });
    return yield* connectWsRpc(yield* socketUrl(ticket.ticket));
  });

describe("per-RPC scopes", () => {
  it("names a scope for every method of the group, as t3code's server does", () => {
    const methods = [...WsRpcGroup.requests.keys()].toSorted();
    assert.deepStrictEqual(Object.keys(RPC_REQUIRED_SCOPES).toSorted(), methods);
    // Input-dependent and client-guarded scopes follow t3code's rule.
    assert.deepStrictEqual(requiredScopesFor(WS_METHODS.vcsRemoveWorktree, {}), [
      "source-control:write",
    ]);
    assert.deepStrictEqual(requiredScopesFor(WS_METHODS.terminalObserve, {}), ["terminal:read"]);
    assert.deepStrictEqual(requiredScopesFor("not.a.method", {}), ["access:write"]);
    // The methods whose scope depends on their input, by t3code's own rule.
    assert.deepStrictEqual(
      requiredScopesFor(WS_METHODS.assetsCreateUrl, {
        resource: { _tag: "workspace-file", threadId: "thread-1", path: "src/a.ts" },
      }),
      ["filesystem:read"],
    );
    assert.deepStrictEqual(
      requiredScopesFor(WS_METHODS.assetsCreateUrl, {
        resource: { _tag: "attachment", attachmentId: "image-1" },
      }),
      ["orchestration:read"],
    );
    assert.deepStrictEqual(requiredScopesFor(WS_METHODS.serverUpdateSettings, { patch: {} }), [
      "settings:write",
    ]);
    assert.deepStrictEqual(requiredScopesFor(WS_METHODS.serverUpdateSettings, "not a patch"), [
      "settings:write",
    ]);
  });

  it.live("refuses a call the bearer's grant does not cover, before its handler runs", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const rpc = yield* connectWithScopes(mend, "READONLY", "orchestration:read");
        // Read is granted.
        assert.deepStrictEqual(yield* rpc[WS_METHODS.serverProbe]({}), {});

        const opened = yield* Effect.exit(
          rpc[WS_METHODS.terminalOpen]({ threadId: "session-1", terminalId: "term-1", cwd: CWD }),
        );
        const refusal = failureOf(opened);
        assert.strictEqual(refusal?._tag, "EnvironmentAuthorizationError");
        assert.deepStrictEqual(
          refusal?._tag === "EnvironmentAuthorizationError"
            ? [refusal.requiredScope, refusal.requiredPermission]
            : [],
          ["terminal:operate", "terminal:operate"],
        );
        // Nothing reached Mend: the handler never ran.
        assert.strictEqual(mend.tty.shells.size, 0);

        // A granular permission is named for new clients, its legacy parent for old ones.
        const files = failureOf(
          yield* Effect.exit(
            rpc[WS_METHODS.projectsReadFile]({ cwd: CWD, relativePath: "README.md" }),
          ),
        );
        assert.deepStrictEqual(
          files?._tag === "EnvironmentAuthorizationError"
            ? [files.requiredScope, files.requiredPermission]
            : [],
          ["orchestration:read", "filesystem:read"],
        );
      }),
    ),
  );

  it.live("reads a grant from before granular permissions as the standard grant it was", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-scopes-")), "state.sqlite");
    return withGateway(
      (mend) =>
        Effect.gen(function* () {
          setup(mend);
          mend.addPairingCode("OLDGRANT", PERSON);
          const client = yield* t3Client;
          const access = yield* client.auth.token(tokenRequest("OLDGRANT"));
          // The grant a pairing on the previous pin stored: t3code's standard scopes of the time.
          const database = new DatabaseSync(statePath);
          database
            .prepare("UPDATE bearer_sessions SET scopes = ?")
            .run(
              JSON.stringify([
                "orchestration:read",
                "orchestration:operate",
                "terminal:operate",
                "review:write",
                "relay:read",
              ]),
            );
          database.close();

          const session = yield* client.auth.session({ headers: bearer(access.access_token) });
          for (const scope of AuthStandardClientScopes) {
            assert.include(session.permissions ?? [], scope);
          }
          const ticket = yield* client.auth.webSocketTicket({
            headers: bearer(access.access_token),
          });
          const rpc = yield* connectWsRpc(yield* socketUrl(ticket.ticket));
          // Terminal events need `terminal:read`, which the old grant never named.
          const events = yield* Effect.exit(
            feed(rpc[WS_METHODS.subscribeTerminalEvents]({})).pipe(
              Effect.timeout("500 millis"),
              Effect.asVoid,
            ),
          );
          assert.notStrictEqual(failureOf(events)?._tag, "EnvironmentAuthorizationError");
        }),
      statePath,
    );
  });

  it("reads any other grant as stored", () => {
    assert.deepStrictEqual(grantedScopesOf(["orchestration:read"]), ["orchestration:read"]);
    assert.deepStrictEqual(grantedScopesOf(AuthStandardClientScopes), AuthStandardClientScopes);
  });
});

describe("methods the 2026-10-10 pin added", () => {
  it.live("observes a running terminal and never starts one", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "OBSERVE");
        const none = yield* Effect.exit(
          feed(
            rpc[WS_METHODS.terminalObserve]({ threadId: "session-1", terminalId: "term-1" }),
          ).pipe(
            Effect.flatMap((observed) =>
              observed.next((_event): _event is TerminalAttachStreamEvent => true),
            ),
            Effect.timeout("2 seconds"),
          ),
        );
        assert.isTrue(Exit.isFailure(none));
        assert.strictEqual(mend.tty.shells.size, 0);

        yield* rpc[WS_METHODS.terminalOpen]({
          threadId: "session-1",
          terminalId: "term-1",
          cwd: CWD,
        });
        const observed = yield* feed(
          rpc[WS_METHODS.terminalObserve]({ threadId: "session-1", terminalId: "term-1" }),
        );
        const first = yield* observed.next(
          (event): event is Extract<TerminalAttachStreamEvent, { type: "snapshot" }> =>
            event.type === "snapshot",
        );
        assert.strictEqual(first.snapshot.status, "running");
        assert.strictEqual(mend.tty.shells.size, 1);
      }),
    ),
  );

  it.live("answers one turn item in full, and null for one it does not have", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        mend.workbench.addTurn("session-1", "Fix the parser", "completed");
        const { rpc } = yield* pairAndConnect(mend, "TURNITEM");
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: ThreadId.make("session-1"),
        });
        const [item] = projection.turnItems;
        if (item === undefined) return assert.fail("the thread has no turn items");
        const found = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
          threadId: ThreadId.make("session-1"),
          itemId: item.id,
        });
        assert.deepStrictEqual(found.item, item);
        const missing = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getTurnItem]({
          threadId: ThreadId.make("session-1"),
          itemId: TurnItemId.make("no-such-item"),
        });
        assert.isNull(missing.item);
      }),
    ),
  );
});
