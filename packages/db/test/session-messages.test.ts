import { PgClient } from "@effect/sql-pg";
import { ClientMessageId, SessionId, SessionProcessId } from "@mend/domain";
import { TURN_DELIVERY_UNCONFIRMED } from "@mend/domain/workbench";
import {
  DEFAULT_MESSAGE_SETTINGS,
  MessageInput,
  MessageSettings,
  type SendMessageInput,
} from "@mend/domain/workbench";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MendDB, MendDBLive, type MendDatabase } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
} from "../src/repos/agent-conversation.ts";
import { MessageSettingsRepo, MessageSettingsRepoLive } from "../src/repos/message-settings.ts";
import { newAttempt, sendNext } from "./dispatch.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_message_repo_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(url.toString()) });
const reposLayer = Layer.mergeAll(AgentConversationRepoLive, MessageSettingsRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const withConversation = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    AgentConversationRepo | MessageSettingsRepo | MendDB | SqlClient.SqlClient | PgClient.PgClient
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));
const ConstraintDiagnostic = Schema.Struct({ constraint: Schema.String });
const refusedBy = (statement: Effect.Effect<unknown, SqlError>) =>
  statement.pipe(
    Effect.flip,
    Effect.map(
      (error) => Schema.decodeUnknownSync(ConstraintDiagnostic)(error.reason.cause).constraint,
    ),
  );
let created = false;

const runningTurn = Effect.gen(function* () {
  const repo = yield* AgentConversationRepo;
  const session = SessionId.make("sess-codex");
  const process = SessionProcessId.make("p-codex-1");
  const turn = yield* repo.submitTurn(session, process, "start", "user-1");
  yield* sendNext(session, process, "native");
  return { session, process, turn };
});

const request = (sessionId: SessionId): SendMessageInput => ({
  sessionId,
  sender: "user-1",
  input: MessageInput.make("  exact words\n"),
  clientMessageId: ClientMessageId.make(crypto.randomUUID()),
  intent: "default",
});

