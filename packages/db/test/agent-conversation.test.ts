import { PgClient } from "@effect/sql-pg";
import { SessionId, SessionProcessId } from "@mend/domain";
import { Deferred, Effect, Fiber, Layer, Queue, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { MEND_EVENTS_CHANNEL, MendEvent } from "../src/events.ts";
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
  effect: Effect.Effect<A, E, AgentConversationRepo | SqlClient.SqlClient | PgClient.PgClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));
let created = false;

const ConstraintDiagnostic = Schema.Struct({ code: Schema.String, constraint: Schema.String });
const foreignKeyRefusal = (statement: Effect.Effect<unknown, SqlError>) =>
  statement.pipe(
    Effect.flip,
    Effect.map((error) => Schema.decodeUnknownSync(ConstraintDiagnostic)(error.reason.cause)),
  );

/** Until another backend waits on a lock this test holds; the pg_locks row says it waits. */
const untilWaiting = (relation: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const rows = yield* sql<{ readonly waiting: string }>`
        SELECT count(*)::text AS waiting FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid AND a.datname = current_database()
        LEFT JOIN pg_class c ON c.oid = l.relation
        WHERE NOT l.granted AND (c.relname = ${relation} OR l.locktype IN ('transactionid', 'tuple'))`;
      if (rows[0]?.waiting !== "0") return;
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.die(`nothing waited on ${relation}`);
  });

