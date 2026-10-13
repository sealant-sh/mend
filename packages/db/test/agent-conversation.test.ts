import { PgClient } from "@effect/sql-pg";
import { SessionId, SessionProcessId } from "@mend/domain";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
} from "../src/repos/agent-conversation.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_conversation_repo_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(url.toString()) });
const reposLayer = AgentConversationRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const withConversation = <A, E>(
  effect: Effect.Effect<A, E, AgentConversationRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));
let created = false;

const ConstraintDiagnostic = Schema.Struct({ code: Schema.String, constraint: Schema.String });
const foreignKeyRefusal = (statement: Effect.Effect<unknown, SqlError>) =>
  statement.pipe(
    Effect.flip,
    Effect.map((error) => Schema.decodeUnknownSync(ConstraintDiagnostic)(error.reason.cause)),
  );

describe.skipIf(postgres.skip)("conversation repository against current migrations", () => {
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

  it("preserves item id and seq through repository replay and cursor pagination", async () => {
    const result = await withConversation(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const sessionId = SessionId.make("sess-codex");
        const processId = SessionProcessId.make("p-codex-1");
        const turn = yield* conversation.submitTurn(sessionId, processId, "replay", "user-1");
        const running = yield* conversation.claimNextTurn(processId);
        if (running === null) return yield* Effect.die("turn was not claimed");
        const bound = yield* conversation.bindRunningProviderTurn(
          sessionId,
          processId,
          "provider-turn-repository",
        );
        if (bound?.id !== turn.id) return yield* Effect.die("provider turn was not bound");
        const secondTurn = yield* conversation.submitTurn(
          sessionId,
          processId,
          "queued second",
          "user-2",
        );
        const whileBusy = yield* conversation.claimNextTurn(processId);
        const first = yield* conversation.upsertItem({
          sessionId,
          processId,
          turnId: turn.id,
          providerItemId: "provider-item-repository",
          providerTurnId: "provider-turn-repository",
          providerOutputSeq: 10n,
          providerEventIndex: 0,
          kind: "assistant-message",
          status: "in-progress",
          title: null,
          text: "partial",
          data: null,
        });
        const updated = yield* conversation.upsertItem({
          sessionId,
          processId,
          turnId: turn.id,
          providerItemId: "provider-item-repository",
          providerTurnId: "provider-turn-repository",
          providerOutputSeq: 11n,
          providerEventIndex: 0,
          kind: "assistant-message",
          status: "completed",
          title: null,
          text: "final",
          data: null,
        });
        const replayed = yield* conversation.upsertItem({
          sessionId,
          processId,
          turnId: turn.id,
          providerItemId: "provider-item-repository",
          providerTurnId: "provider-turn-repository",
          providerOutputSeq: 11n,
          providerEventIndex: 0,
          kind: "assistant-message",
          status: "completed",
          title: null,
          text: "final",
          data: null,
        });
        const request = yield* conversation.openRequest({
          sessionId,
          processId,
          turnId: turn.id,
          providerRequestId: "provider-request-repository",
          providerTurnId: "provider-turn-repository",
          providerItemId: "provider-item-repository",
          kind: "command-approval",
          title: "pnpm test",
          detail: { command: ["pnpm", "test"] },
          questions: null,
        });
        const pendingBefore = yield* conversation.hasPendingRequests(sessionId);
        const resolved = yield* conversation.resolveRequest(
          request.id,
          { decision: "accept" },
          "user-2",
        );
        const pendingAfter = yield* conversation.hasPendingRequests(sessionId);
        const raceRequest = yield* conversation.openRequest({
          sessionId,
          processId,
          turnId: turn.id,
          providerRequestId: "provider-request-race",
          providerTurnId: "provider-turn-repository",
          providerItemId: null,
          kind: "tool-permission",
          title: "tool",
          detail: null,
          questions: null,
        });
        yield* conversation.prepareRequestResponse(
          raceRequest.id,
          { decision: "accept" },
          "user-race",
        );
        yield* conversation.cancelOpenForTurn(turn.id);
        const raceResolved = yield* conversation.completeRequestResponse(raceRequest.id);
        yield* conversation.completeTurn(
          "provider-turn-repository",
          sessionId,
          "completed",
          null,
          null,
        );
        const claimedSecond = yield* conversation.claimNextTurn(processId);
        const deliveryRequest = yield* conversation.openRequest({
          sessionId,
          processId,
          turnId: secondTurn.id,
          providerRequestId: "provider-request-delivery",
          providerTurnId: "provider-turn-delivery",
          providerItemId: null,
          kind: "tool-permission",
          title: "tool",
          detail: null,
          questions: null,
        });
        yield* conversation.prepareRequestResponse(
          deliveryRequest.id,
          { decision: "accept" },
          "user-3",
        );
        yield* conversation.failRequestResponse(deliveryRequest.id);
        yield* conversation.cancelOpenForProcess(processId);
        const cancelledDecision = yield* conversation.byRequestId(deliveryRequest.id);
        const systemTurn = yield* conversation.submitTurn(
          sessionId,
          processId,
          "follow-up",
          null,
          "follow-up:1",
        );
        const replayedSystemTurn = yield* conversation.submitTurn(
          sessionId,
          processId,
          "follow-up",
          null,
          "follow-up:1",
        );
        return {
          first,
          updated,
          replayed,
          secondTurn,
          whileBusy,
          claimedSecond,
          pendingBefore,
          pendingAfter,
          resolved,
          raceResolved,
          cancelledDecision,
          systemTurn,
          replayedSystemTurn,
          page: yield* conversation.listItems(sessionId, first.seq, 100),
          after: yield* conversation.listItems(sessionId, updated.seq, 100),
          turnMessages: yield* conversation.turnMessages(turn.id),
          secondTurnMessages: yield* conversation.turnMessages(secondTurn.id),
        };
      }),
    );
    expect(result.whileBusy).toBeNull();
    expect(result.claimedSecond?.id).toBe(result.secondTurn.id);
    expect(result.pendingBefore).toBe(true);
    expect(result.pendingAfter).toBe(false);
    expect(result.resolved.decidedBy).toBe("user-2");
    expect(result.raceResolved.status).toBe("resolved");
    expect(result.raceResolved.decision).toBe("accept");
    expect(result.cancelledDecision?.status).toBe("cancelled");
    expect(result.cancelledDecision?.decision).toBe("accept");
    expect(result.cancelledDecision?.decidedBy).toBe("user-3");
    expect(result.replayedSystemTurn.id).toBe(result.systemTurn.id);
    expect(result.updated.id).toBe(result.first.id);
    expect(result.updated.seq).toBeGreaterThan(result.first.seq);
    expect(result.replayed.id).toBe(result.updated.id);
    expect(result.replayed.seq).toBe(result.updated.seq);
    expect(result.replayed.text).toBe("final");
    expect(
      result.page.filter((item) => item.providerItemId === "provider-item-repository"),
    ).toHaveLength(1);
    expect(result.after).toEqual([]);
    // The turn's messages: the one message, once, at its latest text.
    expect(result.turnMessages.map((item) => [item.kind, item.text])).toEqual([
      ["assistant-message", "final"],
    ]);
    expect(result.secondTurnMessages).toEqual([]);
  });

  it("records a turn the harness opened, and sends a claimed unsent turn back to the queue", async () => {
    const result = await withConversation(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const sessionId = SessionId.make("sess-codex");
        const processId = SessionProcessId.make("p-codex-1");
        // This case creates the follow-up it claims, independently of replay tests.
        yield* conversation.submitTurn(sessionId, processId, "follow-up", null, "follow-up:1");
        const claimed = yield* conversation.claimNextTurn(processId);
        if (claimed === null) return yield* Effect.die("nothing to claim");
        const opened = yield* conversation.openHarnessTurn(
          sessionId,
          processId,
          "harness:init-1",
          'Dynamic workflow "tiny" completed',
          { userId: null, accountId: null, accountName: null },
        );
        const again = yield* conversation.openHarnessTurn(
          sessionId,
          processId,
          "harness:init-1",
          "ignored",
          { userId: null, accountId: null, accountName: "ignored" },
        );
        const sentBack = yield* conversation.byTurnId(claimed.id);
        const whileHarness = yield* conversation.claimNextTurn(processId);
        yield* conversation.completeTurn("harness:init-1", sessionId, "completed", null, null);
        const afterHarness = yield* conversation.claimNextTurn(processId);
        // Claimed again and refused by a busy harness: back in the queue, unsent.
        if (afterHarness !== null) yield* conversation.requeueClaimedTurn(afterHarness.id);
        const requeued = yield* conversation.byTurnId(claimed.id);
        const task = (status: "in-progress" | "completed", seq: bigint, taskId = "wf1") =>
          conversation.upsertItem({
            sessionId,
            processId,
            turnId: claimed.id,
            providerItemId: `task:${taskId}`,
            providerTurnId: "provider-turn-repository",
            providerOutputSeq: seq,
            providerEventIndex: 0,
            kind: "task",
            status,
            title: "Workflow tiny",
            text: null,
            data: { taskId, status: status === "completed" ? "completed" : "running" },
          });
        yield* task("in-progress", 20n);
        const tasksRunning = yield* conversation.taskActivity(processId);
        yield* task("completed", 21n);
        const tasksAfter = yield* conversation.taskActivity(processId);
        // A task the process never reported ending reads stopped once the process ends.
        const orphan = yield* task("in-progress", 22n, "wf2");
        yield* conversation.cancelOpenForProcess(processId);
        const [stopped] = (yield* conversation.listItems(sessionId, orphan.seq, 10)).filter(
          (item) => item.providerItemId === "task:wf2",
        );
        const tasksEnded = yield* conversation.taskActivity(processId);
        return {
          claimed,
          opened,
          again,
          sentBack,
          whileHarness,
          afterHarness,
          requeued,
          tasksRunning,
          tasksAfter,
          orphan,
          stopped,
          tasksEnded,
        };
      }),
    );
    expect(result.opened).toMatchObject({
      origin: "harness",
      author: null,
      input: 'Dynamic workflow "tiny" completed',
      status: "running",
      providerTurnId: "harness:init-1",
    });
    expect(result.opened?.ordinal).toBeGreaterThan(result.claimed.ordinal);
    expect(result.again?.id).toBe(result.opened?.id);
    // A replayed open keeps the payer the first one recorded.
    expect(result.again?.billedAccountName).toBeNull();
    expect(result.sentBack).toMatchObject({ status: "queued", startedAt: null });
    expect(result.whileHarness).toBeNull();
    expect(result.afterHarness?.id).toBe(result.claimed.id);
    expect(result.requeued).toMatchObject({ status: "queued", startedAt: null });
    expect(result.tasksRunning.running).toBe(1);
    expect(result.tasksRunning.lastUpdatedAt).toBeInstanceOf(Date);
    expect(result.tasksAfter.running).toBe(0);
    expect(result.stopped).toMatchObject({
      status: "completed",
      data: { taskId: "wf2", status: "stopped" },
    });
    expect(result.stopped?.seq).toBeGreaterThan(result.orphan.seq);
    expect(result.tasksEnded.running).toBe(0);
  });

  it("round-trips the turn payer independently of its author", async () => {
    const recorded = await withConversation(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const sql = yield* SqlClient.SqlClient;
        const sessionId = SessionId.make("sess-codex");
        const processId = SessionProcessId.make("p-codex-1");
        const turn = yield* conversation.submitTurn(sessionId, processId, "from Maria", "u-maria");
        const unsent = yield* conversation.byTurnId(turn.id);
        const billed = yield* conversation.setTurnPayer(turn.id, {
          userId: "u-payer",
          accountId: null,
          accountName: "default",
        });
        const read = yield* conversation.byTurnId(turn.id);
        return {
          unsent,
          billed,
          read,
          unknownPayer: yield* foreignKeyRefusal(
            sql`UPDATE agent_turns SET billed_user_id='u-nobody' WHERE id=${turn.id}`,
          ),
          deletePayer: yield* foreignKeyRefusal(sql`DELETE FROM "user" WHERE id='u-payer'`),
        };
      }),
    );
    expect(recorded.unsent).toMatchObject({
      billedUserId: null,
      billedAccountId: null,
      billedAccountName: null,
    });
    expect(recorded.read).toMatchObject({
      author: "u-maria",
      billedUserId: "u-payer",
      billedAccountId: null,
      billedAccountName: "default",
    });
    expect(recorded.billed.billedUserId).toBe("u-payer");
    // Historical 0107 proves introduction; these checks guard later current migrations too.
    expect(recorded.unknownPayer).toEqual({
      code: "23503",
      constraint: "agent_turns_billed_user_id_fkey",
    });
    expect(recorded.deletePayer).toEqual({
      code: "23503",
      constraint: "agent_turns_billed_user_id_fkey",
    });
  });
});