describe.skipIf(postgres.skip)("message admission and settings against current migrations", () => {
  beforeEach(async () => {
    created = false;
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${database}`);
        created = true;
      }),
    );
    await withConversation(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        for (const user of ["user-1", "user-2", "user-3", "user-race", "u-maria", "u-payer"])
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
          VALUES (${user}, ${user}, ${`${user}@example.invalid`}, '2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id)
        VALUES ('proj-1','fixture','/store/fixture/repo.git','main',(SELECT id FROM organizations LIMIT 1),'user-1')`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
        VALUES ('wt-1','proj-1','fixture','fixture','mend/fixture',${"a".repeat(40)})`;
        yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
        VALUES ('sess-codex','proj-1','wt-1','user-1','codex','fixture','mend/fixture',${"a".repeat(40)},'running')`;
        yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status)
        VALUES ('p-codex-1','sess-codex','ws-1','agent-protocol','codex','running')`;
      }),
    );
  });
  afterEach(async () => {
    if (!created) return;
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
      }),
    );
  });

  it("keeps defaults read-only, isolates accounts, and saves concurrent settings", async () => {
    await withConversation(
      Effect.gen(function* () {
        const settings = yield* MessageSettingsRepo;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* settings.forUser("user-1")).toEqual(DEFAULT_MESSAGE_SETTINGS);
        expect(yield* sql`SELECT * FROM user_message_settings`).toEqual([]);
        const off = new MessageSettings({ sendSteersRunningTurn: false });
        expect(yield* settings.set("user-1", off)).toEqual(off);
        expect(yield* settings.forUser("user-2")).toEqual(DEFAULT_MESSAGE_SETTINGS);
        yield* Effect.all(
          [settings.set("user-1", off), settings.set("user-1", DEFAULT_MESSAGE_SETTINGS)],
          { concurrency: "unbounded" },
        );
        expect(yield* sql`SELECT user_id FROM user_message_settings`).toHaveLength(1);
        yield* settings.set("user-1", DEFAULT_MESSAGE_SETTINGS);
        expect(yield* settings.forUser("user-1")).toEqual(DEFAULT_MESSAGE_SETTINGS);
      }),
    );
  });

  it("deletes a person's setting with their account", async () => {
    await withConversation(
      Effect.gen(function* () {
        const settings = yield* MessageSettingsRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* settings.set("user-3", new MessageSettings({ sendSteersRunningTurn: false }));
        yield* sql`DELETE FROM "user" WHERE id = 'user-3'`;
        expect(
          yield* sql`SELECT user_id FROM user_message_settings WHERE user_id = 'user-3'`,
        ).toEqual([]);
      }),
    );
  });

  it("binds concurrent opposite choices once and compares exact words, session and intent", async () => {
    await withConversation(
      Effect.gen(function* () {
        const { session, process, turn } = yield* runningTurn;
        const repo = yield* AgentConversationRepo;
        const sql = yield* SqlClient.SqlClient;
        const input = request(session);
        const admissions = yield* Effect.all(
          [
            repo.admitSteerMessage(input, turn.id),
            repo.admitTurnMessage(input, process, "no-own-running-turn"),
          ],
          { concurrency: "unbounded" },
        );
        expect(admissions.filter((entry) => entry._tag !== "Replay")).toHaveLength(1);
        expect(admissions[0]?.result).toEqual(admissions[1]?.result);
        expect(yield* sql`SELECT id FROM session_messages`).toHaveLength(1);
        const turns = yield* repo.listConversationTurns(session);
        expect(turns.length + turns.flatMap((entry) => entry.steers).length).toBe(2);
        for (const changed of [
          { ...input, input: MessageInput.make("exact words") },
          { ...input, sessionId: SessionId.make("another-session") },
          { ...input, intent: "queue" as const },
        ])
          expect(yield* repo.messageByClientId(changed).pipe(Effect.flip)).toMatchObject({
            _tag: "MessageKeyConflictError",
          });
        if (input.clientMessageId === null) return yield* Effect.die("missing key");
        expect(
          yield* repo.messageByClientId({
            ...input,
            clientMessageId: ClientMessageId.make(input.clientMessageId.toUpperCase()),
          }),
        ).toEqual(admissions[0]?.result);
        const other = yield* repo.admitTurnMessage(
          { ...input, sender: "user-2" },
          process,
          "no-own-running-turn",
        );
        expect(other._tag).toBe("Created");
        for (let i = 0; i < 2; i++)
          expect(
            (yield* repo.admitTurnMessage(
              { ...input, clientMessageId: null },
              process,
              "no-own-running-turn",
            ))._tag,
          ).toBe("Created");
        expect(yield* sql`SELECT id FROM session_messages`).toHaveLength(4);
      }),
    );
  });

  it("rolls back the target if the binding insert fails and enforces one target", async () => {
    await withConversation(
      Effect.gen(function* () {
        const { session, process, turn } = yield* runningTurn;
        const repo = yield* AgentConversationRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE FUNCTION reject_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'binding refused'; END $$`;
        yield* sql`CREATE TRIGGER reject_message BEFORE INSERT ON session_messages FOR EACH ROW EXECUTE FUNCTION reject_message()`;
        const input = request(session);
        expect(
          (yield* repo.admitTurnMessage(input, process, "queue-requested").pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* repo.messageByClientId(input)).toBeNull();
        expect(yield* repo.listTurns(session)).toHaveLength(1);
        yield* sql`DROP TRIGGER reject_message ON session_messages`;
        const admitted = yield* repo.admitSteerMessage(input, turn.id);
        expect(admitted._tag).toBe("Created");
        expect(
          yield* refusedBy(
            sql`UPDATE session_messages SET turn_id = ${turn.id}, turn_reason = 'queue-requested'`,
          ),
        ).toBe("session_messages_target_check");
        expect(yield* refusedBy(sql`UPDATE session_messages SET steer_id = NULL`)).toBe(
          "session_messages_target_check",
        );
      }),
    );
  });

  it("replays current evidence after stop and restart without reviving a turn", async () => {
    await withConversation(
      Effect.gen(function* () {
        const { session, process, turn } = yield* runningTurn;
        const repo = yield* AgentConversationRepo;
        const sql = yield* SqlClient.SqlClient;
        const input = request(session);
        const original = yield* repo.admitSteerMessage(input, turn.id);
        yield* repo.recoverSendingSteers(process);
        const replay = yield* repo.messageByClientId(input);
        expect(replay).toMatchObject({
          _tag: "Steer",
          messageId: original.result.messageId,
          steer: { input: input.input, delivery: { _tag: "Unknown", reason: "restart" } },
        });
        const next = request(session);
        const queued = yield* repo.admitTurnMessage(next, process, "no-own-running-turn");
        if (queued.result._tag !== "Turn") return yield* Effect.die("expected turn");
        yield* repo.cancelOpenForTurn(queued.result.turn.id);
        yield* sql`UPDATE agent_sessions SET settled_at = now() WHERE id = ${session}`;
        expect(yield* repo.admitSteerMessage(next, turn.id)).toMatchObject({
          _tag: "Replay",
          result: {
            _tag: "Turn",
            messageId: queued.result.messageId,
            turn: { status: "cancelled" },
          },
        });
        expect(
          yield* repo.admitSteerMessage(request(session), turn.id).pipe(Effect.flip),
        ).toMatchObject({ _tag: "SessionStoppingError" });
      }),
    );
  });

  it("keeps a commit whose acknowledgement was lost as this request's own", async () => {
    await withConversation(
      Effect.gen(function* () {
        const { session, process } = yield* runningTurn;
        const client = yield* MendDB;
        const sql = yield* SqlClient.SqlClient;
        const lostAck = new Proxy(client, {
          get(target, property, receiver) {
            if (property !== "transaction") return Reflect.get(target, property, receiver);
            return (...args: Parameters<MendDatabase["transaction"]>) =>
              target.transaction(...args).pipe(
                Effect.andThen(
                  Effect.fail(
                    new SqlError({
                      reason: new ConnectionError({
                        cause: new Error("connection dropped"),
                        message: "commit acknowledgement lost",
                      }),
                    }),
                  ),
                ),
              );
          },
        });
        const admit = (input: SendMessageInput) =>
          Effect.flatMap(AgentConversationRepo, (repo) =>
            repo.admitTurnMessage(input, process, "queue-requested"),
          ).pipe(
            // Without a local memo map, provide reuses the outer repo built on the real MendDB.
            Effect.provide(AgentConversationRepoLive, { local: true }),
            Effect.provideService(MendDB, lostAck),
          );
        for (const input of [request(session), { ...request(session), clientMessageId: null }])
          expect(yield* admit(input)).toMatchObject({
            _tag: "Created",
            result: { _tag: "Turn", turn: { input: input.input, status: "queued" } },
          });
        expect(yield* sql`SELECT id FROM session_messages`).toHaveLength(2);
        expect(yield* (yield* AgentConversationRepo).listTurns(session)).toHaveLength(3);
      }),
    );
  });

  it("keeps a committed message as this request's own when its notification fails", async () => {
    await withConversation(
      Effect.gen(function* () {
        const { session, process, turn } = yield* runningTurn;
        const pg = yield* PgClient.PgClient;
        const noNotify = new Proxy(pg, {
          apply(target, thisArg, args: Parameters<typeof pg>) {
            const [strings] = args;
            if (Array.isArray(strings) && strings.join("").includes("pg_notify"))
              return Effect.fail(
                new SqlError({
                  reason: new ConnectionError({
                    cause: new Error("connection dropped"),
                    message: "notify failed",
                  }),
                }),
              );
            return Reflect.apply(target, thisArg, args);
          },
        });
        const withoutNotify = <A, E>(effect: Effect.Effect<A, E, AgentConversationRepo>) =>
          effect.pipe(
            Effect.provide(AgentConversationRepoLive, { local: true }),
            Effect.provideService(PgClient.PgClient, noNotify),
          );
        expect(
          yield* withoutNotify(
            Effect.flatMap(AgentConversationRepo, (repo) =>
              repo.admitSteerMessage(request(session), turn.id),
            ),
          ),
        ).toMatchObject({ _tag: "Created", result: { _tag: "Steer" } });
        expect(
          yield* withoutNotify(
            Effect.flatMap(AgentConversationRepo, (repo) =>
              repo.admitTurnMessage(request(session), process, "queue-requested"),
            ),
          ),
        ).toMatchObject({ _tag: "Created", result: { _tag: "Turn" } });
      }),
    );
  });

  it("settles an unconfirmed turn when its notification fails after the update", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const session = SessionId.make("sess-codex");
        const process = SessionProcessId.make("p-codex-1");
        const turn = yield* repo.submitTurn(session, process, "start", "user-1");
        yield* repo.claimNextTurn(process, newAttempt());
        const pg = yield* PgClient.PgClient;
        const noNotify = new Proxy(pg, {
          apply(target, thisArg, args: Parameters<typeof pg>) {
            const [strings] = args;
            if (Array.isArray(strings) && strings.join("").includes("pg_notify"))
              return Effect.fail(
                new SqlError({
                  reason: new ConnectionError({
                    cause: new Error("connection dropped"),
                    message: "notify failed",
                  }),
                }),
              );
            return Reflect.apply(target, thisArg, args);
          },
        });
        const settled = yield* Effect.flatMap(AgentConversationRepo, (conversations) =>
          conversations.failUnconfirmedTurn(turn.id),
        ).pipe(
          Effect.provide(AgentConversationRepoLive, { local: true }),
          Effect.provideService(PgClient.PgClient, noNotify),
        );
        expect(settled).toMatchObject({ status: "failed", error: TURN_DELIVERY_UNCONFIRMED });
        expect(yield* repo.byTurnId(turn.id)).toMatchObject({ status: "failed" });
      }),
    );
  });

  it("never withdraws a turn a successor claimed or moved", async () => {
    await withConversation(
      Effect.gen(function* () {
        const { session, process } = yield* runningTurn;
        const repo = yield* AgentConversationRepo;
        const sql = yield* SqlClient.SqlClient;
        const a = yield* repo.admitTurnMessage(request(session), process, "queue-requested");
        if (a.result._tag !== "Turn") return yield* Effect.die("expected turn");
        yield* sql`INSERT INTO session_processes (id, session_id, sealant_workspace_id, kind, harness, status) VALUES ('next', ${session}, 'ws-1', 'agent-protocol', 'codex', 'running')`;
        const next = SessionProcessId.make("next");
        yield* repo.requeueQueuedTurns(process, next);
        expect(yield* repo.withdrawMessageTurn(a.result.turn.id, process)).toBe(false);
        expect(yield* repo.byTurnId(a.result.turn.id)).toMatchObject({
          status: "queued",
          processId: next,
        });
        yield* repo.claimNextTurn(next, newAttempt());
        expect(yield* repo.withdrawMessageTurn(a.result.turn.id, next)).toBe(false);
        expect(yield* repo.byTurnId(a.result.turn.id)).toMatchObject({ status: "running" });
        const b = yield* repo.admitTurnMessage(request(session), process, "queue-requested");
        if (b.result._tag !== "Turn") return yield* Effect.die("expected turn");
        expect(yield* repo.withdrawMessageTurn(b.result.turn.id, process)).toBe(true);
        expect(yield* repo.messageById(b.result.messageId)).toMatchObject({
          turn: { status: "cancelled", input: "  exact words\n" },
        });
      }),
    );
  });
});
