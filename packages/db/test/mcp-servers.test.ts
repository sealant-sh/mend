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
const figma: McpServerSave = {
  name: name("figma"),
  transport: { _tag: "http", url: McpServerUrl.make("https://mcp.figma.com/mcp") },
  secretNames: [],
  sealedSecrets: null,
};
const github: McpServerSave = {
  name: name("github"),
  transport: { _tag: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  secretNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
  sealedSecrets: "v1.sealed-github",
};

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
            ('cleo', 'Cleo Example', 'cleo@example.com', '2026-01-01T00:00:00Z')`;
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
          secrets: yield* repo.sealedSecretsOf("ben", name("github")),
          missing: yield* repo.sealedSecretsOf("ben", name("nothing")),
          othersSecrets: yield* repo.sealedSecretsOf("cleo", name("github")),
        };
      }),
    );
    expect(launch.launch).toEqual([
      expect.objectContaining({ name: "github", sealedSecrets: "v1.sealed-github" }),
    ]);
    expect(launch.secrets).toEqual({ kind: "env", sealed: "v1.sealed-github" });
    expect(launch.missing).toBeNull();
    expect(launch.othersSecrets).toBeNull();
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
