import {
  SavedLayoutLimitError,
  SavedLayoutNameTakenError,
  SavedLayoutNotFoundError,
} from "@mend/db";
import { SavedLayoutId } from "@mend/domain";
import { SavedLayout, TileLayout } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";

const conversationOnly = {
  version: 1,
  root: { kind: "tile", tabs: [{ kind: "session" }], active: 0 },
  focus: 0,
};

const saved = (name: string) =>
  new SavedLayout({
    id: SavedLayoutId.make("layout-1"),
    name,
    layout: Schema.decodeUnknownSync(TileLayout)(conversationOnly),
    createdAt: new Date("2026-11-19T08:00:00Z"),
    updatedAt: new Date("2026-11-19T08:00:00Z"),
  });

/**
 * A saved layout is only ever the signed-in account's, a layout the schema doesn't know never
 * reaches the store, and the store's refusals answer with a status and a sentence to show.
 */
describe("saved layouts", () => {
  let api: TenancyApi;
  const asked: Array<string> = [];
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        savedLayouts: {
          list: (userId) =>
            Effect.sync(() => {
              asked.push(`list:${userId}`);
              return userId === "carol" ? [saved("Review with terminal")] : [];
            }),
          save: (userId, input) =>
            Effect.suspend(() => {
              asked.push(`save:${userId}:${input.name}`);
              if (input.name === "Taken") {
                return Effect.fail(new SavedLayoutNameTakenError({ name: input.name }));
              }
              if (input.name === "One too many") {
                return Effect.fail(new SavedLayoutLimitError({ limit: 20 }));
              }
              return Effect.succeed(saved(input.name));
            }),
          rename: (userId, id, name) =>
            Effect.suspend(() => {
              asked.push(`rename:${userId}:${id}:${name}`);
              return id === "layout-1" && userId === "carol"
                ? Effect.succeed(saved(name))
                : Effect.fail(new SavedLayoutNotFoundError({ id }));
            }),
          remove: (userId, id) =>
            Effect.sync(() => {
              asked.push(`remove:${userId}:${id}`);
              return userId === "carol";
            }),
        },
      },
    });
  });
  afterAll(async () => {
    await api.dispose();
  });

  it("lists, saves, renames and removes for the signed-in account only", async () => {
    asked.length = 0;
    const mine = await api.request("carol", "GET", "/api/me/layouts");
    expect(await mine.json()).toMatchObject({
      layouts: [{ id: "layout-1", name: "Review with terminal", layout: conversationOnly }],
    });
    const created = await api.request("bob", "POST", "/api/me/layouts", {
      name: "Just talk",
      layout: conversationOnly,
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ name: "Just talk", layout: conversationOnly });
    const renamed = await api.request("carol", "PATCH", "/api/me/layouts/layout-1", {
      name: "Wide review",
    });
    expect(await renamed.json()).toMatchObject({ id: "layout-1", name: "Wide review" });
    const removed = await api.request("carol", "DELETE", "/api/me/layouts/layout-1");
    expect(await removed.json()).toEqual({ removed: true });
    expect(asked).toEqual([
      "list:carol",
      "save:bob:Just talk",
      "rename:carol:layout-1:Wide review",
      "remove:carol:layout-1",
    ]);
  });

  it.each([
    ["a version it doesn't know", { name: "Later", layout: { ...conversationOnly, version: 2 } }],
    [
      "a particular session",
      {
        name: "Mine",
        layout: {
          ...conversationOnly,
          root: { kind: "tile", tabs: [{ kind: "session", sessionId: "s-1" }], active: 0 },
        },
      },
    ],
    ["a name with spaces at its ends", { name: " Review ", layout: conversationOnly }],
  ])("refuses a layout with %s with 400, and stores nothing", async (_, body) => {
    asked.length = 0;
    const refused = await api.request("bob", "POST", "/api/me/layouts", body);
    expect(refused.status).toBe(400);
    expect(asked).toEqual([]);
  });

  it("answers a name already used and the limit with 409, and a missing layout with 404", async () => {
    const taken = await api.request("bob", "POST", "/api/me/layouts", {
      name: "Taken",
      layout: conversationOnly,
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ _tag: "SavedLayoutNameTaken", name: "Taken" });
    const full = await api.request("bob", "POST", "/api/me/layouts", {
      name: "One too many",
      layout: conversationOnly,
    });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ _tag: "SavedLayoutLimitReached", limit: 20 });
    const someoneElses = await api.request("bob", "PATCH", "/api/me/layouts/layout-1", {
      name: "Mine now",
    });
    expect(someoneElses.status).toBe(404);
    expect(await someoneElses.json()).toMatchObject({ _tag: "SavedLayoutNotFound" });
  });

  it("asks for a signed-in account", async () => {
    expect((await api.request(null, "GET", "/api/me/layouts")).status).toBe(401);
  });
});
