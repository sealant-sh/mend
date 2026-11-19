import { personSettingsGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { PersonSettingsRepo, SessionDefaultsRepo, UserEvents } from "@mend/db";
import { defaultPersonSettings, PersonSettings } from "@mend/domain";
import { NO_SESSION_DEFAULTS, SessionDefaults } from "@mend/domain/workbench";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { AuthMiddlewareLive } from "./api-live.ts";
import { PersonSettingsGroupLive } from "./person-settings.ts";

const TOKENS: Readonly<Record<string, string>> = {
  "Bearer anna": "anna",
  "Bearer ben": "ben",
};
const PersonApi = HttpApi.make("mend").add(personSettingsGroup).prefix("/api");

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

/** Anna and Ben, each with their own switches and nothing else. */
const world = () => {
  const own = new Map<string, PersonSettings>();
  const defaults = new Map<string, SessionDefaults>();
  const changed: Array<string> = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(UserEvents, {
      changed: (userId, facet) => Effect.sync(() => changed.push(`${userId}:${facet}`)),
      leftOrganization: () => Effect.void,
    }),
    Layer.succeed(PersonSettingsRepo, {
      forUser: (userId) => Effect.sync(() => own.get(userId) ?? defaultPersonSettings),
      set: (userId, settings) =>
        Effect.sync(() => {
          own.set(userId, settings);
          return settings;
        }),
    }),
    Layer.succeed(SessionDefaultsRepo, {
      forUser: (userId) => Effect.sync(() => defaults.get(userId) ?? NO_SESSION_DEFAULTS),
      set: (userId, value) =>
        Effect.sync(() => {
          defaults.set(userId, value);
          return value;
        }),
      adopt: (userId, value) =>
        Effect.sync(() => {
          const adopted = !defaults.has(userId);
          if (adopted) defaults.set(userId, value);
          return { saved: defaults.get(userId) ?? value, adopted };
        }),
    }),
  );
  const call = async (
    as: string,
    method: "GET" | "PUT" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: unknown }> => {
    const apiLayer = HttpApiBuilder.layer(PersonApi).pipe(
      Layer.provide(PersonSettingsGroupLive),
      Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
      Layer.provide(HttpServer.layerServices),
    );
    const runtime = ManagedRuntime.make(dependencies);
    const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
    try {
      const context = await runtime.runPromise(
        Effect.context<Layer.Success<typeof dependencies>>(),
      );
      const response = await handler(
        new Request(`http://api.internal/api${path}`, {
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
  return { own, defaults, changed, call };
};

const DEFAULTS = {
  autoTour: true,
  autoSuggest: true,
  autoName: true,
  autoLand: false,
  backgroundSessions: true,
};

describe("/api/me/automation", () => {
  it("answers the caller's own switches, with effective the same for CLIs that read it", async () => {
    const { call } = world();
    const anna = await call("anna", "GET", "/me/automation");
    expect(anna.status).toBe(200);
    expect(anna.body).toEqual({ own: DEFAULTS, effective: DEFAULTS });
  });

  it("saves the caller's own switches only, answers them, and tells their screens", async () => {
    const { own, changed, call } = world();
    const chosen = { ...DEFAULTS, autoSuggest: false, autoLand: true };
    const written = await call("anna", "PUT", "/me/automation", chosen);
    expect(written.status).toBe(200);
    expect(written.body).toEqual({ own: chosen, effective: chosen });
    expect([...own.keys()]).toEqual(["anna"]);
    expect(changed).toEqual(["anna:accounts"]);
    expect((await call("ben", "GET", "/me/automation")).body).toEqual({
      own: DEFAULTS,
      effective: DEFAULTS,
    });
  });

  it("refuses an old client's Inherit with the reason, anything but true or false, and a caller who is not signed in", async () => {
    const { own, call } = world();
    const inherit = await call("anna", "PUT", "/me/automation", { ...DEFAULTS, autoLand: null });
    expect(inherit.status).toBe(400);
    expect(inherit.body).toMatchObject({
      _tag: "AutomationInheritRemoved",
      switches: ["autoLand"],
      message: expect.stringContaining("Inherit is gone"),
    });
    expect(
      (await call("anna", "PUT", "/me/automation", { ...DEFAULTS, autoLand: "yes" })).status,
    ).toBe(400);
    expect((await call("nobody", "GET", "/me/automation")).status).toBe(401);
    expect(own.size).toBe(0);
  });
});

describe("/api/me/session-defaults", () => {
  const LAPTOP = {
    harness: "codex",
    byHarness: { codex: { model: "gpt-6.1-sol", effort: "high" } },
  };

  it("keeps a browser's own defaults once, and saves Settings' changes for the caller only", async () => {
    const { defaults, changed, call } = world();
    expect((await call("anna", "GET", "/me/session-defaults")).body).toEqual({
      harness: null,
      byHarness: {},
    });
    expect((await call("anna", "POST", "/me/session-defaults/adopt", LAPTOP)).body).toEqual(LAPTOP);
    // Kept: the person's other open devices hear it. A second hand-over changes nothing.
    expect(changed).toEqual(["anna:accounts"]);
    expect(
      (await call("anna", "POST", "/me/session-defaults/adopt", { harness: "pi", byHarness: {} }))
        .body,
    ).toEqual(LAPTOP);
    expect(changed).toEqual(["anna:accounts"]);
    const chosen = { harness: "claude", byHarness: {} };
    expect((await call("anna", "PUT", "/me/session-defaults", chosen)).body).toEqual(chosen);
    expect([...defaults.keys()]).toEqual(["anna"]);
    expect((await call("ben", "GET", "/me/session-defaults")).body).toEqual({
      harness: null,
      byHarness: {},
    });
  });

  it("refuses an agent or effort Mend does not know", async () => {
    const { defaults, call } = world();
    expect(
      (await call("anna", "PUT", "/me/session-defaults", { harness: "vim", byHarness: {} })).status,
    ).toBe(400);
    expect(
      (
        await call("anna", "PUT", "/me/session-defaults", {
          harness: "codex",
          byHarness: { codex: { model: null, effort: "extreme" } },
        })
      ).status,
    ).toBe(400);
    expect(defaults.size).toBe(0);
  });
});
