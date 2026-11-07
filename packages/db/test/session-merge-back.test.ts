import { PgClient } from "@effect/sql-pg";
import { SessionId, SessionProcessId } from "@mend/domain";
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
    const timestamp = new Date().toISOString();
    const selection = { harness: "codex", model: null, effort: null, interactionMode: "default" };
    const observation = {
      kind: "ready",
      boundary: {
        id: name,
        sessionId: parent,
        revision: 0,
        anchor: { kind: "threadStart" },
        checkpointId: `${name}-cp`,
        checkpointSha: "b".repeat(40),
        nativeSeedId: name,
        selection,
        gitHead: "a".repeat(40),
        reviewBase: { sha: "a".repeat(40), ref: "main" },
        repositorySeed: null,
        observedAt: timestamp,
        nativeObservedAt: timestamp,
        record: { runId: "run", seq: "0" },
      },
    };
    const file = {
      relativePath: ".codex/sessions/native.jsonl",
      sha256: "c".repeat(64),
      byteLength: 1,
    };
    const seed = {
      id: name,
      format: 1,
      providerVersion: "0.162.1",
      cutoff: {
        provider: "codex",
        threadId: "native",
        throughTurnId: "native-turn",
        historyMode: "paginated",
      },
      selectedFile: file,
      files: [file],
      manifestDigest: "c".repeat(64),
    };
    yield* sql`INSERT INTO session_native_seeds (id,manifest) VALUES (${name},${JSON.stringify(seed)}::jsonb)`;
    yield* sql`INSERT INTO session_turn_boundaries (id,session_id,seed_id,observation) VALUES (${name},${parent},${name},${JSON.stringify(observation)}::jsonb)`;
    const operation = {
      id: name,
      actorId: "alice",
      commandId: name,
      intentDigest: "b".repeat(64),
      request: { sourceSessionId: parent, at: { kind: "latestStable" }, title: null },
      intent: {
        kind: "fork",
        projectId: name,
        title: "Fork",
        sourceBoundaryId: name,
        childSessionId: child,
        childWorktreeId: child,
      },
      progress: { kind: "complete", providerSessionId: "child-native" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    yield* sql`INSERT INTO session_history_operations (id,organization_id,actor_id,command_id,intent_digest,operation)
    VALUES (${name},(SELECT id FROM organizations LIMIT 1),'alice',${name},${"b".repeat(64)},${JSON.stringify(operation)}::jsonb || jsonb_build_object('organizationId',(SELECT id FROM organizations LIMIT 1)))`;
    const provenance = {
      childSessionId: child,
      sourceSessionId: parent,
      rootSessionId: parent,
      sourceBoundaryId: name,
      sourceTurnId: null,
      sourceCheckpointId: `${name}-cp`,
      sourceNativeSeedId: name,
      inheritedViewDigest: "d".repeat(64),
      requestedBy: "alice",
      requestedAt: timestamp,
    };
    const inherited = [
      {
        sourceSessionId: parent,
        sourceTurnId: "inherited",
        ordinal: 0,
        author: "alice",
        input: "INHERITED_SECRET",
        status: "completed",
        selection,
        createdAt: timestamp,
        endedAt: timestamp,
        items: [],
      },
    ];
    yield* sql`INSERT INTO session_forks (child_session_id,operation_id,source_boundary_id,seed_id,provenance,inherited_history)
    VALUES (${child},${name},${name},${name},${JSON.stringify(provenance)}::jsonb,${JSON.stringify(inherited)}::jsonb)`;
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
        yield* sql`UPDATE agent_sessions SET shared_control_enabled_at=now(),shared_control_enabled_by_user_id='alice' WHERE id=${f.parent}`;
        expect((yield* repo.mergeBack({ ...f.request, actorId: "bob" })).requestedBy).toBe("bob");
        yield* sql`UPDATE agent_sessions SET shared_control_enabled_at=NULL,shared_control_enabled_by_user_id=NULL WHERE id=${f.parent}`;
        expect(
          (yield* repo.mergeBack({ ...f.request, actorId: "bob" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    );
  });
  it("selects the historical child cutoff and excludes withdrawn and inherited history", async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* pair("cutoff");
        const sql = yield* SqlClient.SqlClient;
        const turns = yield* AgentConversationRepo;
        const later = yield* turns.submitTurn(
          f.child,
          SessionProcessId.make("cutoff-child-process"),
          "LATER_SECRET",
          "alice",
        );
        yield* sql`UPDATE agent_turns SET status='completed',ended_at=now() WHERE id=${later.id}`;
        const repo = yield* SessionHistoryRepo;
        const selected = yield* repo.mergeBack(f.request);
        expect(selected.summary).toContain("amber");
        expect(selected.summary).not.toContain("LATER_SECRET");
        expect(selected.summary).not.toContain("INHERITED_SECRET");
        const latest = yield* repo.mergeBack({
          ...f.request,
          commandId: "cutoff-latest",
          at: { kind: "latestStable" },
        });
        expect(latest.summary).toContain("LATER_SECRET");
        yield* sql`UPDATE agent_turns SET withdrawn_history_revision=1,withdrawn_by_operation_id='cutoff' WHERE id=${later.id}`;
        const withdrawn = yield* repo
          .mergeBack({
            ...f.request,
            commandId: "cutoff-withdrawn",
            at: { kind: "turn", turnId: later.id },
          })
          .pipe(Effect.result);
        expect(withdrawn._tag).toBe("Failure");
        expect(
          (yield* repo.mergeBackTransfers(f.parent))
            .filter((row) => row.state.kind === "pending")
            .map((row) => row.id),
        ).toEqual([latest.id]);
      }),
    );
  });

  it("waits through a running turn and a cancelled queued message, then survives Stop and Resume", async () => {
    const saved = await run(
      Effect.gen(function* () {
        const f = yield* pair("resume");
        const turns = yield* AgentConversationRepo;
        const running = yield* turns.submitTurn(f.parent, f.process, "already running", "alice");
        yield* turns.claimNextTurn(f.process, newAttempt());
        const repo = yield* SessionHistoryRepo;
        const transfer = yield* repo.mergeBack(f.request);
        yield* turns.submitTurn(f.parent, f.process, "cancel this queued message", "alice");
        expect(yield* turns.claimNextTurn(f.process, newAttempt())).toBeNull();
        yield* turns.cancelOpenForProcess(f.process);
        expect((yield* repo.mergeBackTransfers(f.parent))[0]?.state.kind).toBe("pending");
        expect((yield* turns.byTurnId(running.id))?.mergeBack).toEqual([]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE session_processes SET status='exited',exited_at=now() WHERE id=${f.process}`;
        yield* sql`UPDATE agent_sessions SET status='stopped' WHERE id=${f.parent}`;
        return { f, transfer };
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const process = SessionProcessId.make("resumed-process");
        yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status) VALUES (${process},${saved.f.parent},'resumed-ws','agent-protocol','codex','running')`;
        const turns = yield* AgentConversationRepo;
        yield* turns.submitTurn(saved.f.parent, process, "next after resume", "bob");
        expect(
          (yield* turns.claimNextTurn(process, newAttempt()))?.mergeBack.map((row) => row.id),
        ).toEqual([saved.transfer.id]);
      }),
    );
  });

  it("keeps assigned context on a definitely unsent turn when the login changes", async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* pair("put-back");
        const repo = yield* SessionHistoryRepo;
        const transfer = yield* repo.mergeBack(f.request);
        const turns = yield* AgentConversationRepo;
        yield* turns.submitTurn(f.parent, f.process, "next", "bob");
        const attempt = newAttempt();
        const first = yield* turns.claimNextTurn(f.process, attempt);
        expect(first?.mergeBack[0]?.id).toBe(transfer.id);
        yield* turns.putBackOwn({ sessionId: f.parent, processId: f.process, attempt });
        const retry = yield* turns.claimNextTurn(f.process, newAttempt());
        expect(retry?.mergeBack).toEqual(first?.mergeBack);
        expect(retry?.author).toBe("bob");
      }),
    );
  });

  it("retains transferred context after deleting its source, and fences new transfers during Undo", async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* pair("delete");
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* SessionHistoryRepo;
        const transfer = yield* repo.mergeBack(f.request);
        yield* sql`UPDATE worktrees SET history_operation_id='delete' WHERE id=${f.parent}`;
        expect(
          (yield* repo.mergeBack({ ...f.request, commandId: "held" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        // Replays remain the same receipt, even while a later operation holds the worktree.
        expect(yield* repo.mergeBack(f.request)).toEqual(transfer);
        yield* sql`UPDATE worktrees SET history_operation_id=NULL WHERE id=${f.parent}`;
        yield* sql`DELETE FROM agent_sessions WHERE id=${f.child}`;
        const turns = yield* AgentConversationRepo;
        yield* turns.submitTurn(f.parent, f.process, "use saved context", "alice");
        expect(
          (yield* turns.claimNextTurn(f.process, newAttempt()))?.mergeBack[0]?.summary,
        ).toEqual(transfer.summary);
        expect((yield* repo.read(f.parent)).mergeBack?.[0]?.state.kind).toBe("consumed");
      }),
    );
  });

  it("refuses a removed project, a wrong parent and changed command input", async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* pair("scope");
        const repo = yield* SessionHistoryRepo;
        expect(
          (yield* repo.mergeBack({ ...f.request, targetSessionId: f.child }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        yield* repo.mergeBack(f.request);
        expect(
          (yield* repo
            .mergeBack({ ...f.request, at: { kind: "latestStable" } })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projects SET removed_at=now(),removed_by_user_id='alice',removal_phase='removed',removal_id='removed',removal_since=now() WHERE id='scope'`;
        expect((yield* repo.mergeBack(f.request).pipe(Effect.result))._tag).toBe("Failure");
      }),
    );
  });

  it("snapshots a selected response that is waiting for a person, as the pinned client offers", async () => {
    await run(
      Effect.gen(function* () {
        const f = yield* pair("waiting");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_turns SET status='running',ended_at=NULL WHERE id=${f.selected.id}`;
        yield* sql`INSERT INTO agent_requests (id,session_id,process_id,turn_id,kind,provider_request_id,title)
        VALUES ('waiting-request',${f.child},'waiting-child-process',${f.selected.id},'user-input','question','Which option should I use?')`;
        const transfer = yield* (yield* SessionHistoryRepo).mergeBack(f.request);
        expect(transfer.sourceTurnId).toBe(f.selected.id);
        expect(transfer.summary).toContain("Which option should I use?");
        const [request] = yield* sql`SELECT status FROM agent_requests WHERE id='waiting-request'`;
        expect(request?.status).toBe("pending");
      }),
    );
  });
});
