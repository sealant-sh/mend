import { PgClient } from "@effect/sql-pg";
import { PageId, SessionId, SessionProcessId } from "@mend/domain";
import type { AgentEventItem } from "@mend/domain/workbench";
import { Duration, Effect, Fiber, Layer, Redacted, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { listenEvents } from "../src/events.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
  type BackfillTurnInput,
} from "../src/repos/agent-conversation.ts";
import { SessionPagesRepo, SessionPagesRepoLive } from "../src/repos/session-pages.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_page_items_test_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = Layer.mergeAll(SessionPagesRepoLive, AgentConversationRepoLive).pipe(
  Layer.provideMerge(
    MendDBLive.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
    ),
  ),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    SessionPagesRepo | AgentConversationRepo | SqlClient.SqlClient | PgClient.PgClient | Scope.Scope
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const PROTOCOL = SessionId.make("s-items-protocol");
const PTY = SessionId.make("s-items-pty");
const SWITCHED = SessionId.make("s-items-switched");
const PROTOCOL_PROCESS = SessionProcessId.make("p-items-protocol");
const INTERRUPTED = SessionId.make("s-items-interrupted");
const INTERRUPTED_PROCESS = SessionProcessId.make("p-items-interrupted");
const REPAIRED = SessionId.make("s-items-repaired");
const REPAIRED_PROCESS = SessionProcessId.make("p-items-repaired");
const CONFLICT = SessionId.make("s-items-conflict");
const CONFLICT_PROCESS = SessionProcessId.make("p-items-conflict");
const TERMINAL = SessionId.make("s-items-terminal");
const TERMINAL_PROCESS = SessionProcessId.make("p-items-terminal");

const newPage = (
  sessionId: SessionId,
  callKey: string,
  agentProcessId: SessionProcessId | null = null,
) => ({
  sessionId,
  callKey,
  accountId: "alice",
  agentProcessId,
  title: `Page ${callKey}`,
  height: 320,
  html: `<!doctype html><p>${"x".repeat(4096)}</p>`,
});

const pageCall = (id: string, providerTurnId: string, attachmentId: string): AgentEventItem => ({
  providerItemId: id,
  providerTurnId,
  kind: "tool-call",
  status: "completed",
  title: "mcp__mend__html_render",
  text: null,
  data: {
    type: "tool_use",
    id,
    name: "mcp__mend__html_render",
    mendPageCall: { attachmentId, failure: null },
  },
});

interface ItemRow {
  readonly turn_id: string;
  readonly process_id: string;
  readonly seq: number;
  readonly provider_item_id: string;
  readonly kind: string;
  readonly status: string;
  readonly title: string | null;
  readonly text: string | null;
  readonly data: unknown;
}

const pageItems = (sessionId: SessionId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<ItemRow>`
      SELECT turn_id, process_id, seq, provider_item_id, kind, status, title, text, data
      FROM agent_items WHERE session_id = ${sessionId} AND kind = 'page' ORDER BY seq`,
  );