/** A running turn with a provider id on the fixture's process. */
const runningTurn = Effect.gen(function* () {
  const repo = yield* AgentConversationRepo;
  const session = SessionId.make("sess-codex");
  const process = SessionProcessId.make("p-codex-1");
  const turn = yield* repo.submitTurn(session, process, "start", "user-1");
  yield* repo.claimNextTurn(process);
  yield* repo.setProviderTurnId(turn.id, "native");
  return { session, process, turn };
});

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
  it("keeps every admitted steer through completion and allocates ordinals once", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const session = SessionId.make("sess-codex");
        const process = SessionProcessId.make("p-codex-1");
        const turn = yield* repo.submitTurn(session, process, "start", "user-1");
        yield* repo.claimNextTurn(process);
        yield* repo.setProviderTurnId(turn.id, "native");
        const key = crypto.randomUUID();
        const [first, retry] = yield* Effect.all(
          [
            repo.admitTurnSteer({
              turnId: turn.id,
              author: "user-1",
              input: "  exact words\n",
              clientSteerId: key,
            }),
            repo.admitTurnSteer({
              turnId: turn.id,
              author: "user-1",
              input: "  exact words\n",
              clientSteerId: key.toUpperCase(),
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(first.steer.id).toBe(retry.steer.id);
        expect([first.created, retry.created].filter(Boolean)).toHaveLength(1);
        const [racing, completed] = yield* Effect.all(
          [
            repo.admitTurnSteer({
              turnId: turn.id,
              author: "user-1",
              input: "race",
              clientSteerId: null,
            }),
            repo.completeTurn("native", session, "completed", null, null),
          ],
          { concurrency: "unbounded" },
        );
        expect(racing.created).toBe(true);
        expect(completed?.status).toBe("completed");
        const after = yield* repo.admitTurnSteer({
          turnId: turn.id,
          author: "user-1",
          input: "after",
          clientSteerId: null,
        });
        yield* repo.settleTurnSteer(first.steer.id, {
          _tag: "Accepted",
          evidence: "provider-acknowledged",
        });
        yield* repo.settleTurnSteer(first.steer.id, { _tag: "Unknown", reason: "failed" });
        yield* repo.queueTurnSteer(first.steer.id, process, "turn-ended");
        const carried = yield* repo.queueTurnSteer(after.steer.id, process, "turn-ended");
        expect(yield* repo.queueTurnSteer(after.steer.id, process, "unsupported")).toEqual(carried);
        const turns = yield* repo.listConversationTurns(session);
        expect(turns).toHaveLength(2);
        expect(turns[0]?.steers.map((steer) => steer.ordinal)).toEqual([0, 1, 2]);
        expect(turns[0]?.steers[0]).toMatchObject({
          input: "  exact words\n",
          delivery: { _tag: "Accepted" },
        });
        expect(turns[0]?.steerSender).toBe("user-1");
        expect(turns[1]).toMatchObject({
          author: "user-1",
          input: "after",
          fromSteer: after.steer.id,
        });
        const correlated = yield* repo.byLaunchCorrelation(session, `steer:${after.steer.id}`);
        expect(correlated?.id).toBe(carried.queuedTurnId);
      }),
    );
  });

  it("completes an ended turn again on a replayed or late completion, keeping its usage", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const { session, turn } = yield* runningTurn;
        const stopped = yield* repo.completeTurn("native", session, "interrupted", null, "stopped");
        expect(stopped?.status).toBe("interrupted");
        const usage = {
          inputTokens: 12,
          outputTokens: 3,
          cachedInputTokens: null,
          totalTokens: 15,
          contextWindow: null,
        };
        const late = yield* repo.completeTurn("native", session, "completed", usage, null);
        expect(late).toMatchObject({ id: turn.id, status: "completed", usage, error: null });
        const replayed = yield* repo.completeTurn("native", session, "completed", usage, null);
        expect(replayed).toMatchObject({ id: turn.id, status: "completed", usage });
      }),
    );
  });

  it("deduplicates a person's key across turns and preserves every final delivery", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const session = SessionId.make("sess-codex");
        const process = SessionProcessId.make("p-codex-1");
        const one = yield* repo.submitTurn(session, process, "one", "user-1");
        const two = yield* repo.submitTurn(session, process, "two", "user-1");
        const key = crypto.randomUUID();
        const [left, right] = yield* Effect.all(
          [one, two].map((turn) =>
            repo.admitTurnSteer({
              turnId: turn.id,
              author: "user-1",
              input: turn.input,
              clientSteerId: key,
            }),
          ),
          { concurrency: "unbounded" },
        );
        expect(left?.steer).toEqual(right?.steer);
        for (const delivery of [
          { _tag: "Accepted", evidence: "transport-written" },
          { _tag: "Unknown", reason: "uncertain" },
          { _tag: "NotSent", reason: "not-running" },
        ] as const) {
          const { steer } = yield* repo.admitTurnSteer({
            turnId: one.id,
            author: "user-1",
            input: delivery._tag,
            clientSteerId: null,
          });
          const settled = yield* repo.settleTurnSteer(steer.id, delivery);
          expect(
            yield* repo.settleTurnSteer(steer.id, { _tag: "Unknown", reason: "failed" }),
          ).toEqual(settled);
          expect(yield* repo.queueTurnSteer(steer.id, process, "turn-ended")).toEqual(settled);
        }
      }),
    );
  });

  it("keeps words as NotSent when the session stops, and never resends Sending after restart", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const sql = yield* SqlClient.SqlClient;
        const session = SessionId.make("sess-codex");
        const process = SessionProcessId.make("p-codex-1");
        const turn = yield* repo.submitTurn(session, process, "start", "user-1");
        const { steer } = yield* repo.admitTurnSteer({
          turnId: turn.id,
          author: "user-1",
          input: "keep me",
          clientSteerId: null,
        });
        yield* sql`UPDATE agent_sessions SET settled_at = now() WHERE id = ${session}`;
        const notSent = yield* repo.queueTurnSteer(steer.id, process, "turn-ended");
        expect(notSent).toMatchObject({
          input: "keep me",
          delivery: { _tag: "NotSent", reason: "turn-ended" },
          queuedTurnId: null,
        });
        const pending = yield* repo.admitTurnSteer({
          turnId: turn.id,
          author: "user-1",
          input: "uncertain words",
          clientSteerId: null,
        });
        yield* repo.recoverSendingSteers(process);
        const turns = yield* repo.listConversationTurns(session);
        expect(turns).toHaveLength(1);
        expect(turns[0]?.steers.find((row) => row.id === pending.steer.id)).toMatchObject({
          input: "uncertain words",
          delivery: { _tag: "Unknown", reason: "restart" },
        });
        expect(turns[0]?.steers[0]).toEqual(notSent);
      }),
    );
  });

  it("withdraws a carried steer's turn as NotSent unless a process took it", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const { session, process, turn } = yield* runningTurn;
        const admit = (input: string) =>
          repo
            .admitTurnSteer({ turnId: turn.id, author: "user-1", input, clientSteerId: null })
            .pipe(Effect.map(({ steer }) => steer));
        const stranded = yield* repo.queueTurnSteer(
          (yield* admit("stranded")).id,
          process,
          "turn-ended",
        );
        const withdrawn = yield* repo.withdrawTurnSteer(stranded.id);
        expect(withdrawn).toMatchObject({
          input: "stranded",
          delivery: { _tag: "NotSent", reason: "turn-ended" },
          queuedTurnId: null,
        });
        expect((yield* repo.byTurnId(stranded.queuedTurnId ?? turn.id))?.status).toBe(
          "cancelled",
        );
        expect(yield* repo.withdrawTurnSteer(stranded.id)).toEqual(withdrawn);
        yield* repo.completeTurn("native", session, "completed", null, null);
        const taken = yield* repo.queueTurnSteer((yield* admit("taken")).id, process, "turn-ended");
        expect((yield* repo.claimNextTurn(process))?.id).toBe(taken.queuedTurnId);
        expect(yield* repo.withdrawTurnSteer(taken.id)).toEqual(taken);
      }),
    );
  });

  it("round trips the control journal and refuses a conflicting checkpoint", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const process = SessionProcessId.make("p-codex-1");
        const control = {
          ordinal: 0,
          controlId: crypto.randomUUID(),
          providerTurnId: "logical-turn",
          afterOutputLine: 3,
          action: "steer-now",
        } as const;
        yield* repo.recordProtocolControl(process, control);
        yield* repo.recordProtocolControl(process, control);
        expect(yield* repo.protocolControls(process)).toEqual([control]);
        expect(
          (yield* repo
            .recordProtocolControl(process, { ...control, afterOutputLine: 4 })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* repo
            .recordProtocolControl(process, { ...control, ordinal: 1 })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* repo.protocolControls(process)).toEqual([control]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM session_processes WHERE id = ${process}`;
        expect(yield* repo.protocolControls(process)).toEqual([]);
      }),
    );
  });
  it("never reports a control whose journal row committed as not written", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const sql = yield* SqlClient.SqlClient;
        const process = SessionProcessId.make("p-codex-1");
        // The journal is read through a view whose first read fails, as a dropped connection
        // would fail the read that follows a write.
        yield* sql`ALTER TABLE agent_protocol_control_journal RENAME TO journal_rows`;
        yield* sql`CREATE SEQUENCE journal_reads`;
        yield* sql.unsafe(`CREATE FUNCTION journal_read() RETURNS boolean LANGUAGE plpgsql AS $$
          BEGIN
            IF nextval('journal_reads') = 1 THEN RAISE EXCEPTION 'journal read failed'; END IF;
            RETURN true;
          END $$`);
        yield* sql`CREATE VIEW agent_protocol_control_journal AS
          SELECT * FROM journal_rows WHERE journal_read()`;
        const control = {
          ordinal: 0,
          controlId: crypto.randomUUID(),
          providerTurnId: "logical-turn",
          afterOutputLine: 2,
          action: "steer-now",
        } as const;
        const recorded = yield* repo.recordProtocolControl(process, control).pipe(Effect.result);
        const stored = yield* sql<{ readonly action: string }>`
          SELECT action FROM journal_rows WHERE control_id = ${control.controlId}`;
        expect({
          recorded: recorded._tag,
          armed: stored.some((row) => row.action === "steer-now"),
        }).toEqual({ recorded: recorded._tag, armed: recorded._tag === "Success" });
      }),
    );
  });

  it("admits a steer only after a completion holding the turn's row commits", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const sql = yield* SqlClient.SqlClient;
        const { session, turn } = yield* runningTurn;
        const completing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const completion = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const ended = yield* repo.completeTurn("native", session, "completed", null, null);
              yield* Deferred.succeed(completing, undefined);
              yield* Deferred.await(release);
              return ended;
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(completing);
        const admission = yield* repo
          .admitTurnSteer({ turnId: turn.id, author: "user-1", input: "late", clientSteerId: null })
          .pipe(Effect.forkChild);
        yield* untilWaiting("agent_turns");
        expect(admission.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(completion))?.status).toBe("completed");
        const admitted = yield* Fiber.join(admission);
        expect(admitted).toMatchObject({ created: true, steer: { delivery: { _tag: "Sending" } } });
        expect((yield* repo.byTurnId(turn.id))?.status).toBe("completed");
        const turns = yield* repo.listConversationTurns(session);
        expect(turns.map((row) => [row.status, row.steers.map((steer) => steer.input)])).toEqual([
          ["completed", ["late"]],
        ]);
      }),
    );
  });

  it("completes a turn only after an admission holding its row commits the steer", async () => {
    await withConversation(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const sql = yield* SqlClient.SqlClient;
        const { session, turn } = yield* runningTurn;
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // SHARE mode lets the admission lock the turn row and read ordinals, then stops its insert.
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`LOCK TABLE agent_turn_steers IN SHARE MODE`;
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        const admission = yield* repo
          .admitTurnSteer({
            turnId: turn.id,
            author: "user-1",
            input: "first",
            clientSteerId: null,
          })
          .pipe(Effect.forkChild);
        yield* untilWaiting("agent_turn_steers");
        const completion = yield* repo
          .completeTurn("native", session, "completed", null, null)
          .pipe(Effect.forkChild);
        yield* Effect.sleep("200 millis");
        expect(admission.pollUnsafe()).toBeUndefined();
        expect(completion.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const admitted = yield* Fiber.join(admission);
        expect((yield* Fiber.join(completion))?.status).toBe("completed");
        expect(admitted).toMatchObject({ created: true, steer: { ordinal: 0, input: "first" } });
        const turns = yield* repo.listConversationTurns(session);
        expect(turns.map((row) => [row.status, row.steers.map((steer) => steer.id)])).toEqual([
          ["completed", [admitted.steer.id]],
        ]);
      }),
    );
  });

  it("notifies conversation readers only once the steer and its fallback turn are readable", async () => {
    await withConversation(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* AgentConversationRepo;
          const pg = yield* PgClient.PgClient;
          const { session, process, turn } = yield* runningTurn;
          const notices = yield* pg.listen(MEND_EVENTS_CHANNEL);
          const next = Queue.take(notices).pipe(
            Effect.timeout("2 seconds"),
            Effect.map((notice) =>
              Schema.decodeUnknownSync(Schema.fromJsonString(MendEvent))(notice.payload),
            ),
          );
          const steers = repo
            .listConversationTurns(session)
            .pipe(Effect.map((turns) => turns.flatMap((row) => row.steers)));
          const admitted = yield* repo.admitTurnSteer({
            turnId: turn.id,
            author: "user-1",
            input: "visible at notification",
            clientSteerId: null,
          });
          expect(yield* next).toMatchObject({ type: "agent-conversation", sessionId: session });
          expect(yield* steers).toEqual([admitted.steer]);
          const accepted = yield* repo.settleTurnSteer(admitted.steer.id, {
            _tag: "Accepted",
            evidence: "provider-acknowledged",
          });
          expect(yield* next).toMatchObject({ type: "agent-conversation", sessionId: session });
          expect(yield* steers).toEqual([accepted]);
          const second = yield* repo.admitTurnSteer({
            turnId: turn.id,
            author: "user-1",
            input: "carried",
            clientSteerId: null,
          });
          yield* next;
          const queued = yield* repo.queueTurnSteer(second.steer.id, process, "turn-ended");
          expect(yield* next).toMatchObject({ type: "agent-conversation", sessionId: session });
          const turns = yield* repo.listConversationTurns(session);
          expect(turns.flatMap((row) => row.steers)).toEqual([accepted, queued]);
          expect(turns.find((row) => row.id === queued.queuedTurnId)).toMatchObject({
            input: "carried",
            status: "queued",
            fromSteer: queued.id,
          });
        }),
      ),
    );
  });
});
