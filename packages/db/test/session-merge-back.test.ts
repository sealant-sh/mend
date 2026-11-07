import { PgClient } from "@effect/sql-pg";
import { AgentTurnId, SessionId, SessionProcessId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
} from "../src/repos/agent-conversation.ts";
import { SessionHistoryRepo, SessionHistoryRepoLive } from "../src/repos/session-history.ts";
import { newAttempt } from "./dispatch.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_merge_back_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const connection = PgClient.layer({ url: Redacted.make(url.toString()) });
const layer = Layer.mergeAll(
  SessionHistoryRepoLive,
  AgentConversationRepoLive.pipe(Layer.provide(MendDBLive)),
).pipe(Layer.provideMerge(connection));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    SessionHistoryRepo | AgentConversationRepo | PgClient.PgClient | SqlClient.SqlClient
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
let created = false;

const pair = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const parent = SessionId.make(`${name}-parent`);
    const child = SessionId.make(`${name}-child`);
    const process = SessionProcessId.make(`${name}-process`);
    yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id,visibility)
    VALUES (${name},${name},${`/unused/${name}`},'main',(SELECT id FROM organizations LIMIT 1),'alice','shared')`;
    for (const id of [parent, child]) {
      yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES (${id},${name},${id},${id},${`mend/${id}`},${"a".repeat(40)})`;
      yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
      VALUES (${id},${name},${id},'alice','codex',${id},${`mend/${id}`},${"a".repeat(40)},'completed')`;
    }
    yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status) VALUES (${process},${parent},'ws','agent-protocol','codex','running')`;
    yield* sql`INSERT INTO session_native_seeds (id,manifest) VALUES (${name},${JSON.stringify({ id: name, format: 1 })}::jsonb)`;
    yield* sql`INSERT INTO session_turn_boundaries (id,session_id,seed_id,observation) VALUES (${name},${parent},${name},${JSON.stringify({ kind: "ready", boundary: { id: name, sessionId: parent, nativeSeedId: name } })}::jsonb)`;
    const operation = {
      id: name,
      actorId: "alice",
      commandId: name,
      intentDigest: "b".repeat(64),
      intent: { kind: "fork", childSessionId: child },
      progress: { kind: "complete" },
    };
    yield* sql`INSERT INTO session_history_operations (id,organization_id,actor_id,command_id,intent_digest,operation)
    VALUES (${name},(SELECT id FROM organizations LIMIT 1),'alice',${name},${"b".repeat(64)},${JSON.stringify(operation)}::jsonb || jsonb_build_object('organizationId',(SELECT id FROM organizations LIMIT 1)))`;
    yield* sql`INSERT INTO session_forks (child_session_id,operation_id,source_boundary_id,seed_id,provenance,inherited_history)
    VALUES (${child},${name},${name},${name},${JSON.stringify({ childSessionId: child, sourceSessionId: parent })}::jsonb,'[]'::jsonb)`;
    const childProcess = SessionProcessId.make(`${name}-child-process`);
    yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status) VALUES (${childProcess},${child},'child-ws','agent-protocol','codex','running')`;
    const turns = yield* AgentConversationRepo;
    const selected = yield* turns.submitTurn(child, childProcess, "remember amber", "alice");
    yield* sql`UPDATE agent_turns SET status='completed',ended_at=now() WHERE id=${selected.id}`;
    yield* sql`INSERT INTO agent_items (id,session_id,process_id,turn_id,seq,provider_item_id,provider_output_process_id,provider_output_seq,provider_event_index,kind,status,text)
    VALUES (${`${name}-answer`},${child},${childProcess},${selected.id},1,'answer',${childProcess},1,0,'assistant-message','completed','amber is the fork result')`;
    return {
      parent,
      child,
      process,
      selected,
      request: {
        actorId: "alice",
        commandId: `${name}-merge`,
        sourceSessionId: child,
        targetSessionId: parent,
        at: { kind: "turn" as const, turnId: selected.id },
      },
    };
  });

describe.skipIf(postgres.skip)("durable merge-back context and ordinary turn admission", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)).pipe(
        Effect.provide(admin),
        Effect.scoped,
      ),
    );
    created = true;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        for (const id of ["alice", "bob", "outsider"])
          yield* sql`INSERT INTO "user" (id,name,email,"createdAt") VALUES (${id},${id},${`${id}@example.invalid`},now())`;
        for (const id of ["alice", "bob"])
          yield* sql`INSERT INTO organization_members (organization_id,user_id,role) VALUES ((SELECT id FROM organizations LIMIT 1),${id},'member')`;
      }),
    );
  });
  afterAll(async () => {
    if (created)
      await Effect.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`),
        ).pipe(Effect.provide(admin), Effect.scoped),
      );
  });

  it("saves only the selected child's delta and consumes it on one ordinary parent turn", async () => {
    const saved = await run(
      Effect.gen(function* () {
        const f = yield* pair("consume");
        const repo = yield* SessionHistoryRepo;
        const receipt = yield* repo.mergeBack(f.request);
        expect(receipt.summary).toContain("amber is the fork result");
        expect(receipt.state).toEqual({ kind: "pending" });
        expect(yield* (yield* AgentConversationRepo).listTurns(f.parent)).toEqual([]);
        return { f, receipt };
      }),
    );
    // A new layer/connection models a server restart with no in-memory transfer state.
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const first = yield* repo.submitTurn(
          saved.f.parent,
          saved.f.process,
          "use the result",
          "bob",
        );
        const attempt = newAttempt();
        const claimed = yield* repo.claimNextTurn(saved.f.process, attempt);
        expect(claimed?.input).toBe("use the result");
        expect(claimed?.author).toBe("bob");
        expect(claimed?.mergeBack).toHaveLength(1);
        expect(claimed?.mergeBack[0]?.id).toBe(saved.receipt.id);
        yield* repo.failTurn(first.id, "fixture ended");
        yield* repo.submitTurn(saved.f.parent, saved.f.process, "next", "bob");
        expect((yield* repo.claimNextTurn(saved.f.process, newAttempt()))?.mergeBack).toEqual([]);
      }),
    );
  });

  it("replays the same command, supersedes a newer selection and retains the saved cutoff", async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* pair("replace");
        const repo = yield* SessionHistoryRepo;
        const old = yield* repo.mergeBack(f.request);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_items SET text='later edit' WHERE turn_id=${f.selected.id}`;
        expect((yield* repo.mergeBack(f.request)).summary).toBe(old.summary);
        const newer = yield* repo.mergeBack({ ...f.request, commandId: "replace-new" });
        expect(newer.summary).toContain("later edit");
        const transfers = yield* repo.mergeBackTransfers(f.parent);
        expect(transfers.find((t) => t.id === old.id)?.state.kind).toBe("superseded");
        expect(transfers.filter((t) => t.state.kind === "pending")).toHaveLength(1);
        expect(
          (yield* repo.mergeBack({ ...f.request, targetSessionId: f.child }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      }),
    );
  });

  it("requires visible child history and current parent control, including for a retry", async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* pair("rights");
        const repo = yield* SessionHistoryRepo;
        for (const actorId of ["bob", "outsider"])
          expect((yield* repo.mergeBack({ ...f.request, actorId }).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_sessions SET shared_control_enabled_at=now() WHERE id=${f.parent}`;
        expect((yield* repo.mergeBack({ ...f.request, actorId: "bob" })).requestedBy).toBe("bob");
        yield* sql`UPDATE agent_sessions SET shared_control_enabled_at=NULL WHERE id=${f.parent}`;
        expect(
          (yield* repo.mergeBack({ ...f.request, actorId: "bob" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    );
  });
});
