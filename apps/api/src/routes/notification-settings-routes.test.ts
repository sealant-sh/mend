import { devicesGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { NotificationSettingsRepo, PushDevicesRepo } from "@mend/db";
import { DEFAULT_NOTIFICATION_SETTINGS, NotificationSettings } from "@mend/domain/workbench";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";

import { AuthMiddlewareLive, DevicesGroupLive } from "./api-live.ts";

/** What the signed-in account hears about on its phones, over `/api/me/notifications`. */

const TOKENS: Readonly<Record<string, string>> = {
  "Bearer anna": "anna",
  "Bearer ben": "ben",
};
const DevicesApi = HttpApi.make("mend").add(devicesGroup).prefix("/api");

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

/** A world whose saved settings live in `saved`, and a caller that sends as `as`. */
const world = () => {
  const saved = new Map<string, NotificationSettings>();
  const dependencies = Layer.mergeAll(
    Layer.mock(PushDevicesRepo, {}),
    Layer.succeed(NotificationSettingsRepo, {
      forUser: (userId) => Effect.sync(() => saved.get(userId) ?? DEFAULT_NOTIFICATION_SETTINGS),
      forUsers: () => Effect.die("unused"),
      set: (userId, settings) =>
        Effect.sync(() => {
          saved.set(userId, settings);
          return settings;
        }),
    }),
  );
  const call = async (
    as: string,
    method: "GET" | "PUT",
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: unknown }> => {
    const apiLayer = HttpApiBuilder.layer(DevicesApi).pipe(
      Layer.provide(DevicesGroupLive),
      Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
      Layer.provide(HttpServer.layerServices),
    );
    const runtime = ManagedRuntime.make(dependencies);
    const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
    try {
      const context = await runtime.runPromise(
        Effect.context<NotificationSettingsRepo | PushDevicesRepo>(),
      );
      const response = await handler(
        new Request("http://api.internal/api/me/notifications", {
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
  return { saved, call };
};

describe("/api/me/notifications", () => {
  it("answers the defaults before anything is saved: Slack sessions off, every kind on", async () => {
    const { call } = world();
    const read = await call("anna", "GET");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      slackSessions: false,
      turnFinished: true,
      needsInput: true,
      failed: true,
    });
  });

  it("saves the whole setting for the signed-in account only", async () => {
    const { saved, call } = world();
    const quiet = { slackSessions: true, turnFinished: false, needsInput: true, failed: true };
    const written = await call("anna", "PUT", quiet);
    expect(written.status).toBe(200);
    expect(written.body).toEqual(quiet);
    expect([...saved.keys()]).toEqual(["anna"]);
    expect((await call("anna", "GET")).body).toEqual(quiet);
    expect((await call("ben", "GET")).body).toMatchObject({ turnFinished: true });
  });

  it("refuses a partial setting and a caller who is not signed in, and saves nothing", async () => {
    const { saved, call } = world();
    const partial = await call("anna", "PUT", { turnFinished: false });
    expect(partial.status).toBe(400);
    const stranger = await call("nobody", "PUT", {
      slackSessions: true,
      turnFinished: true,
      needsInput: true,
      failed: true,
    });
    expect(stranger.status).toBe(401);
    expect(saved.size).toBe(0);
  });
});
