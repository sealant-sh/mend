import { accountsGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { UserAgentLoginsRepo, UserEvents } from "@mend/db";
import { AgentLogins, DEFAULT_AGENT_LOGINS } from "@mend/domain/workbench";
import { SealantClients } from "@mend/sealant";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";

import { AccountsGroupLive, AuthMiddlewareLive } from "./api-live.ts";

/**
 * Which of the signed-in account's own logins its Claude and Codex sessions receive, over
 * `/api/me/agent-logins` (docs/adr/0016, decision 5).
 */

const TOKENS: Readonly<Record<string, string>> = {
  "Bearer anna": "anna",
  "Bearer ben": "ben",
};
const AccountsApi = HttpApi.make("mend").add(accountsGroup).prefix("/api");

const authLayer: Layer.Layer<Auth> = Layer.succeed(Auth, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  issuePasswordReset: () => Effect.die("unused"),
  getSession: (headers) => {
    const userId = TOKENS[headers.get("authorization") ?? ""];
    return Effect.succeed(
      userId === undefined
        ? Option.none()
        : Option.some({
            user: { id: userId, email: `${userId}@example.com`, name: userId },
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          }),
    );
  },
});

/** A world whose saved settings live in `saved`, and whose account pointers land in `changed`. */
const world = () => {
  const saved = new Map<string, AgentLogins>();
  const changed: Array<string> = [];
  const dependencies = Layer.mergeAll(
    // The setting is Mend's own: the platform is never asked.
    Layer.mock(SealantClients, {
      connectedAccounts: () => ({
        list: () => Effect.die("not in this test"),
        connect: () => Effect.die("not in this test"),
        disconnect: () => Effect.die("not in this test"),
      }),
      sshKeys: () => ({
        ensure: () => Effect.die("not in this test"),
        list: () => Effect.die("not in this test"),
        remove: () => Effect.die("not in this test"),
      }),
    }),
    Layer.succeed(UserEvents, {
      changed: (userId, facet) => Effect.sync(() => changed.push(`${userId}:${facet}`)),
    }),
    Layer.succeed(UserAgentLoginsRepo, {
      forUser: (userId) => Effect.sync(() => saved.get(userId) ?? DEFAULT_AGENT_LOGINS),
      set: (userId, setting) =>
        Effect.sync(() => {
          saved.set(userId, setting);
          return setting;
        }),
    }),
  );
  const call = async (
    as: string,
    method: "GET" | "PUT",
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: unknown }> => {
    const apiLayer = HttpApiBuilder.layer(AccountsApi).pipe(
      Layer.provide(AccountsGroupLive),
      Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
      Layer.provide(HttpServer.layerServices),
    );
    const runtime = ManagedRuntime.make(dependencies);
    const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
    try {
      const context = await runtime.runPromise(
        Effect.context<SealantClients | UserEvents | UserAgentLoginsRepo>(),
      );
      const response = await handler(
        new Request("http://api.internal/api/me/agent-logins", {
          method,
          headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        context,
      );
      const text = await response.text();
      return { status: response.status, body: text === "" ? null : JSON.parse(text) };
    } finally {
      await dispose();
      await runtime.dispose();
    }
  };
  return { saved, changed, call };
};

describe("/api/me/agent-logins", () => {
  it("answers every login before anything is saved", async () => {
    const { call } = world();
    const read = await call("anna", "GET");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ selectedOnly: false });
  });

  it("saves the setting for the signed-in account only, and tells its screens", async () => {
    const { saved, changed, call } = world();
    const written = await call("anna", "PUT", { selectedOnly: true });
    expect(written.status).toBe(200);
    expect(written.body).toEqual({ selectedOnly: true });
    expect([...saved.keys()]).toEqual(["anna"]);
    expect(changed).toEqual(["anna:accounts"]);
    expect((await call("anna", "GET")).body).toEqual({ selectedOnly: true });
    expect((await call("ben", "GET")).body).toEqual({ selectedOnly: false });
  });

  it("refuses a setting without its value and a caller who is not signed in, and saves nothing", async () => {
    const { saved, call } = world();
    expect((await call("anna", "PUT", {})).status).toBe(400);
    expect((await call("nobody", "PUT", { selectedOnly: true })).status).toBe(401);
    expect(saved.size).toBe(0);
  });
});
