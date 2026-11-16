import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { OrganizationId, ProjectId, SessionId } from "@mend/domain";
import { importedTurnProcessIdOf } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
} from "../src/repos/agent-conversation.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { DevicesRepoLive } from "../src/repos/devices.ts";
import {
  type ImportedConversation,
  ImportedConversationsRepo,
  ImportedConversationsRepoLive,
} from "../src/repos/imported-conversations.ts";
import {
  MemberRevocationsRepo,
  MemberRevocationsRepoLive,
} from "../src/repos/member-revocations.ts";
import { SlackLinksRepoLive } from "../src/repos/slack-links.ts";
import { UsersRepoLive } from "../src/repos/users.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_imported_conversations_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(url.toString()) });
const dbLayer = MendDBLive.pipe(Layer.provideMerge(scratchLayer));
const layer = Layer.mergeAll(
  ImportedConversationsRepoLive,
  AgentConversationRepoLive,
  SessionsRepoLive,
  MemberRevocationsRepoLive.pipe(
    Layer.provide(Layer.mergeAll(UsersRepoLive, DevicesRepoLive, SlackLinksRepoLive)),
  ),
).pipe(Layer.provideMerge(dbLayer));
type Services = Layer.Success<typeof layer>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
let created = false;

const project = ProjectId.make("project");
const other = ProjectId.make("project-other-org");
const NATIVE = "0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const transcriptPath = `.claude/projects/-home-ada-shop/${NATIVE}.jsonl`;
const shotPath = `.claude/projects/-home-ada-shop/${NATIVE}/tool-results/shot.png`;
const transcript = new TextEncoder().encode('{"type":"user"}\n');
// Not UTF-8: a screenshot is kept byte for byte.
const shot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = [
  { relativePath: transcriptPath, bytes: transcript },
  { relativePath: shotPath, bytes: shot },
];

const conversationOf = (
  sessionId: string,
  overrides: Partial<Omit<ImportedConversation, "deliveredAt">> = {},
): Omit<ImportedConversation, "deliveredAt"> => ({
  sessionId: SessionId.make(sessionId),
  projectId: project,
  ownerUserId: "alice",
  harness: "claude",
  nativeId: NATIVE,
  source: { checkout: "/home/ada/shop", home: "/home/ada" },
  files: bytes.map((file) => ({
    relativePath: file.relativePath,
    byteLength: file.bytes.byteLength,
    sha256: digest(file.bytes),
  })),
  byteLength: transcript.byteLength + shot.byteLength,
  permissionMode: "ask",
  ...overrides,
});

const turns = [
  {
    providerTurnId: "native:user-1",
    input: "Fix the cart total",
    items: [
      {
        providerItemId: "msg-1:block:0",
        providerTurnId: "native:user-1",
        kind: "assistant-message" as const,
        status: "completed" as const,
        title: null,
        text: "Fixed.",
        data: null,
      },
    ],
  },
];

const countOf = (table: string, sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly n: string }>`
      SELECT count(*)::text AS n FROM ${sql(table)} WHERE session_id = ${sessionId}`;
    return Number(row?.n ?? 0);
  });

