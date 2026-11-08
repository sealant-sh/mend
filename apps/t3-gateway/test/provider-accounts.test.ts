import { ProviderDriverKind, ProviderInstanceId, WS_METHODS } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer, PERSON } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const BOB = { id: "user-2", name: "Bob", email: "bob@example.com" } as const;

describe("provider account controls", () => {
  // Someone checks the connected login or removes it in T3 Settings. Ordinary account use.
  it.live("shows only the chosen caller's display fields and disconnects that exact login", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("accounts-project", "Accounts project");
      mend.workbench.addSession({
        id: "running-account-session",
        projectId: "accounts-project",
        harness: "codex",
        live: true,
        ownerUserId: PERSON.id,
      });
      mend.setAccountsFor(PERSON.id, [
        { id: "ada-other", provider: "codex", status: "active", name: "Other", isDefault: false },
        {
          id: "ada/chosen",
          provider: "codex",
          status: "active",
          name: "Personal",
          isDefault: true,
          kind: "auth-json",
          metadata: { accountEmail: "ada@example.com", unrelatedDisplayField: "omit" },
        },
        { id: "ada-claude", provider: "claude", status: "active", isDefault: true },
      ]);
      mend.setAccountsFor(BOB.id, [
        {
          id: "bob-chosen",
          provider: "codex",
          status: "active",
          name: "Bob",
          isDefault: true,
          metadata: { email: "bob@example.com" },
        },
      ]);
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "ACCOUNTS-ADA");
        const bob = yield* pairAndConnect(mend, "ACCOUNTS-BOB", BOB);
        const config = yield* rpc[WS_METHODS.serverGetConfig]({});
        const codex = config.providers.find((provider) => provider.instanceId === CODEX);
        assert.deepStrictEqual(codex?.auth, {
          status: "authenticated",
          label: "Personal",
          type: "auth-json",
          email: "ada@example.com",
          canLogout: true,
        });
        assert.deepStrictEqual(codex?.setup, { canAuthenticate: false, canInstall: false });
        const state = yield* rpc[WS_METHODS.providerAuthSubscribe]({ instanceId: CODEX }).pipe(
          Stream.runHead,
        );
        assert.strictEqual(Option.getOrThrow(state).phase, "idle");
        assert.strictEqual(
          (yield* rpc[WS_METHODS.providerAuthLogout]({ instanceId: CODEX })).phase,
          "idle",
        );
        assert.deepStrictEqual(mend.accountDisconnections, [
          { userId: PERSON.id, id: "ada/chosen" },
        ]);
        assert.strictEqual(mend.workbench.agents.get("running-account-session")?.status, "running");
        assert.deepStrictEqual(
          mend.workbench.calls.filter((call) => call.method !== "GET"),
          [],
        );
        const after = yield* rpc[WS_METHODS.serverGetConfig]({});
        assert.strictEqual(
          after.providers.find((provider) => provider.instanceId === CODEX)?.auth.canLogout,
          undefined,
        );
        assert.strictEqual(
          (yield* bob.rpc[WS_METHODS.serverGetConfig]({})).providers.find(
            (provider) => provider.instanceId === CODEX,
          )?.auth.email,
          "bob@example.com",
        );
        yield* rpc[WS_METHODS.providerAuthLogout]({ instanceId: CODEX }).pipe(Effect.flip);
        assert.lengthOf(mend.accountDisconnections, 1);
        assert.strictEqual(
          (yield* rpc[WS_METHODS.providerAuthLogout]({ instanceId: CLAUDE })).phase,
          "idle",
        );
        assert.deepStrictEqual(mend.accountDisconnections, [
          { userId: PERSON.id, id: "ada/chosen" },
          { userId: PERSON.id, id: "ada-claude" },
        ]);
        const disconnected = yield* rpc[WS_METHODS.serverGetConfig]({});
        assert.strictEqual(
          disconnected.providers.find((provider) => provider.instanceId === CLAUDE)?.auth.status,
          "unauthenticated",
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }).pipe(Effect.scoped),
  );

  it.live("refuses setup, alternate identities, stale choices and a narrow grant", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.setAccountsFor(PERSON.id, [
        { id: "chosen-before", provider: "codex", status: "active", isDefault: true },
      ]);
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "ACCOUNTS-REFUSALS");
        const unseen = yield* rpc[WS_METHODS.providerAuthLogout]({ instanceId: CODEX }).pipe(
          Effect.flip,
        );
        assert.strictEqual(unseen._tag, "ProviderSetupError");
        yield* rpc[WS_METHODS.serverGetConfig]({});
        const refusedActions: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
          rpc[WS_METHODS.providerAuthStart]({ instanceId: CODEX }),
          rpc[WS_METHODS.providerAuthComplete]({
            instanceId: CODEX,
            flowId: "flow",
            callbackUrl: "https://example.com",
          }),
          rpc[WS_METHODS.providerAuthCancel]({ instanceId: CODEX, flowId: "flow" }),
          rpc[WS_METHODS.providerAuthRespond]({
            instanceId: CODEX,
            flowId: "flow",
            interactionId: "interaction",
            response: { type: "terminal", data: "ignored" },
          }),
          rpc[WS_METHODS.chatGptReconnectProfile]({ instanceId: CODEX, methodId: "chatgpt" }),
          rpc[WS_METHODS.chatGptImportProfile]({
            instanceId: CODEX,
            profile: {
              registration: { clientId: "oaiapp_test" },
              credentials: {
                clientId: "oaiapp_test",
                accessToken: "synthetic-test",
                refreshToken: null,
                idToken: "synthetic-test",
                issuer: "https://example.com",
                expiresAt: 0,
                earliestRefreshAt: null,
                scopes: [],
                subject: "test",
                email: null,
              },
            },
          }),
          rpc[WS_METHODS.providerInstallStart]({ instanceId: CODEX }),
          rpc[WS_METHODS.providerInstallCancel]({ instanceId: CODEX, operationId: "install" }),
          rpc[WS_METHODS.providerInstallRemove]({ instanceId: CODEX }),
          rpc[WS_METHODS.providerAuthLogout]({ instanceId: ProviderInstanceId.make("bob-chosen") }),
          rpc[WS_METHODS.providerAuthLogout]({
            instanceId: ProviderInstanceId.make("shared-codex"),
          }),
          rpc[WS_METHODS.providerAuthLogout]({ instanceId: ProviderInstanceId.make("org-codex") }),
        ];
        for (const action of refusedActions) {
          const error = yield* action.pipe(Effect.flip);
          assert.strictEqual(error._tag, "ProviderSetupError");
        }
        const update = yield* rpc[WS_METHODS.serverUpdateProvider]({
          provider: ProviderDriverKind.make("codex"),
          instanceId: CODEX,
        }).pipe(Effect.flip);
        assert.strictEqual(update._tag, "ServerProviderUpdateError");
        const mutation = yield* rpc[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation: { operation: "remove", instanceId: CODEX },
        }).pipe(Effect.flip);
        assert.strictEqual(mutation._tag, "EnvironmentAuthorizationError");
        mend.setAccountsFor(PERSON.id, [
          { id: "chosen-after", provider: "codex", status: "active", isDefault: true },
        ]);
        const stale = yield* rpc[WS_METHODS.providerAuthLogout]({ instanceId: CODEX }).pipe(
          Effect.flip,
        );
        assert.strictEqual(stale._tag, "ProviderSetupError");
        yield* rpc[WS_METHODS.serverGetConfig]({});
        mend.setAccounts(null);
        const unavailable = yield* rpc[WS_METHODS.providerAuthLogout]({ instanceId: CODEX }).pipe(
          Effect.flip,
        );
        assert.strictEqual(unavailable._tag, "ProviderSetupError");
        const reader = yield* pairAndConnect(mend, "ACCOUNTS-READER", PERSON, "orchestration:read");
        const denied = yield* reader.rpc[WS_METHODS.providerAuthLogout]({
          instanceId: CLAUDE,
        }).pipe(Effect.flip);
        assert.strictEqual(denied._tag, "EnvironmentAuthorizationError");
        assert.deepStrictEqual(mend.accountDisconnections, []);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }).pipe(Effect.scoped),
  );
});
