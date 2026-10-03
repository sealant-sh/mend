import { SecretFileInvalidError } from "@mend/db";
import { SecretFileId } from "@mend/domain";
import { SecretFile } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";

const credentials = new SecretFile({
  id: SecretFileId.make("sf-1"),
  path: ".aws/credentials",
  name: "credentials",
  bytes: 116,
  revision: 2,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

/**
 * A secret file is only ever the signed-in account's own, and its content is write-only: the
 * handler seals it and the sealed form is all the repo ever receives.
 */
describe("secret files", () => {
  let api: TenancyApi;
  const asked: Array<string> = [];
  const sealed: Array<string> = [];
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        cipher: {
          encrypt: (plaintext) =>
            Effect.sync(() => {
              sealed.push(plaintext);
              return `sealed:${plaintext.length}`;
            }),
        },
        secretFiles: {
          list: (userId) =>
            Effect.sync(() => {
              asked.push(`list:${userId}`);
              return userId === "carol" ? [credentials] : [];
            }),
          save: (userId, input) =>
            Effect.suspend(() => {
              asked.push(`save:${userId}:${input.path}:${input.bytes}:${input.sealedContents}`);
              return input.path === "full/of/files"
                ? Effect.fail(
                    new SecretFileInvalidError({
                      message: "you already keep 64 secret files, the most Mend holds per person",
                    }),
                  )
                : Effect.succeed({
                    file: new SecretFile({ ...credentials, path: input.path, name: "x" }),
                    action: "created" as const,
                  });
            }),
          remove: (userId, path) =>
            Effect.sync(() => {
              asked.push(`remove:${userId}:${path}`);
              return userId === "carol";
            }),
        },
      },
    });
  });
  afterAll(async () => {
    await api.dispose();
  });

  it("lists, saves and removes the signed-in account's files, and only those", async () => {
    const mine = await api.request("carol", "GET", "/api/me/secret-files");
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({
      files: [{ path: ".aws/credentials", name: "credentials", bytes: 116, revision: 2 }],
    });
    const none = await api.request("bob", "GET", "/api/me/secret-files");
    expect(await none.json()).toEqual({ files: [] });

    const saved = await api.request("bob", "PUT", "/api/me/secret-files", {
      path: ".npmrc",
      encoding: "utf8",
      contents: "//registry.npmjs.org/:_authToken=abc\n",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ action: "created", file: { path: ".npmrc" } });
    const removed = await api.request("bob", "DELETE", "/api/me/secret-files?path=.npmrc");
    expect(await removed.json()).toEqual({ removed: false });
    const mineRemoved = await api.request(
      "carol",
      "DELETE",
      "/api/me/secret-files?path=.aws%2Fcredentials",
    );
    expect(await mineRemoved.json()).toEqual({ removed: true });
    // The repo received the sealed form of the base64 content, never the content.
    const plaintext = Buffer.from("//registry.npmjs.org/:_authToken=abc\n").toString("base64");
    expect(sealed).toEqual([plaintext]);
    expect(asked).toEqual([
      "list:carol",
      "list:bob",
      `save:bob:.npmrc:37:sealed:${plaintext.length}`,
      "remove:bob:.npmrc",
      "remove:carol:.aws/credentials",
    ]);
  });

  it("never returns a file's content in any shape", async () => {
    const mine = await api.request("carol", "GET", "/api/me/secret-files");
    const body = JSON.stringify(await mine.json());
    expect(body).not.toContain("contents");
    expect(body).not.toContain("sealed");
  });

  it("answers a path under a captured directory with 422 before sealing anything", async () => {
    const before = sealed.length;
    const refused = await api.request("bob", "PUT", "/api/me/secret-files", {
      path: ".claude/settings.json",
      encoding: "utf8",
      contents: "{}",
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      message: ".claude/settings.json is under .claude, which sessions capture",
    });
    const escaping = await api.request("bob", "PUT", "/api/me/secret-files", {
      path: "../etc/passwd",
      encoding: "utf8",
      contents: "x",
    });
    expect(escaping.status).toBe(422);
    const empty = await api.request("bob", "PUT", "/api/me/secret-files", {
      path: ".npmrc",
      encoding: "utf8",
      contents: "",
    });
    expect(empty.status).toBe(422);
    expect(await empty.json()).toMatchObject({ message: "the file is empty" });
    expect(sealed.length).toBe(before);
  });

  it("answers a limit the repo refuses with 422 and the reason", async () => {
    const refused = await api.request("bob", "PUT", "/api/me/secret-files", {
      path: "full/of/files",
      encoding: "utf8",
      contents: "x",
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      message: "you already keep 64 secret files, the most Mend holds per person",
    });
  });

  it("asks for a signed-in account", async () => {
    expect((await api.request(null, "GET", "/api/me/secret-files")).status).toBe(401);
  });
});