const addSession = (id: string, projectId: string = project, owner = "alice") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,harness,worktree,branch,base_sha,status,owner_user_id)
      VALUES (${id},${projectId},${`worktree-${projectId}`},'claude','w','mend/w',${"a".repeat(40)},'starting',${owner})`;
  });

describe.skipIf(postgres.skip)("imported conversations against PostgreSQL", () => {
  let organization: OrganizationId;
  beforeAll(async () => {
    await withAdmin(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)),
    );
    created = true;
    organization = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migrate] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migrate;
        yield* sql`INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
          ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z'),
          ('bob', 'Bob', 'bob@example.com', '2026-01-02T00:00:00Z')`;
        const [org] = yield* sql<{
          readonly id: string;
        }>`SELECT id FROM organizations LIMIT 1`;
        const id = OrganizationId.make(org?.id ?? "");
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-other', 'Other')`;
        yield* sql`INSERT INTO organization_members (organization_id, user_id, role) VALUES
          (${id}, 'bob', 'owner'), (${id}, 'alice', 'member'), ('org-other', 'alice', 'owner')`;
        for (const [projectId, orgId] of [
          [project, id],
          [other, "org-other"],
        ] as const) {
          yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id)
            VALUES (${projectId},${projectId},${`/unused/${projectId}`},'main',${orgId})`;
          yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
            VALUES (${`worktree-${projectId}`},${projectId},'w','w','mend/w',${"a".repeat(40)})`;
        }
        return id;
      }),
    );
  });
  afterAll(async () => {
    if (!created) return;
    await withAdmin(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`),
      ),
    );
  });
  beforeEach(async () => {
    await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM agent_sessions`));
  });

  it("keeps the files byte for byte and shows the turns as imported, run by no process", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* addSession("s1");
        const imports = yield* ImportedConversationsRepo;
        const saved = yield* imports.save(conversationOf("s1"), bytes, turns);
        const files = yield* imports.files(SessionId.make("s1"));
        const listed = yield* (yield* AgentConversationRepo).listTurns(SessionId.make("s1"));
        const items = yield* (yield* AgentConversationRepo).listItems(SessionId.make("s1"), 0, 100);
        return { saved, files, listed, items };
      }),
    );
    expect(outcome.saved).toEqual({ _tag: "Saved", turns: 1 });
    expect(outcome.files.map((file) => [file.relativePath, [...file.bytes]])).toEqual([
      [transcriptPath, [...transcript]],
      [shotPath, [...shot]],
    ]);
    expect(outcome.listed).toHaveLength(1);
    expect(outcome.listed[0]).toMatchObject({
      imported: true,
      processId: importedTurnProcessIdOf(SessionId.make("s1")),
      status: "completed",
      usage: null,
      billedUserId: null,
      input: "Fix the cart total",
    });
    expect(outcome.items.map((item) => [item.text, item.processId])).toEqual([
      ["Fixed.", importedTurnProcessIdOf(SessionId.make("s1"))],
    ]);
  });

  it("answers a repeat with the first session, keeps one copy, and tells another conversation apart", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* addSession("s1");
        yield* addSession("s2");
        yield* addSession("s3");
        const imports = yield* ImportedConversationsRepo;
        yield* imports.save(conversationOf("s1"), bytes, turns);
        const again = yield* imports.save(conversationOf("s2"), bytes, turns);
        // The same bytes under another native id are another conversation.
        const another = yield* imports.save(
          conversationOf("s3", {
            nativeId: "9e8d7c6b-5a49-4382-a716-151413121110",
          }),
          bytes,
          turns,
        );
        const taken = yield* imports.save(
          conversationOf("s1", {
            nativeId: "11111111-2222-4333-8444-555555555555",
          }),
          bytes,
          turns,
        );
        return {
          again,
          another,
          taken,
          s2Files: yield* countOf("session_imported_conversation_files", "s2"),
          s2Turns: yield* countOf("agent_turns", "s2"),
          s1Turns: yield* countOf("agent_turns", "s1"),
          found: yield* imports.sessionOf({
            ownerUserId: "alice",
            projectId: project,
            harness: "claude",
            nativeId: NATIVE,
          }),
          bob: yield* imports.sessionOf({
            ownerUserId: "bob",
            projectId: project,
            harness: "claude",
            nativeId: NATIVE,
          }),
        };
      }),
    );
    expect(outcome.again).toEqual({
      _tag: "AlreadyImported",
      sessionId: "s1",
    });
    expect(outcome.another).toEqual({ _tag: "Saved", turns: 1 });
    expect(outcome.taken).toEqual({ _tag: "SessionTaken" });
    expect([outcome.s2Files, outcome.s2Turns, outcome.s1Turns]).toEqual([0, 0, 1]);
    expect(outcome.found).toBe("s1");
    expect(outcome.bob).toBeNull();
  });

  it("marks the delivery once", async () => {
    const marks = await run(
      Effect.gen(function* () {
        yield* addSession("s1");
        const imports = yield* ImportedConversationsRepo;
        yield* imports.save(conversationOf("s1"), bytes, turns);
        const first = yield* imports.markDelivered(SessionId.make("s1"));
        const second = yield* imports.markDelivered(SessionId.make("s1"));
        const row = yield* imports.bySession(SessionId.make("s1"));
        return { first, second, delivered: row?.deliveredAt !== null };
      }),
    );
    expect(marks).toEqual({ first: true, second: false, delivered: true });
  });

  it("goes when the session is removed", async () => {
    const left = await run(
      Effect.gen(function* () {
        yield* addSession("s1");
        yield* (yield* ImportedConversationsRepo).save(conversationOf("s1"), bytes, turns);
        yield* (yield* SessionsRepo).remove(SessionId.make("s1"));
        return [
          yield* countOf("session_imported_conversations", "s1"),
          yield* countOf("session_imported_conversation_files", "s1"),
        ];
      }),
    );
    expect(left).toEqual([0, 0]);
  });

  it("goes when its project is purged", async () => {
    const left = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const purged = ProjectId.make("project-purged");
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id)
          VALUES (${purged},${purged},'/unused/purged','main',${organization})`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
          VALUES (${`worktree-${purged}`},${purged},'w','w','mend/w',${"a".repeat(40)})`;
        yield* addSession("s-purged", purged);
        yield* (yield* ImportedConversationsRepo).save(
          conversationOf("s-purged", { projectId: purged }),
          bytes,
          turns,
        );
        // The purge's own statement (RemovalFencesRepo): the project row goes, and with it its rows.
        yield* sql`DELETE FROM projects WHERE id = ${purged}`;
        return yield* countOf("session_imported_conversation_files", "s-purged");
      }),
    );
    expect(left).toBe(0);
  });

  it("goes when its owner is removed from the organization, and stays in another organization", async () => {
    const left = await run(
      Effect.gen(function* () {
        yield* addSession("s-mine");
        yield* addSession("s-elsewhere", other);
        const imports = yield* ImportedConversationsRepo;
        yield* imports.save(conversationOf("s-mine"), bytes, turns);
        yield* imports.save(conversationOf("s-elsewhere", { projectId: other }), bytes, turns);
        yield* (yield* MemberRevocationsRepo).beginRemoval({
          organizationId: organization,
          userId: "alice",
          actorUserId: "bob",
          revocationLeaseMs: 60_000,
        });
        return {
          mine: yield* countOf("session_imported_conversation_files", "s-mine"),
          elsewhere: yield* countOf("session_imported_conversation_files", "s-elsewhere"),
          // The history it showed stays, as the session's other turns do.
          turns: yield* countOf("agent_turns", "s-mine"),
        };
      }),
    );
    expect(left).toEqual({ mine: 0, elsewhere: 2, turns: 1 });
  });
});