describe.skipIf(postgres.skip)("a published page in the conversation record", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`)),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
          VALUES ('alice', 'alice', 'alice@example.invalid', '2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-items', 'items', '/store/p-items/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-items', 'p-items', 'items', 'items', 'mend/items', ${"a".repeat(40)})`;
        for (const id of [PROTOCOL, PTY, SWITCHED, INTERRUPTED, REPAIRED, CONFLICT, TERMINAL]) {
          yield* sql`INSERT INTO agent_sessions
              (id, project_id, worktree_id, owner_user_id, harness, worktree, branch, base_sha, status)
            VALUES (${id}, 'p-items', 'wt-items', 'alice', 'claude', 'items', 'mend/items',
                    ${"a".repeat(40)}, 'running')`;
        }
        yield* sql`INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, kind, harness, status, created_at)
          VALUES
            (${PROTOCOL_PROCESS}, ${PROTOCOL}, 'ws-1', 'agent-protocol', 'claude', 'running', now()),
            ('p-items-pty', ${PTY}, 'ws-2', 'agent-pty', 'claude', 'running', now()),
            ('p-items-old-protocol', ${SWITCHED}, 'ws-3', 'agent-protocol', 'claude', 'exited',
             now() - interval '1 hour'),
            ('p-items-new-pty', ${SWITCHED}, 'ws-3', 'agent-pty', 'claude', 'running', now()),
            (${INTERRUPTED_PROCESS}, ${INTERRUPTED}, 'ws-4', 'agent-protocol', 'claude', 'running',
             now()),
            (${REPAIRED_PROCESS}, ${REPAIRED}, 'ws-5', 'agent-protocol', 'claude', 'running', now()),
            (${CONFLICT_PROCESS}, ${CONFLICT}, 'ws-6', 'agent-protocol', 'claude', 'running', now()),
            (${TERMINAL_PROCESS}, ${TERMINAL}, 'ws-7', 'agent-pty', 'claude', 'running', now())`;
        const conversation = yield* AgentConversationRepo;
        yield* conversation.submitTurn(
          SWITCHED,
          SessionProcessId.make("p-items-old-protocol"),
          "before the switch",
          "alice",
        );
        yield* conversation.claimNextTurn(SessionProcessId.make("p-items-old-protocol"));
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await withAdmin(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`),
      ),
    );
  });

  it("is one page item in the running turn, written with the page, and a retry adds none", async () => {
    const result = await run(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const pages = yield* SessionPagesRepo;
        const pg = yield* PgClient.PgClient;
        const turn = yield* conversation.submitTurn(
          PROTOCOL,
          PROTOCOL_PROCESS,
          "chart it",
          "alice",
        );
        yield* conversation.claimNextTurn(PROTOCOL_PROCESS);
        yield* conversation.setProviderTurnId(turn.id, "provider-turn-1");
        const before = yield* conversation.upsertItem({
          sessionId: PROTOCOL,
          processId: PROTOCOL_PROCESS,
          turnId: turn.id,
          providerItemId: "toolu_1",
          providerTurnId: "provider-turn-1",
          providerOutputSeq: 1n,
          providerEventIndex: 0,
          kind: "tool-call",
          status: "completed",
          title: "mcp__mend__html_render",
          text: null,
          data: null,
        });
        const pointer = yield* Effect.forkScoped(
          listenEvents(pg).pipe(
            Stream.filter((payload) => payload.includes(PROTOCOL)),
            Stream.take(2),
            Stream.runCollect,
          ),
        );
        yield* Effect.sleep(Duration.millis(200));
        const published = yield* Effect.all(
          Array.from({ length: 4 }, () => pages.publish(newPage(PROTOCOL, "call-running"))),
          { concurrency: "unbounded" },
        );
        const notified = yield* Fiber.join(pointer).pipe(Effect.timeout(Duration.seconds(5)));
        return { turn, before, published, notified, items: yield* pageItems(PROTOCOL) };
      }),
    );
    const id = result.published[0]?.id;
    expect(new Set(result.published.map((row) => row.id)).size).toBe(1);
    expect(result.items).toEqual([
      {
        turn_id: result.turn.id,
        process_id: PROTOCOL_PROCESS,
        seq: result.before.seq + 1,
        provider_item_id: `mend-page:${id}`,
        kind: "page",
        status: "completed",
        title: "Page call-running",
        text: null,
        data: {
          id,
          sessionId: PROTOCOL,
          title: "Page call-running",
          height: 320,
          publishedAt: result.published[0]?.publishedAt.toISOString(),
        },
      },
    ]);
    expect(JSON.stringify(result.items)).not.toContain("xxxx");
    expect([...result.notified].map((payload) => JSON.parse(payload))).toEqual([
      { type: "agent-conversation", sessionId: PROTOCOL, projectId: "p-items" },
      { type: "session", sessionId: PROTOCOL, projectId: "p-items" },
    ]);
  });

  it("lands in the turn after it completed, never in a turn still queued", async () => {
    const result = await run(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const pages = yield* SessionPagesRepo;
        const turns = yield* conversation.listTurns(PROTOCOL);
        const running = turns.find((turn) => turn.status === "running");
        if (running === undefined) return yield* Effect.die("no running turn");
        yield* conversation.completeTurn("provider-turn-1", PROTOCOL, "completed", null, null);
        yield* conversation.submitTurn(PROTOCOL, PROTOCOL_PROCESS, "queued next", "alice");
        const published = yield* pages.publish(newPage(PROTOCOL, "call-after-completion"));
        const items = yield* pageItems(PROTOCOL);
        return { completed: running.id, published, items };
      }),
    );
    const late = result.items.find(
      (item) => item.provider_item_id === `mend-page:${result.published.id}`,
    );
    expect(late?.turn_id).toBe(result.completed);
    expect(result.items).toHaveLength(2);
  });

  it("writes no item for a session whose current agent has no protocol turn", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pages = yield* SessionPagesRepo;
        const pty = yield* pages.publish(newPage(PTY, "call-pty"));
        const switched = yield* pages.publish(newPage(SWITCHED, "call-switched"));
        return {
          pty,
          switched,
          ptyItems: yield* pageItems(PTY),
          switchedItems: yield* pageItems(SWITCHED),
          listed: yield* pages.listForSession(SWITCHED),
        };
      }),
    );
    expect(result.ptyItems).toEqual([]);
    expect(result.switchedItems).toEqual([]);
    expect(result.listed.map((ref) => ref.id)).toEqual([result.switched.id]);
  });

  it("lands in the turn of the agent process that made it after another became the session's agent, never in another session's", async () => {
    const OLD_PROCESS = SessionProcessId.make("p-items-old-protocol");
    const result = await run(
      Effect.gen(function* () {
        const pages = yield* SessionPagesRepo;
        const [old] = yield* (yield* AgentConversationRepo).listTurns(SWITCHED);
        const fromOld = yield* pages.publish(newPage(SWITCHED, "call-from-old", OLD_PROCESS));
        const retried = yield* pages.publish(newPage(SWITCHED, "call-from-old", OLD_PROCESS));
        const foreign = yield* pages.publish(
          newPage(SWITCHED, "call-naming-another-session", PROTOCOL_PROCESS),
        );
        return {
          old,
          fromOld,
          retried,
          foreign,
          switched: yield* pageItems(SWITCHED),
          protocol: yield* pageItems(PROTOCOL),
        };
      }),
    );
    expect(result.retried.id).toBe(result.fromOld.id);
    expect(
      result.switched.map((item) => [item.provider_item_id, item.process_id, item.turn_id]),
    ).toEqual([[`mend-page:${result.fromOld.id}`, OLD_PROCESS, result.old?.id]]);
    expect(result.protocol.map((item) => item.provider_item_id)).not.toContain(
      `mend-page:${result.foreign.id}`,
    );
  });

  it("tells a terminal session's clients of each new page, though it adds no item, and of no retry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pages = yield* SessionPagesRepo;
        const pg = yield* PgClient.PgClient;
        const heard: Array<unknown> = [];
        const listening = yield* Effect.forkScoped(
          listenEvents(pg).pipe(
            Stream.filter((payload) => payload.includes(PTY)),
            Stream.take(2),
            Stream.runForEach((payload) => Effect.sync(() => heard.push(JSON.parse(payload)))),
          ),
        );
        yield* Effect.sleep(Duration.millis(200));
        yield* pages.publish(newPage(PTY, "call-live"));
        yield* Effect.sleep(Duration.millis(300));
        const afterFirst = [...heard];
        yield* pages.publish(newPage(PTY, "call-live"));
        yield* Effect.sleep(Duration.millis(300));
        const afterRetry = [...heard];
        yield* pages.publish(newPage(PTY, "call-live-2"));
        yield* Fiber.join(listening).pipe(Effect.timeout(Duration.seconds(5)));
        return { afterFirst, afterRetry, heard, items: yield* pageItems(PTY) };
      }),
    );
    const published = { type: "session", sessionId: PTY, projectId: "p-items" };
    expect(result.items).toEqual([]);
    expect(result.afterFirst).toEqual([published]);
    expect(result.afterRetry).toEqual([published]);
    expect(result.heard).toEqual([published, published]);
  });

  it("allocates seq under the conversation's lock, beside items the harness streams", async () => {
    const result = await run(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const pages = yield* SessionPagesRepo;
        yield* conversation.completeTurn("provider-turn-1", PROTOCOL, "completed", null, null);
        const turn = yield* conversation.claimNextTurn(PROTOCOL_PROCESS);
        if (turn === null) return yield* Effect.die("the queued turn was not claimed");
        const streamed = Effect.forEach(
          Array.from({ length: 12 }, (_, index) => index),
          (index) =>
            conversation.upsertItem({
              sessionId: PROTOCOL,
              processId: PROTOCOL_PROCESS,
              turnId: turn.id,
              providerItemId: `race-${index}`,
              providerTurnId: "provider-turn-race",
              providerOutputSeq: BigInt(100 + index),
              providerEventIndex: 0,
              kind: "assistant-message",
              status: "in-progress",
              title: null,
              text: `word ${index}`,
              data: null,
            }),
          { concurrency: 4 },
        );
        const published = Effect.forEach(
          Array.from({ length: 6 }, (_, index) => index),
          (index) => pages.publish(newPage(PROTOCOL, `call-race-${index}`)),
          { concurrency: 3 },
        );
        yield* Effect.all([streamed, published], { concurrency: "unbounded" });
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ seq: number; kind: string }>`
          SELECT seq, kind FROM agent_items WHERE turn_id = ${turn.id} ORDER BY seq`;
      }),
    );
    expect(result.filter((row) => row.kind === "page")).toHaveLength(6);
    expect(result).toHaveLength(18);
    expect(new Set(result.map((row) => row.seq)).size).toBe(18);
  });

  it("stores no page when its item cannot be written, and the retry stores both", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const pages = yield* SessionPagesRepo;
        const before = yield* pageItems(PROTOCOL);
        yield* sql`ALTER TABLE agent_items ADD CONSTRAINT reject_test_pages CHECK (kind <> 'page') NOT VALID`;
        const refused = yield* pages
          .publish(newPage(PROTOCOL, "call-rollback"))
          .pipe(
            Effect.flip,
            Effect.ensuring(
              sql`ALTER TABLE agent_items DROP CONSTRAINT reject_test_pages`.pipe(Effect.orDie),
            ),
          );
        const stored = yield* sql<{ id: string }>`
          SELECT id FROM session_pages WHERE call_key = 'call-rollback'`;
        const retried = yield* pages.publish(newPage(PROTOCOL, "call-rollback"));
        return { before, refused, stored, retried, after: yield* pageItems(PROTOCOL) };
      }),
    );
    expect(result.refused._tag).toBe("SessionPageStorageError");
    expect(result.stored).toEqual([]);
    expect(result.after.map((row) => row.provider_item_id)).toEqual([
      ...result.before.map((row) => row.provider_item_id),
      `mend-page:${result.retried.id}`,
    ]);
  });

  it("lands in the turn it was published in, however that turn ended", async () => {
    const result = await run(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const pages = yield* SessionPagesRepo;
        const landed: Array<{ turn: string; page: string }> = [];
        for (const ending of ["completed", "interrupted", "failed"] as const) {
          const turn = yield* conversation.submitTurn(
            INTERRUPTED,
            INTERRUPTED_PROCESS,
            `turn that ends ${ending}`,
            "alice",
          );
          yield* conversation.claimNextTurn(INTERRUPTED_PROCESS);
          yield* conversation.setProviderTurnId(turn.id, `provider-${ending}`);
          yield* conversation.completeTurn(`provider-${ending}`, INTERRUPTED, ending, null, null);
          const page = yield* pages.publish(newPage(INTERRUPTED, `call-${ending}`));
          landed.push({ turn: turn.id, page: page.id });
        }
        return { landed, items: yield* pageItems(INTERRUPTED) };
      }),
    );
    expect(result.items.map((item) => [item.turn_id, item.provider_item_id])).toEqual(
      result.landed.map(({ turn, page }) => [turn, `mend-page:${page}`]),
    );
  });

  it("is written by a retry when the first commit had no turn to write it in", async () => {
    const result = await run(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const pages = yield* SessionPagesRepo;
        const turn = yield* conversation.submitTurn(REPAIRED, REPAIRED_PROCESS, "queued", "alice");
        const first = yield* pages.publish(newPage(REPAIRED, "call-early"));
        const before = yield* pageItems(REPAIRED);
        yield* conversation.claimNextTurn(REPAIRED_PROCESS);
        const retried = yield* Effect.all(
          Array.from({ length: 3 }, () => pages.publish(newPage(REPAIRED, "call-early"))),
          { concurrency: "unbounded" },
        );
        return { turn, first, before, retried, after: yield* pageItems(REPAIRED) };
      }),
    );
    expect(result.before).toEqual([]);
    expect(result.retried.map((row) => row.id)).toEqual([
      result.first.id,
      result.first.id,
      result.first.id,
    ]);
    expect(result.after.map((item) => [item.turn_id, item.provider_item_id])).toEqual([
      [result.turn.id, `mend-page:${result.first.id}`],
    ]);
  });

  it("stores no page when its item collides, rather than a page with no item", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const conversation = yield* AgentConversationRepo;
        const pages = yield* SessionPagesRepo;
        const turn = yield* conversation.submitTurn(CONFLICT, CONFLICT_PROCESS, "go", "alice");
        yield* conversation.claimNextTurn(CONFLICT_PROCESS);
        yield* conversation.upsertItem({
          sessionId: CONFLICT,
          processId: CONFLICT_PROCESS,
          turnId: turn.id,
          providerItemId: "msg_conflict",
          providerTurnId: "provider-conflict",
          providerOutputSeq: 1n,
          providerEventIndex: 0,
          kind: "assistant-message",
          status: "completed",
          title: null,
          text: "hi",
          data: null,
        });
        yield* sql.unsafe(`
          CREATE FUNCTION reuse_page_seq() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.kind = 'page' THEN
              NEW.seq := (SELECT min(seq) FROM agent_items WHERE session_id = NEW.session_id);
            END IF;
            RETURN NEW;
          END $$`);
        yield* sql`CREATE TRIGGER reuse_page_seq BEFORE INSERT ON agent_items
          FOR EACH ROW EXECUTE FUNCTION reuse_page_seq()`;
        const refused = yield* pages
          .publish(newPage(CONFLICT, "call-collides"))
          .pipe(
            Effect.flip,
            Effect.ensuring(
              Effect.all([
                sql`DROP TRIGGER reuse_page_seq ON agent_items`,
                sql`DROP FUNCTION reuse_page_seq()`,
              ]).pipe(Effect.orDie),
            ),
          );
        const stored = yield* sql<{ id: string }>`
          SELECT id FROM session_pages WHERE session_id = ${CONFLICT}`;
        return { refused, stored };
      }),
    );
    expect(result.refused._tag).toBe("SessionPageStorageError");
    expect(result.stored).toEqual([]);
  });

  it("shows a page from a terminal period once its history lands in the conversation", async () => {
    const result = await run(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const pages = yield* SessionPagesRepo;
        const published = yield* pages.publish(newPage(TERMINAL, "call-terminal"));
        const before = yield* pageItems(TERMINAL);
        const history = (providerTurnId: string): ReadonlyArray<BackfillTurnInput> => [
          {
            providerTurnId,
            input: "chart it",
            items: [
              pageCall(`toolu_${providerTurnId}`, providerTurnId, published.id),
              pageCall(`toolu_forged_${providerTurnId}`, providerTurnId, "page-of-another-session"),
              {
                providerItemId: `msg_${providerTurnId}`,
                providerTurnId,
                kind: "assistant-message",
                status: "completed",
                title: null,
                text: "eu-west is the outlier.",
                data: null,
              },
            ],
          },
        ];
        const landed = yield* conversation.backfillConversation(
          TERMINAL,
          TERMINAL_PROCESS,
          history("native:u1"),
        );
        const again = yield* conversation.backfillConversation(
          TERMINAL,
          TERMINAL_PROCESS,
          history("native:u1"),
        );
        const later = yield* conversation.backfillConversation(
          TERMINAL,
          TERMINAL_PROCESS,
          history("native:u2"),
        );
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ provider_item_id: string; kind: string; turn_id: string }>`
          SELECT provider_item_id, kind, turn_id FROM agent_items
          WHERE session_id = ${TERMINAL} ORDER BY seq`;
        return { published, before, landed, again, later, rows };
      }),
    );
    expect(result.before).toEqual([]);
    expect([result.landed, result.again, result.later]).toEqual([1, 0, 1]);
    expect(result.rows.map((row) => row.provider_item_id)).toEqual([
      "toolu_native:u1",
      `mend-page:${result.published.id}`,
      "toolu_forged_native:u1",
      "msg_native:u1",
      "toolu_native:u2",
      "toolu_forged_native:u2",
      "msg_native:u2",
    ]);
    expect(result.rows[1]?.turn_id).toBe(result.rows[0]?.turn_id);
  });

  it("reads a page's metadata alone, without its body", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pages = yield* SessionPagesRepo;
        const [listed] = yield* pages.listForSession(TERMINAL);
        if (listed === undefined) return yield* Effect.die("no page");
        return {
          listed,
          ref: yield* pages.refById(listed.id),
          missing: yield* pages.refById(PageId.make("page-nowhere")),
        };
      }),
    );
    expect(result.ref).toEqual(result.listed);
    expect(Object.keys(result.ref ?? {}).toSorted()).toEqual([
      "height",
      "id",
      "publishedAt",
      "sessionId",
      "title",
    ]);
    expect(result.missing).toBeNull();
  });

  it("goes with its session", async () => {
    const left = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM agent_sessions WHERE id = ${PROTOCOL}`;
        return yield* sql<{ pages: string; items: string }>`
          SELECT (SELECT count(*) FROM session_pages WHERE session_id = ${PROTOCOL})::text AS pages,
                 (SELECT count(*) FROM agent_items WHERE session_id = ${PROTOCOL})::text AS items`;
      }),
    );
    expect(left).toEqual([{ pages: "0", items: "0" }]);
  });
});
