import { PgClient } from "@effect/sql-pg";
import type { ProjectId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentMemoryRepo,
  AgentMemoryRepoLive,
  agentMemoryDigest,
  type MergeText,
  planAgentMemoryReadBack,
  type StoredMemoryFile,
} from "../src/repos/agent-memory.ts";

const ROOT = ".claude/projects/-workspace-repo/memory";
const text = (name: string, contents: string) => ({
  path: `${ROOT}/${name}`,
  encoding: "utf8" as const,
  contents,
});
const withDigest = (file: ReturnType<typeof text>) => ({
  ...file,
  digest: agentMemoryDigest(file),
});
const stored = (
  file: ReturnType<typeof text>,
  updatedBySession: string | null = null,
): StoredMemoryFile => ({ ...withDigest(file), updatedBySession });

describe("reading a session's memory back", () => {
  const v1 = text("MEMORY.md", "- one\n");
  const v2 = text("MEMORY.md", "- one\n- two\n");
  const other = text("MEMORY.md", "- one\n- three\n");
  const delivered = { [v1.path]: agentMemoryDigest(v1) };

  it("saves nothing the session left as delivered", () => {
    expect(
      planAgentMemoryReadBack({
        delivered,
        session: [withDigest(v1)],
        stored: new Map([[v1.path, stored(other, "s-other")]]),
        sessionId: "s1",
      }),
    ).toEqual([]);
  });

  it("saves a change when the store still holds what was delivered, or its own earlier save", () => {
    for (const current of [stored(v1), stored(other, "s1")]) {
      expect(
        planAgentMemoryReadBack({
          delivered,
          session: [withDigest(v2)],
          stored: new Map([[v1.path, current]]),
          sessionId: "s1",
        }),
      ).toEqual([{ kind: "save", file: v2, replacing: current }]);
    }
  });

  it("merges text both changed since delivery, against the delivered version", () => {
    const current = stored(other, "s-other");
    expect(
      planAgentMemoryReadBack({
        delivered,
        session: [withDigest(v2)],
        stored: new Map([[v1.path, current]]),
        sessionId: "s1",
      }),
    ).toEqual([{ kind: "merge", file: v2, stored: current, base: agentMemoryDigest(v1) }]);
  });

  it("deletes a delivered file the session deleted, unless the store changed it meanwhile", () => {
    expect(
      planAgentMemoryReadBack({
        delivered,
        session: [],
        stored: new Map([[v1.path, stored(v1)]]),
        sessionId: "s1",
      }),
    ).toEqual([{ kind: "delete", stored: stored(v1) }]);
    expect(
      planAgentMemoryReadBack({
        delivered,
        session: [],
        stored: new Map([[v1.path, stored(other, "s-other")]]),
        sessionId: "s1",
      }),
    ).toEqual([]);
  });
});

/**
 * Against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway database. Without one
 * reachable these skip rather than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_agent_memory_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = AgentMemoryRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, AgentMemoryRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));
const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    return true;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

/** Keeps every line of both sides, as `git merge-file --union` does for appended lines. */
const unionMerge: MergeText = ({ ours, theirs }) =>
  Effect.succeed([...new Set([...ours.split("\n"), ...theirs.split("\n")])].join("\n"));

const project = "project-1" as ProjectId;

describe.skipIf(!reachable)("agent memory, in Postgres", () => {
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
          VALUES ('anna', 'Anna Example', 'anna@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${project}, 'p', '/store/p-1/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
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

  it("keeps what two sessions learned from the same delivery, and every version it replaced", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const v1 = text("MEMORY.md", "- one");
        expect(yield* repo.importFiles("anna", project, [v1])).toEqual({
          added: [v1.path],
          unchanged: [],
          conflicting: [],
        });
        // Two sessions receive v1; each adds a line.
        const delivered = { [v1.path]: agentMemoryDigest(v1) };
        const first = yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s1",
          delivered,
          session: [text("MEMORY.md", "- one\n- two"), text("notes.md", "build with pnpm")],
          merge: unionMerge,
        });
        expect(first).toEqual({
          saved: [v1.path, `${ROOT}/notes.md`],
          merged: [],
          deleted: [],
          skipped: [],
        });
        const second = yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s2",
          delivered,
          session: [text("MEMORY.md", "- one\n- three")],
          merge: unionMerge,
        });
        expect(second.merged).toEqual([v1.path]);
        expect((yield* repo.read("anna", project, v1.path))?.file.contents).toBe(
          "- one\n- two\n- three",
        );
        // s1 deleted nothing; s2 never had notes.md delivered, so it is not "deleted" by s2.
        expect((yield* repo.list("anna", project)).map((entry) => entry.name).toSorted()).toEqual([
          "MEMORY.md",
          "notes.md",
        ]);
        const versions = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_versions WHERE path = ${v1.path} ORDER BY contents`;
        expect(versions.map((row) => row.contents)).toEqual(["- one", "- one\n- two"]);
      }),
    );
  });

  it("lets a session's later read-back replace its own earlier save", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const path = `${ROOT}/notes.md`;
        const before = (yield* repo.read("anna", project, path))?.file.contents;
        expect(before).toBe("build with pnpm");
        const again = yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s1",
          delivered: {},
          session: [text("notes.md", "build with pnpm\ntest with vitest")],
          merge: () => Effect.die("no merge for a session's own save"),
        });
        expect(again.saved).toEqual([path]);
      }),
    );
  });

  it("deletes what a session deleted, keeps it as a version, and refuses paths outside memory", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const notes = (yield* repo.read("anna", project, `${ROOT}/notes.md`))?.file;
        if (notes === undefined) throw new Error("notes.md is stored");
        const done = yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s3",
          delivered: { [notes.path]: agentMemoryDigest(notes) },
          session: [{ path: ".claude/.credentials.json", encoding: "utf8", contents: "{}" }],
          merge: unionMerge,
        });
        expect(done).toEqual({
          saved: [],
          merged: [],
          deleted: [notes.path],
          skipped: [".claude/.credentials.json"],
        });
        const kept = yield* sql`SELECT 1 FROM agent_memory_versions WHERE path = ${notes.path}`;
        expect(kept.length).toBeGreaterThan(0);
        expect(yield* repo.remove("anna", project, `${ROOT}/MEMORY.md`)).toBe(true);
        expect(yield* repo.remove("anna", project, `${ROOT}/MEMORY.md`)).toBe(false);
        expect(yield* repo.list("anna", project)).toEqual([]);
      }),
    );
  });

  it("imports only what is absent, and goes with the account", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.importFiles("anna", project, [text("a.md", "a")]);
        expect(
          yield* repo.importFiles("anna", project, [text("a.md", "a"), text("a.md", "changed")]),
        ).toEqual({ added: [], unchanged: [`${ROOT}/a.md`], conflicting: [`${ROOT}/a.md`] });
        yield* sql`DELETE FROM "user" WHERE id = 'anna'`;
        expect(yield* sql`SELECT 1 FROM agent_memory_files`).toEqual([]);
        expect(yield* sql`SELECT 1 FROM agent_memory_versions`).toEqual([]);
      }),
    );
  });
});
