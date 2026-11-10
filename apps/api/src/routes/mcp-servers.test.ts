import { McpServerInvalidError, type McpServerSave, type SavedMcpServer } from "@mend/db";
import { McpServerId } from "@mend/domain";
import { MCP_SERVER_LIMITS, McpServer, McpServerName, McpServerUrl } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { accessKeyBearerOf } from "../../test/support/tenancy-harness.ts";

const TOKEN = "ghp-synthetic-0123456789";
const REPLACED = "ghp-synthetic-replaced";
const HEADER = "Bearer lin-synthetic-0123456789";
const KEYED_URL = "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-FAKEKEY-mcpcheck";
const SHOWN_URL = "https://mcp.tavily.com/mcp/?tavilyApiKey=…";

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

const unseal = (sealed: string) => Buffer.from(sealed.slice("sealed:".length), "base64").toString();
const tavily = (url: string, extra: Record<string, unknown> = {}) => ({
  transport: { _tag: "http", url },
  ...extra,
});

describe("MCP servers", () => {
  let api: TenancyApi;
  const rows = new Map<string, { server: McpServer; saved: SavedMcpServer }>();
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
          savedOf: (userId, name) =>
            Effect.sync(() => rows.get(keyOf(userId, name))?.saved ?? null),
          forLaunch: (userId) =>
            Effect.sync(() =>
              [...rows.entries()]
                .filter(([key]) => key.startsWith(`${userId}/`))
                .map(([, row]) => ({
                  id: row.server.id,
                  name: row.server.name,
                  ...row.saved,
                  signIn: null,
                  signInResetAt: null,
                })),
            ),
          save: (userId, input: McpServerSave) =>
            Effect.suspend(() => {
              for (const sealed of [input.sealedSecrets, input.sealedUrl]) {
                if (sealed !== null) stored.push(sealed);
              }
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
                signIn: current?.server.signIn ?? null,
                createdAt: new Date(0),
                updatedAt: new Date(0),
              });
              rows.set(keyOf(userId, input.name), {
                server,
                saved: {
                  transport: input.transport,
                  sealedUrl: input.sealedUrl,
                  sealedSecrets: input.sealedSecrets,
                },
              });
              return Effect.succeed(server);
            }),
          remove: (userId, name) => Effect.sync(() => rows.delete(keyOf(userId, name))),
          forgetSignIn: (userId, name) =>
            Effect.sync(() => {
              const row = rows.get(keyOf(userId, name));
              if (row === undefined) return null;
              const server = new McpServer({ ...row.server, signIn: null });
              rows.set(keyOf(userId, name), { ...row, server });
              return server;
            }),
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
    const sealed = rows.get(keyOf(user, name))?.saved.sealedSecrets ?? null;
    return sealed === null ? {} : JSON.parse(unseal(sealed));
  };
  /** The URL a launch gets: `forLaunch`'s sealed full URL unsealed, else the URL as kept. */
  const launchUrl = (user: string, name: string) => {
    const saved = rows.get(keyOf(user, name))?.saved;
    if (saved === undefined || saved.transport._tag === "stdio") return null;
    return saved.sealedUrl === null ? saved.transport.url : unseal(saved.sealedUrl);
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

  it("seals a URL that may carry a key and answers only with its shown form", async () => {
    const created = await put("carol", "tavily", tavily(KEYED_URL));
    const createdBody = await created.text();
    expect(created.status).toBe(200);
    expect(JSON.parse(createdBody)).toMatchObject({ transport: { _tag: "http", url: SHOWN_URL } });
    const listedBody = await (await api.request("carol", "GET", "/api/me/mcp-servers")).text();
    const switched = await put("carol", "tavily", tavily(SHOWN_URL, { enabled: false }));
    for (const body of [createdBody, listedBody, await switched.text()]) {
      expect(body).not.toContain("FAKEKEY");
      expect(body).not.toContain("sealed");
    }
    expect(stored.join("\n")).not.toContain("FAKEKEY");
    expect(rows.get(keyOf("carol", "tavily"))?.saved.transport).toEqual({
      _tag: "http",
      url: SHOWN_URL,
    });
    expect(launchUrl("carol", "tavily")).toBe(KEYED_URL);
    const refused = await put(
      "carol",
      "tavily",
      tavily(`${KEYED_URL}x`, {
        secrets: { Authorization: { _tag: "Set", value: "Bearer x\r\nX-Evil: 1" } },
      }),
    );
    expect(refused.status).toBe(422);
    expect(await refused.text()).not.toContain("FAKEKEY");
  });

  it("keeps the full URL for an edit that resends the shown one, as HTTP or SSE", async () => {
    await put("carol", "tavily", tavily(KEYED_URL));
    await put("carol", "tavily", tavily(SHOWN_URL));
    expect(launchUrl("carol", "tavily")).toBe(KEYED_URL);
    await put("carol", "tavily", { transport: { _tag: "sse", url: SHOWN_URL } });
    expect(launchUrl("carol", "tavily")).toBe(KEYED_URL);

    const replacedUrl = "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-REPLACED-0123";
    const replaced = await put("carol", "tavily", tavily(replacedUrl));
    expect(await replaced.json()).toMatchObject({ transport: { url: SHOWN_URL } });
    expect(launchUrl("carol", "tavily")).toBe(replacedUrl);
    await put("carol", "tavily", tavily("https://mcp.tavily.com/mcp"));
    expect(rows.get(keyOf("carol", "tavily"))?.saved).toMatchObject({ sealedUrl: null });
    expect(launchUrl("carol", "tavily")).toBe("https://mcp.tavily.com/mcp");
  });

  it("seals the full URL of a server saved before URLs were sealed on its next save", async () => {
    const id = McpServerId.make("mcp-carol-plain");
    const url = McpServerUrl.make(KEYED_URL);
    rows.set(keyOf("carol", "plain"), {
      server: new McpServer({
        id,
        scope: "person",
        name: McpServerName.make("plain"),
        transport: { _tag: "http", url },
        secretNames: [],
        enabled: true,
        signIn: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      saved: { transport: { _tag: "http", url }, sealedUrl: null, sealedSecrets: null },
    });
    const resaved = await put("carol", "plain", tavily(SHOWN_URL));
    expect(await resaved.text()).not.toContain("FAKEKEY");
    expect(rows.get(keyOf("carol", "plain"))?.saved.transport).toEqual({
      _tag: "http",
      url: SHOWN_URL,
    });
    expect(launchUrl("carol", "plain")).toBe(KEYED_URL);
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
      github({ GITHUB_TOKEN: { _tag: "Keep" }, GITHUB_HOST: { _tag: "Set", value: REPLACED } }),
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
      github({ "Authorization: Bearer hunter2-secret": { _tag: "Set", value: "x" } }),
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

  it("forgets a kept sign-in, and answers 404 for a server the caller does not keep", async () => {
    await put("carol", "figma", { transport: { _tag: "http", url: "https://mcp.figma.com/mcp" } });
    const row = rows.get(keyOf("carol", "figma"));
    if (row === undefined) throw new Error("figma was not saved");
    const signIn = { observedAt: new Date(1_000), expiresAt: new Date(2_000) };
    rows.set(keyOf("carol", "figma"), { ...row, server: new McpServer({ ...row.server, signIn }) });
    const listed = await (await api.request("carol", "GET", "/api/me/mcp-servers")).json();
    expect(listed).toMatchObject({
      servers: [{ name: "figma", signIn: { observedAt: "1970-01-01T00:00:01.000Z" } }],
    });

    const forgotten = await api.request("carol", "DELETE", "/api/me/mcp-servers/figma/sign-in");
    expect(forgotten.status).toBe(200);
    expect(await forgotten.json()).toMatchObject({ name: "figma", signIn: null });
    const others = await api.request("bob", "DELETE", "/api/me/mcp-servers/figma/sign-in");
    expect(others.status).toBe(404);
    expect(await others.json()).toMatchObject({ _tag: "McpServerNotFound" });
  });

  it("refuses an access key on every endpoint before reading or writing anything", async () => {
    const headers = { authorization: `Bearer ${accessKeyBearerOf("carol")}` };
    const calls = [
      api.request(null, "GET", "/api/me/mcp-servers", undefined, headers),
      api.request(null, "PUT", "/api/me/mcp-servers/github", github(), headers),
      api.request(null, "DELETE", "/api/me/mcp-servers/github", undefined, headers),
      api.request(null, "DELETE", "/api/me/mcp-servers/github/sign-in", undefined, headers),
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
