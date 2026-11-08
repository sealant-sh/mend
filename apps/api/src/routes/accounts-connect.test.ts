import { accountsGroup, type ConnectAccountInput, ConnectedAccount } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { MessageSettingsRepo, UserAgentLoginsRepo, UserEvents } from "@mend/db";
import { DEFAULT_AGENT_LOGINS, DEFAULT_MESSAGE_SETTINGS } from "@mend/domain/workbench";
import { SealantClients, SealantPlatformError } from "@mend/sealant";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { AccountsGroupLive, AuthMiddlewareLive } from "./api-live.ts";

/** Connecting a Claude or Codex API key over `/api/me/sealant` (ADR 0018). */

type SealantFeatures = Effect.Success<
  ReturnType<SealantClients["Service"]["controlPlaneFeatures"]>
>;

const AccountsApi = HttpApi.make("mend").add(accountsGroup).prefix("/api");

const authLayer: Layer.Layer<Auth> = Layer.succeed(Auth, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  issuePasswordReset: () => Effect.die("unused"),
  getSession: (headers) =>
    Effect.succeed(
      headers.get("authorization") === "Bearer anna"
        ? Option.some({
            user: { id: "anna", email: "anna@example.com", name: "anna" },
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          })
        : Option.none(),
    ),
});

const keyAccount = new ConnectedAccount({
  id: "cacc_key",
  provider: "claude",
  name: "api-key",
  kind: "api-key",
  status: "active",
  metadata: {},
  connectedAt: new Date("2026-11-08T00:00:00.000Z"),
  updatedAt: new Date("2026-11-08T00:00:00.000Z"),
  lastUsedAt: null,
  isDefault: true,
  login: { kind: "api-key", suffix: "a1b2" },
});

const world = (options: {
  readonly features: Effect.Effect<Partial<SealantFeatures>, SealantPlatformError>;
  readonly refusal?: SealantPlatformError;
}) => {
  const connects: Array<ConnectAccountInput> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(SealantClients, {
      sealantUserId: () => Effect.succeed("su-anna"),
      controlPlaneFeatures: () =>
        options.features.pipe(
          Effect.map(
            (features): SealantFeatures => ({
              processUserRoutes: false,
              dotfilesApply: false,
              credentialsPartialPut: false,
              credentialsPiOpencode: false,
              captureOwnerMap: false,
              kubernetesPersonLayout: false,
              workspaceSshUser: false,
              personBinding: false,
              sshKeyRemovalEndsConnections: false,
              connectedAccountDefaults: true,
              connectedAccountLoginClass: false,
              credentialPlacements: false,
              connectedAccountApiKeys: false,
              connectedAccountEndpoints: false,
              inferenceAllowedLogin: false,
              ...features,
            }),
          ),
        ),
      connectedAccounts: () => ({
        list: () => Effect.succeed([keyAccount]),
        connect: (input) =>
          Effect.suspend(() => {
            connects.push(input);
            return options.refusal === undefined
              ? Effect.succeed(keyAccount)
              : Effect.fail(options.refusal);
          }),
        disconnect: () => Effect.die("not in this test"),
      }),
      sshKeys: () => ({
        ensure: () => Effect.die("not in this test"),
        list: () => Effect.die("not in this test"),
        remove: () => Effect.die("not in this test"),
      }),
    }),
    Layer.succeed(UserEvents, { changed: () => Effect.void, leftOrganization: () => Effect.void }),
    Layer.succeed(MessageSettingsRepo, {
      forUser: () => Effect.succeed(DEFAULT_MESSAGE_SETTINGS),
      set: (_, value) => Effect.succeed(value),
    }),
    Layer.succeed(UserAgentLoginsRepo, {
      forUser: () => Effect.succeed(DEFAULT_AGENT_LOGINS),
      set: (_, value) => Effect.succeed(value),
    }),
  );
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const apiLayer = HttpApiBuilder.layer(AccountsApi).pipe(
      Layer.provide(AccountsGroupLive),
      Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
      Layer.provide(HttpServer.layerServices),
    );
    const runtime = ManagedRuntime.make(dependencies);
    const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
    try {
      const context = await runtime.runPromise(
        Effect.context<SealantClients | UserEvents | UserAgentLoginsRepo | MessageSettingsRepo>(),
      );
      const response = await handler(
        new Request(`http://api.internal/api${path}`, {
          method,
          headers: { authorization: "Bearer anna", "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        context,
      );
      const text = await response.text();
      const parsed: unknown = text === "" ? null : JSON.parse(text);
      return { status: response.status, body: parsed };
    } finally {
      await dispose();
      await runtime.dispose();
    }
  };
  return { connects, call };
};

const keysOn = Effect.succeed({ connectedAccountLoginClass: true, connectedAccountApiKeys: true });

describe("/api/me/sealant with API keys", () => {
  it("says whether the platform takes a key, and answers no when it cannot be asked", async () => {
    expect((await world({ features: keysOn }).call("GET", "/me/sealant")).body).toMatchObject({
      apiKeys: true,
      accounts: [{ login: { kind: "api-key", suffix: "a1b2" } }],
    });
    const unknown = world({
      features: Effect.fail(
        new SealantPlatformError({ code: "x", status: null, message: "down", cause: null }),
      ),
    });
    expect((await unknown.call("GET", "/me/sealant")).body).toMatchObject({ apiKeys: false });
  });

  it("passes the class and the default choice through to the platform", async () => {
    const { connects, call } = world({ features: keysOn });
    const answer = await call("POST", "/me/sealant/accounts", {
      provider: "claude",
      secret: "sk-ant-api03-fake",
      login: "api-key",
      makeDefault: true,
    });
    expect(answer.status).toBe(200);
    expect(connects).toEqual([
      expect.objectContaining({ secret: "sk-ant-api03-fake", login: "api-key", makeDefault: true }),
    ]);
  });

  it("refuses a key with a line break before the platform sees it", async () => {
    const { connects, call } = world({ features: keysOn });
    const answer = await call("POST", "/me/sealant/accounts", {
      provider: "codex",
      secret: "sk-proj-fake\nsecond-line",
      login: "api-key",
    });
    expect(answer.status).toBe(400);
    expect(connects).toEqual([]);
  });

  it("hands the platform's refusal to the person in its own words", async () => {
    const { call } = world({
      features: keysOn,
      refusal: new SealantPlatformError({
        code: "connected-account-login-mismatch",
        status: 400,
        message: "That is not an Anthropic API key: it does not start with sk-ant-api.",
        cause: null,
      }),
    });
    const answer = await call("POST", "/me/sealant/accounts", {
      provider: "claude",
      secret: "not-a-key",
      login: "api-key",
    });
    expect(answer).toEqual({
      status: 400,
      body: {
        _tag: "AccountRejected",
        message: "That is not an Anthropic API key: it does not start with sk-ant-api.",
      },
    });
  });
});
