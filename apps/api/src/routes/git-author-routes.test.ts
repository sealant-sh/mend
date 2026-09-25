import { gitKeysGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { UserEvents, UserGitAccessRepo, UserGitAuthorRepo } from "@mend/db";
import { type GitAuthor, ResolvedGitAuthor } from "@mend/domain/workbench";
import { AgentBridge, MendKeys } from "@mend/store";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";

import { AuthMiddlewareLive } from "./api-live.ts";
import { GitKeysGroupLive } from "./workbench.ts";

/** The account setting "Git author" (docs/GIT-ACCESS.md) over `/api/me/git-author`. */

const AUTHORIZATION = "Bearer git-author-routes-test";
const GitKeysApi = HttpApi.make("mend").add(gitKeysGroup).prefix("/api");

const authLayer: Layer.Layer<Auth> = Layer.succeed(Auth, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  issuePasswordReset: () => Effect.die("unused"),
  getSession: (headers) =>
    Effect.succeed(
      headers.get("authorization") === AUTHORIZATION
        ? Option.some({
            user: { id: "anna", email: "anna@example.com", name: "Anna Example" },
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          })
        : Option.none(),
    ),
});

type GitKeysRouteServices =
  | AgentBridge
  | MendKeys
  | UserEvents
  | UserGitAccessRepo
  | UserGitAuthorRepo;

/** One request against a world whose saved setting is `saved` (null: none). */
const call = async (
  method: "GET" | "PUT" | "DELETE",
  body?: unknown,
): Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly saved: ReadonlyArray<GitAuthor | null>;
}> => {
  const saved: Array<GitAuthor | null> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(AgentBridge, { socketPath: () => "/unused/agent.sock" }),
    Layer.mock(MendKeys, {}),
    Layer.mock(UserEvents, {}),
    Layer.mock(UserGitAccessRepo, {}),
    Layer.succeed(UserGitAuthorRepo, {
      resolve: () =>
        Effect.sync(() => {
          const setting = saved.at(-1) ?? null;
          return setting === null
            ? new ResolvedGitAuthor({
                name: "Anna Example",
                email: "anna@example.com",
                source: "account",
              })
            : new ResolvedGitAuthor({ ...setting, source: "setting" });
        }),
      set: (_userId, author) => Effect.sync(() => void saved.push(author)),
      clear: () => Effect.sync(() => void saved.push(null)),
    }),
  );
  const apiLayer = HttpApiBuilder.layer(GitKeysApi).pipe(
    Layer.provide(GitKeysGroupLive),
    Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
    Layer.provide(HttpServer.layerServices),
  );
  const runtime = ManagedRuntime.make(dependencies);
  const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
  try {
    const context = await runtime.runPromise(Effect.context<GitKeysRouteServices>());
    const response = await handler(
      new Request("http://api.internal/api/me/git-author", {
        method,
        headers: { authorization: AUTHORIZATION, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      context,
    );
    return { status: response.status, body: await response.json(), saved };
  } finally {
    await dispose();
    await runtime.dispose();
  }
};

describe("/api/me/git-author", () => {
  it("answers the account's registration name and email until one is saved", async () => {
    const read = await call("GET");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      name: "Anna Example",
      email: "anna@example.com",
      source: "account",
    });
  });

  it("saves a trimmed author and answers it as the account's setting", async () => {
    const result = await call("PUT", { name: "  Anna E. ", email: " anna@work.example " });
    expect(result.status).toBe(200);
    expect(result.saved.map((author) => (author === null ? null : { ...author }))).toEqual([
      { name: "Anna E.", email: "anna@work.example" },
    ]);
    expect(result.body).toEqual({
      name: "Anna E.",
      email: "anna@work.example",
      source: "setting",
    });
  });

  it("refuses an author git would not commit as it was typed, and saves nothing", async () => {
    const result = await call("PUT", { name: "Anna <anna@x>", email: "anna@example.com" });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      _tag: "SettingsFailure",
      message: "git author not saved · the name contains <, > or a line break",
    });
    expect(result.saved).toEqual([]);
  });

  it("clears back to the account's own", async () => {
    const result = await call("DELETE");
    expect(result.status).toBe(200);
    expect(result.saved).toEqual([null]);
    expect(result.body).toMatchObject({ source: "account" });
  });
});
