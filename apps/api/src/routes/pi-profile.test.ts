import { PiProfileInvalidError } from "@mend/db";
import { PiProfile } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";

const profile = new PiProfile({
  fileCount: 1,
  bytes: 2,
  extensions: [],
  packages: ["npm:pi-web-access@0.23.0"],
  digest: "d1",
  revision: 3,
  updatedAt: new Date(0),
});

/** A pi profile is only ever the signed-in account's own: no route names anyone else's. */
describe("pi profile", () => {
  let api: TenancyApi;
  const asked: Array<string> = [];
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        piProfiles: {
          forUser: (userId) =>
            Effect.sync(() => {
              asked.push(`get:${userId}`);
              return userId === "carol" ? { profile, files: [] } : null;
            }),
          save: (userId, files) =>
            Effect.suspend(() => {
              asked.push(`save:${userId}:${files.length}`);
              return files.some((file) => file.path === "auth.json")
                ? Effect.fail(
                    new PiProfileInvalidError({ message: "auth.json is not part of a pi profile" }),
                  )
                : Effect.succeed({ profile, changed: true });
            }),
          remove: (userId) =>
            Effect.sync(() => {
              asked.push(`remove:${userId}`);
              return false;
            }),
        },
      },
    });
  });
  afterAll(async () => {
    await api.dispose();
  });

  it("reads, saves and removes the signed-in account's profile, and only that", async () => {
    const mine = await api.request("carol", "GET", "/api/me/pi-profile");
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ profile: { revision: 3, digest: "d1" } });
    const none = await api.request("bob", "GET", "/api/me/pi-profile");
    expect(await none.json()).toEqual({ profile: null });

    const saved = await api.request("bob", "PUT", "/api/me/pi-profile", {
      files: [{ path: "settings.json", encoding: "utf8", contents: "{}" }],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ changed: true });
    const removed = await api.request("bob", "DELETE", "/api/me/pi-profile");
    expect(await removed.json()).toEqual({ removed: false });
    expect(asked).toEqual(["get:carol", "get:bob", "save:bob:1", "remove:bob"]);
  });

  it("answers a profile the repo refuses with 422 and the reason", async () => {
    const refused = await api.request("bob", "PUT", "/api/me/pi-profile", {
      files: [{ path: "auth.json", encoding: "utf8", contents: "{}" }],
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      message: "auth.json is not part of a pi profile",
    });
  });

  it("asks for a signed-in account", async () => {
    expect((await api.request(null, "GET", "/api/me/pi-profile")).status).toBe(401);
  });
});
