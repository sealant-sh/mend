import { McpServerInvalidError, type McpServerSave } from "@mend/db";
import { McpServerId } from "@mend/domain";
import { MCP_SERVER_LIMITS, McpServer, secretKindOf } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { accessKeyBearerOf } from "../../test/support/tenancy-harness.ts";

const TOKEN = "ghp-synthetic-0123456789";
const REPLACED = "ghp-synthetic-replaced";
const HEADER = "Bearer lin-synthetic-0123456789";

const keyOf = (userId: string, name: string) => `${userId}/${name}`;
const github = (secrets?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  transport: {
    _tag: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  },
  ...(secrets === undefined ? {} : { secrets }),
  ...extra,
});

describe("MCP servers", () => {
  let api: TenancyApi;
  const rows = new Map<string, { server: McpServer; sealed: string | null }>();
  const stored: Array<string> = [];

  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        cipher: {
          encrypt: (plaintext) =>
            Effect.succeed(`sealed:${Buffer.from(plaintext).toString("base64")}`),
          decrypt: (sealed) =>
            Effect.succeed(Buffer.from(sealed.slice("sealed:".length), "base64").toString()),
        },
        mcpServers: {
          list: (userId) =>
            Effect.sync(() =>
              [...rows.entries()]
                .filter(([key]) => key.startsWith(`${userId}/`))
                .map(([, row]) => row.server),
            ),
          sealedSecretsOf: (userId, name) =>
            Effect.sync(() => {
              const row = rows.get(keyOf(userId, name));
              return row === undefined
                ? null
                : { kind: secretKindOf(row.server.transport), sealed: row.sealed };
            }),
          save: (userId, input: McpServerSave) =>
            Effect.suspend(() => {
              if (input.sealedSecrets !== null) stored.push(input.sealedSecrets);
              const current = rows.get(keyOf(userId, input.name));
              const mine = [...rows.keys()].filter((key) => key.startsWith(`${userId}/`));
              if (current === undefined && mine.length >= MCP_SERVER_LIMITS.servers) {
                return Effect.fail(
                  new McpServerInvalidError({
                    message: `you already keep ${MCP_SERVER_LIMITS.servers} MCP servers, the most Mend holds per person`,
                  }),
                );
              }
              const server = new McpServer({
                id: current?.server.id ?? McpServerId.make(`mcp-${userId}-${input.name}`),
                scope: "person",
                name: input.name,
                transport: input.transport,
                secretNames: input.secretNames,
                enabled: input.enabled ?? current?.server.enabled ?? true,
                createdAt: new Date(0),
                updatedAt: new Date(0),
              });
              rows.set(keyOf(userId, input.name), { server, sealed: input.sealedSecrets });
              return Effect.succeed(server);
            }),
          remove: (userId, name) => Effect.sync(() => rows.delete(keyOf(userId, name))),
        },
      },
    });
  });
  beforeEach(() => {
    rows.clear();
    stored.length = 0;
  });
  afterAll(async () => {
    await api.dispose();
  });

  const put = (user: "carol" | "bob", name: string, body: unknown) =>
    api.request(user, "PUT", `/api/me/mcp-servers/${name}`, body);
  const savedSecrets = (user: string, name: string) => {
    const sealed = rows.get(keyOf(user, name))?.sealed ?? null;
    return sealed === null
      ? {}
      : JSON.parse(Buffer.from(sealed.slice("sealed:".length), "base64").toString());
  };

  it("saves a server and never answers with a secret value", async () => {
    const created = await put(
      "carol",
      "github",
      github({ GITHUB_TOKEN: { _tag: "Set", value: TOKEN } }),
    );
    expect(created.status).toBe(200);
    const createdBody = await created.text();
    expect(JSON.parse(createdBody)).toMatchObject({
      name: "github",
      scope: "person",
      enabled: true,
      secretNames: ["GITHUB_TOKEN"],
      transport: { _tag: "stdio", command: "npx" },
    });
    const linear = await put("carol", "linear", {
      transport: { _tag: "http", url: "https://mcp.linear.app/mcp" },
      secrets: { Authorization: { _tag: "Set", value: HEADER } },
    });
    expect(linear.status).toBe(200);
    const listed = await api.request("carol", "GET", "/api/me/mcp-servers");
    const listedBody = await listed.text();
    expect(JSON.parse(listedBody)).toMatchObject({
      servers: [{ name: "github" }, { name: "linear", secretNames: ["Authorization"] }],
      limits: { servers: 16, secretsPerServer: 16 },
    });
    for (const body of [createdBody, listedBody, await linear.text()]) {
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(HEADER);
      expect(body).not.toContain("sealed");
    }
    expect(stored.join("\n")).not.toContain(TOKEN);
    expect(savedSecrets("carol", "github")).toEqual({ GITHUB_TOKEN: TOKEN });
  });

  it("keeps a Keep, replaces a Set, removes a name left out, and keeps all when secrets is absent", async () => {
    await put(
      "carol",
      "github",
      github({
        GITHUB_TOKEN: { _tag: "Set", value: TOKEN },
        GITHUB_HOST: { _tag: "Set", value: "github.example.com" },
        OLD: { _tag: "Set", value: "old" },
      }),
    );
    const edited = await put(
      "carol",
      "github",
      github({
        GITHUB_TOKEN: { _tag: "Keep" },
        GITHUB_HOST: { _tag: "Set", value: REPLACED },
      }),
    );
    expect(await edited.json()).toMatchObject({ secretNames: ["GITHUB_HOST", "GITHUB_TOKEN"] });
    expect(savedSecrets("carol", "github")).toEqual({ GITHUB_TOKEN: TOKEN, GITHUB_HOST: REPLACED });

    const toggled = await put("carol", "github", github(undefined, { enabled: false }));
    expect(await toggled.json()).toMatchObject({
      enabled: false,
      secretNames: ["GITHUB_HOST", "GITHUB_TOKEN"],
    });
    expect(savedSecrets("carol", "github")).toEqual({ GITHUB_TOKEN: TOKEN, GITHUB_HOST: REPLACED });
    const unnamed = await put("carol", "github", github());
    expect(await unnamed.json()).toMatchObject({ enabled: false });
  });

  it("answers a Keep of a name with no saved value with 422", async () => {
    await put("carol", "github", github({ GITHUB_TOKEN: { _tag: "Set", value: TOKEN } }));
    const refused = await put("carol", "github", github({ OTHER: { _tag: "Keep" } }));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({
      _tag: "McpServerRejected",
      message: "Keep names a secret this server does not have",
    });
    expect(savedSecrets("carol", "github")).toEqual({ GITHUB_TOKEN: TOKEN });
  });

  it("starts from no secrets when a server moves between stdio and HTTP", async () => {
    await put("carol", "tools", github({ API_KEY: { _tag: "Set", value: TOKEN } }));
    const moved = await put("carol", "tools", {
      transport: { _tag: "http", url: "https://tools.example.com/mcp" },
    });
    expect(await moved.json()).toMatchObject({ transport: { _tag: "http" }, secretNames: [] });
    expect(savedSecrets("carol", "tools")).toEqual({});
    const kept = await put("carol", "tools", {
      transport: { _tag: "stdio", command: "tools", args: [] },
      secrets: { API_KEY: { _tag: "Keep" } },
    });
    expect(kept.status).toBe(422);
  });

  it("answers Mend's names, a bad URL and a bad secret with 422 that quotes nothing sent", async () => {
    for (const name of ["mend", "executor", "mend-tools", "Figma"]) {
      const refused = await put("carol", name, github());
      expect(refused.status).toBe(422);
    }
    const userinfo = await put("carol", "figma", {
      transport: { _tag: "http", url: "https://alice:hunter2-secret@mcp.figma.com/mcp" },
    });
    const scheme = await put("carol", "figma", {
      transport: { _tag: "sse", url: "ftp://mcp.example.com/hunter2-secret" },
    });
    const headerValue = await put("carol", "figma", {
      transport: { _tag: "http", url: "https://mcp.figma.com/mcp" },
      secrets: { Authorization: { _tag: "Set", value: "Bearer hunter2-secret\r\nX-Evil: 1" } },
    });
    const envName = await put(
      "carol",
      "github",
      github({
        "Authorization: Bearer hunter2-secret": { _tag: "Set", value: "x" },
      }),
    );
    for (const response of [userinfo, scheme, headerValue, envName]) {
      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain("hunter2");
    }
    expect(rows.size).toBe(0);
  });

  it("answers the per-person and per-server limits with 422", async () => {
    for (let i = 0; i < MCP_SERVER_LIMITS.servers; i++) {
      expect((await put("bob", `server-${i}`, github())).status).toBe(200);
    }
    const over = await put("bob", "one-more", github());
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({
      message: "you already keep 16 MCP servers, the most Mend holds per person",
    });
    const tooMany = Object.fromEntries(
      Array.from({ length: MCP_SERVER_LIMITS.secretsPerServer + 1 }, (_, i) => [
        `V${i}`,
        { _tag: "Set", value: "x" },
      ]),
    );
    expect((await put("bob", "server-0", github(tooMany))).status).toBe(422);
  });

  it("keeps one person's servers from another's list, change and removal", async () => {
    await put("carol", "github", github({ GITHUB_TOKEN: { _tag: "Set", value: TOKEN } }));
    expect(await (await api.request("bob", "GET", "/api/me/mcp-servers")).json()).toMatchObject({
      servers: [],
    });
    const removed = await api.request("bob", "DELETE", "/api/me/mcp-servers/github");
    expect(await removed.json()).toEqual({ removed: false });
    const keep = await put("bob", "github", github({ GITHUB_TOKEN: { _tag: "Keep" } }));
    expect(keep.status).toBe(422);
    expect(savedSecrets("carol", "github")).toEqual({ GITHUB_TOKEN: TOKEN });

    const mine = await api.request("carol", "DELETE", "/api/me/mcp-servers/github");
    expect(await mine.json()).toEqual({ removed: true });
    const again = await api.request("carol", "DELETE", "/api/me/mcp-servers/github");
    expect(await again.json()).toEqual({ removed: false });
  });

  it("refuses an access key on every endpoint before reading or writing anything", async () => {
    const headers = { authorization: `Bearer ${accessKeyBearerOf("carol")}` };
    const calls = [
      api.request(null, "GET", "/api/me/mcp-servers", undefined, headers),
      api.request(null, "PUT", "/api/me/mcp-servers/github", github(), headers),
      api.request(null, "DELETE", "/api/me/mcp-servers/github", undefined, headers),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ _tag: "AccessKeyRefused" });
    }
    expect(rows.size).toBe(0);
  });

  it("asks for a signed-in account", async () => {
    expect((await api.request(null, "GET", "/api/me/mcp-servers")).status).toBe(401);
  });
});
