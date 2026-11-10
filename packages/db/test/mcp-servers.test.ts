import { PgClient } from "@effect/sql-pg";
import { MCP_SERVER_LIMITS, McpServerName, McpServerUrl } from "@mend/domain/workbench";
import { Effect, Exit, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  McpServersRepo,
  McpServersRepoLive,
  type McpServerSave,
  type McpSignInObserved,
} from "../src/repos/mcp-servers.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_mcp_servers_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = McpServersRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, McpServersRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));
const exit = <A, E>(effect: Effect.Effect<A, E, McpServersRepo | SqlClient.SqlClient>) =>
  run(Effect.exit(effect));

const name = McpServerName.make;
const at = (iso: string) => new Date(iso);
const figma: McpServerSave = {
  name: name("figma"),
  transport: { _tag: "http", url: McpServerUrl.make("https://mcp.figma.com/mcp") },
  sealedUrl: null,
  secretNames: [],
  sealedSecrets: null,
};
const github: McpServerSave = {
  name: name("github"),
  transport: { _tag: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  sealedUrl: null,
  secretNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
  sealedSecrets: "v1.sealed-github",
};
const KEYED_URL = "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-FAKEKEY-0123456789";
const SHOWN_URL = "https://mcp.tavily.com/mcp/?tavilyApiKey=…";

describe.skipIf(postgres.skip)("MCP servers, in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES
            ('anna', 'Anna Example', 'anna@example.com', '2026-01-01T00:00:00Z'),
            ('ben', 'Ben Example', 'ben@example.com', '2026-01-01T00:00:00Z'),
            ('cleo', 'Cleo Example', 'cleo@example.com', '2026-01-01T00:00:00Z'),
            ('dana', 'Dana Example', 'dana@example.com', '2026-01-01T00:00:00Z')`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("creates by name, replaces under the same name, and lists names without values", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* McpServersRepo;
        const created = yield* repo.save("anna", github);
        yield* repo.save("anna", figma);
        const replaced = yield* repo.save("anna", {
          ...github,
          secretNames: [],
          sealedSecrets: null,
          enabled: false,
        });
        return { created, replaced, listed: yield* repo.list("anna") };
      }),
    );
    expect(result.replaced.id).toBe(result.created.id);
    expect(
      result.listed.map((server) => [server.name, server.enabled, server.secretNames]),
    ).toEqual([
      ["figma", true, []],
      ["github", false, []],
    ]);
    expect(JSON.stringify(result.listed)).not.toContain("sealed");
  });

  it("gives the launch only the servers that are on, with their sealed secrets", async () => {
    const launch = await run(
      Effect.gen(function* () {
        const repo = yield* McpServersRepo;
        yield* repo.save("ben", github);
        yield* repo.save("ben", { ...figma, enabled: false });
        return {
          launch: yield* repo.forLaunch("ben"),
          secrets: yield* repo.savedOf("ben", name("github")),
          missing: yield* repo.savedOf("ben", name("nothing")),
          othersSecrets: yield* repo.savedOf("cleo", name("github")),
        };
      }),
    );
    expect(launch.launch).toEqual([
      expect.objectContaining({ name: "github", sealedSecrets: "v1.sealed-github" }),
    ]);
    expect(launch.secrets).toEqual({
      transport: github.transport,
      sealedUrl: null,
      sealedSecrets: "v1.sealed-github",
    });
    expect(launch.missing).toBeNull();
    expect(launch.othersSecrets).toBeNull();
  });

  it("keeps a sealed URL beside the shown one, and gives it only to the launch", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* McpServersRepo;
        const saved = yield* repo.save("anna", {
          ...figma,
          name: name("tavily"),
          transport: { _tag: "http", url: McpServerUrl.make(SHOWN_URL) },
          sealedUrl: "v1.sealed-url",
        });
        const read = {
          saved,
          listed: yield* repo.list("anna"),
          savedOf: yield* repo.savedOf("anna", name("tavily")),
          launch: yield* repo.forLaunch("anna"),
        };
        yield* repo.remove("anna", "tavily");
        return read;
      }),
    );
    expect(result.saved.transport).toEqual({ _tag: "http", url: SHOWN_URL });
    expect(result.listed.find((server) => server.name === "tavily")?.transport).toEqual({
      _tag: "http",
      url: SHOWN_URL,
    });
    expect(JSON.stringify([result.saved, result.listed])).not.toContain("sealed");
    expect(result.savedOf).toMatchObject({ sealedUrl: "v1.sealed-url" });
    expect(result.launch.find((server) => server.name === "tavily")).toMatchObject({
      transport: { _tag: "http", url: SHOWN_URL },
      sealedUrl: "v1.sealed-url",
    });
  });

  it("shows a URL saved before URLs were sealed with its key hidden, and launches it whole", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const transport = JSON.stringify({ _tag: "http", url: KEYED_URL });
        yield* sql`
          INSERT INTO mcp_servers (id, scope, user_id, name, transport)
          VALUES ('mcp-plain', 'person', 'anna', 'plain', ${transport}::jsonb)`;
        const repo = yield* McpServersRepo;
        const read = { listed: yield* repo.list("anna"), launch: yield* repo.forLaunch("anna") };
        yield* repo.remove("anna", "plain");
        return read;
      }),
    );
    expect(JSON.stringify(result.listed)).not.toContain("FAKEKEY");
    expect(result.listed.find((server) => server.name === "plain")?.transport).toEqual({
      _tag: "http",
      url: SHOWN_URL,
    });
    expect(result.launch.find((server) => server.name === "plain")).toMatchObject({
      transport: { _tag: "http", url: KEYED_URL },
      sealedUrl: null,
    });
  });

  it("keeps a saved server's on or off state when a replace does not name it", async () => {
    const replaced = await run(
      Effect.gen(function* () {
        const repo = yield* McpServersRepo;
        yield* repo.save("cleo", { ...figma, name: name("kept-off"), enabled: false });
        yield* repo.save("cleo", { ...figma, name: name("kept-off"), secretNames: ["X"] });
        const listed = yield* repo.list("cleo");
        yield* repo.remove("cleo", "kept-off");
        return listed;
      }),
    );
    expect(replaced.map((server) => [server.name, server.enabled, server.secretNames])).toEqual([
      ["kept-off", false, ["X"]],
    ]);
  });

  it("keeps one person's servers from another's list, launch and removal", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* McpServersRepo;
        yield* repo.save("cleo", { ...figma, name: name("cleo-only") });
        return {
          othersRemove: yield* repo.remove("anna", "cleo-only"),
          annaList: (yield* repo.list("anna")).map((server) => server.name),
          cleoList: (yield* repo.list("cleo")).map((server) => server.name),
          remove: yield* repo.remove("cleo", "cleo-only"),
          again: yield* repo.remove("cleo", "cleo-only"),
          launch: yield* repo.forLaunch("cleo"),
        };
      }),
    );
    expect(result).toEqual({
      othersRemove: false,
      annaList: ["figma", "github"],
      cleoList: ["cleo-only"],
      remove: true,
      again: false,
      launch: [],
    });
  });

  it("holds the server limit under concurrent saves, and refuses oversized secrets", async () => {
    const saves = Array.from({ length: MCP_SERVER_LIMITS.servers + 4 }, (_, i) =>
      Effect.flatMap(McpServersRepo, (repo) =>
        Effect.exit(repo.save("cleo", { ...figma, name: name(`server-${i}`) })),
      ),
    );
    const exits = await run(Effect.all(saves, { concurrency: "unbounded" }));
    expect(exits.filter(Exit.isSuccess)).toHaveLength(MCP_SERVER_LIMITS.servers);
    expect(await run(Effect.flatMap(McpServersRepo, (repo) => repo.list("cleo")))).toHaveLength(
      MCP_SERVER_LIMITS.servers,
    );
    const replace = await exit(
      Effect.flatMap(McpServersRepo, (repo) =>
        repo.save("cleo", { ...figma, name: name("server-0"), enabled: false }),
      ),
    );
    expect(Exit.isSuccess(replace)).toBe(true);

    const oversized = await run(
      Effect.flatMap(McpServersRepo, (repo) =>
        Effect.flip(
          repo.save("ben", {
            ...github,
            sealedSecrets: "x".repeat(MCP_SERVER_LIMITS.sealedBytes + 1),
          }),
        ),
      ),
    );
    expect(oversized.message).toBe("a server's variables or headers total over 64 KB");
  });

  describe("sign-ins", () => {
    const seen = (overrides: Partial<McpSignInObserved> = {}): McpSignInObserved => ({
      serverName: "figma",
      serverUrl: "https://mcp.figma.com/mcp",
      key: "figma|0123456789abcdef",
      sealed: "v1.sealed-sign-in-1",
      expiresAt: at("2026-11-09T12:00:00Z"),
      processStartedAt: at("2026-11-09T10:00:00Z"),
      ...overrides,
    });
    const keep = (input: McpSignInObserved) =>
      run(Effect.flatMap(McpServersRepo, (repo) => repo.keepSignIn("dana", input)));
    const figmaOfDana = () =>
      run(
        Effect.gen(function* () {
          const repo = yield* McpServersRepo;
          const launch = (yield* repo.forLaunch("dana")).find((server) => server.name === "figma");
          const listed = (yield* repo.list("dana")).find((server) => server.name === "figma");
          return { launch, listed };
        }),
      );

    beforeAll(() =>
      run(
        Effect.gen(function* () {
          const repo = yield* McpServersRepo;
          yield* repo.save("dana", figma);
          yield* repo.save("dana", github);
        }),
      ),
    );

    it("keeps the newest sign-in for a server matched on name and URL, and posting again changes nothing", async () => {
      expect(await keep(seen())).toBe("kept");
      expect(await keep(seen({ serverName: "FIGMA" }))).toBe("older");
      expect(
        await keep(seen({ sealed: "v1.sealed-earlier", expiresAt: at("2026-11-09T11:00:00Z") })),
      ).toBe("older");
      expect(
        await keep(seen({ sealed: "v1.sealed-sign-in-2", expiresAt: at("2026-11-09T13:00:00Z") })),
      ).toBe("kept");
      const { launch, listed } = await figmaOfDana();
      expect(launch?.signIn).toEqual({
        key: "figma|0123456789abcdef",
        sealed: "v1.sealed-sign-in-2",
        expiresAt: at("2026-11-09T13:00:00Z"),
      });
      expect(listed?.signIn?.expiresAt).toEqual(at("2026-11-09T13:00:00Z"));
      expect(listed?.signIn?.observedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(listed)).not.toContain("sealed");
    });

    it("keeps nothing for a server the person does not have at that URL, nor for a stdio server", async () => {
      expect(await keep(seen({ serverUrl: "https://mcp.figma.com/other" }))).toBe("no-server");
      expect(await keep(seen({ serverName: "linear" }))).toBe("no-server");
      expect(await keep(seen({ serverName: "github", serverUrl: "npx" }))).toBe("no-server");
      expect(
        await run(Effect.flatMap(McpServersRepo, (repo) => repo.keepSignIn("cleo", seen()))),
      ).toBe("no-server");
    });

    it("forgets a sign-in, and refuses one from a process started before the Forget", async () => {
      const forgotten = await run(
        Effect.flatMap(McpServersRepo, (repo) => repo.forgetSignIn("dana", "figma")),
      );
      expect(forgotten?.signIn).toBeNull();
      expect(
        await run(Effect.flatMap(McpServersRepo, (repo) => repo.forgetSignIn("dana", "nothing"))),
      ).toBeNull();
      const { launch } = await figmaOfDana();
      expect(launch?.signIn).toBeNull();
      const resetAt = launch?.signInResetAt;
      expect(resetAt).toBeInstanceOf(Date);
      expect(await keep(seen({ expiresAt: at("2026-11-09T20:00:00Z") }))).toBe("reset");
      expect(await keep(seen({ processStartedAt: new Date(Date.now() + 60_000) }))).toBe("kept");
    });

    it("forgets the sign-in when the URL or transport changes, and keeps it on any other edit", async () => {
      expect(
        await keep(
          seen({
            expiresAt: at("2026-11-10T00:00:00Z"),
            processStartedAt: at("2099-01-01T00:00:00Z"),
          }),
        ),
      ).toBe("kept");
      await run(
        Effect.flatMap(McpServersRepo, (repo) =>
          repo.save("dana", { ...figma, secretNames: ["Authorization"], enabled: false }),
        ),
      );
      expect((await figmaOfDana()).listed?.signIn).not.toBeNull();
      await run(
        Effect.flatMap(McpServersRepo, (repo) =>
          repo.save("dana", {
            ...figma,
            transport: { _tag: "sse", url: McpServerUrl.make("https://mcp.figma.com/mcp") },
          }),
        ),
      );
      expect((await figmaOfDana()).listed?.signIn).toBeNull();
      expect(
        await keep(
          seen({
            expiresAt: at("2026-11-10T01:00:00Z"),
            processStartedAt: at("2099-01-01T00:00:00Z"),
          }),
        ),
      ).toBe("kept");
      await run(
        Effect.flatMap(McpServersRepo, (repo) =>
          repo.save("dana", {
            ...figma,
            transport: { _tag: "sse", url: McpServerUrl.make("https://mcp.figma.com/sse") },
            enabled: true,
          }),
        ),
      );
      const { listed, launch } = await figmaOfDana();
      expect(listed?.signIn).toBeNull();
      expect(launch?.signIn).toBeNull();
    });

    it("forgets the sign-in of a sealed URL only when a save replaces the sealed URL", async () => {
      const tavily = (sealedUrl: string): McpServerSave => ({
        ...figma,
        name: name("tavily"),
        transport: { _tag: "http", url: McpServerUrl.make(SHOWN_URL) },
        sealedUrl,
      });
      const signedIn = async () =>
        (await run(Effect.flatMap(McpServersRepo, (repo) => repo.list("dana")))).find(
          (server) => server.name === "tavily",
        )?.signIn ?? null;
      const keepTavily = (expiresAt: string) =>
        keep(
          seen({
            serverName: "tavily",
            serverUrl: SHOWN_URL,
            key: "tavily|0123456789abcdef",
            expiresAt: at(expiresAt),
            processStartedAt: at("2099-01-01T00:00:00Z"),
          }),
        );
      await run(Effect.flatMap(McpServersRepo, (repo) => repo.save("dana", tavily("v1.url-a"))));
      expect(await keepTavily("2026-11-10T00:00:00Z")).toBe("kept");
      await run(
        Effect.flatMap(McpServersRepo, (repo) =>
          repo.save("dana", { ...tavily("v1.url-a"), enabled: false }),
        ),
      );
      expect(await signedIn()).not.toBeNull();
      await run(Effect.flatMap(McpServersRepo, (repo) => repo.save("dana", tavily("v1.url-b"))));
      expect(await signedIn()).toBeNull();
    });
  });

  it("removes a person's servers with their account", async () => {
    const left = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM "user" WHERE id = 'ben'`;
        return yield* (yield* McpServersRepo).list("ben");
      }),
    );
    expect(left).toEqual([]);
  });
});
