import { describe, expect, it } from "@effect/vitest";
import { AgentConversationRepo, SessionProcessesRepo, SessionsRepo } from "@mend/db";
import {
  AgentItemId,
  AgentTurnId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
} from "@mend/domain";
import { AgentItem, AgentTurn, SessionProcess, type TurnPayer } from "@mend/domain/workbench";
import type { InteractiveSession } from "@sealant/sdk";
import { Effect, Fiber, Layer } from "effect";

import {
  type ConversationWait,
  INTERRUPTED_BY_HAND_OVER,
  ProtocolHost,
  ProtocolHostLive,
  type ProtocolHostHooks,
  type SteeringDecision,
} from "../src/protocol-host.ts";

/**
 * Shared steering's dispatch (docs/adr/0016, decision 6, Delivery 18), through the real protocol
 * host and the real Claude and Codex adapters over scripted pipes: one shared conversation, each
 * turn run by a process of its sender's user. A new sender's turn waits for the previous sender's
 * own work (a sub-agent, a goal, a background terminal, a monitor), which finishes as them, and
 * nothing is killed; then the conversation is handed to a process of the new sender's.
 */

const ALICE = "user-alice";
const BOB = "user-bob";
const sessionId = SessionId.make("session-shared");
const now = () => new Date();

const processOf = (id: string, harness: "claude" | "codex", runsAs: string) =>
  new SessionProcess({
    id: SessionProcessId.make(id),
    sessionId,
    sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
    sealantSessionId: `pipe-${id}`,
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind: "agent-protocol",
    harness,
    providerSessionId: harness === "codex" ? "thread-1" : "11111111-1111-4111-8111-111111111111",
    protocolOptions: null,
    label: harness,
    argv: [harness],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: now(),
    exitedAt: null,
    updatedAt: now(),
    runsAs,
  });

/** Turns as the real repo keeps them: queued per process, one running per session, by ordinal. */
const conversationWorld = () => {
  const turns = new Map<AgentTurnId, AgentTurn>();
  let ordinal = 0;
  const update = (id: AgentTurnId, patch: Partial<AgentTurn>) => {
    const current = turns.get(id);
    if (current === undefined) throw new Error(`unknown turn ${id}`);
    const next = new AgentTurn({ ...current, ...patch });
    turns.set(id, next);
    return next;
  };
  const ordered = () => [...turns.values()].toSorted((a, b) => a.ordinal - b.ordinal);
  const layer = Layer.mock(AgentConversationRepo, {
    submitTurn: (_session, processId, input, author) =>
      Effect.sync(() => {
        const turn = new AgentTurn({
          id: AgentTurnId.make(`turn-${ordinal}`),
          sessionId,
          processId,
          ordinal: ordinal++,
          author,
          input,
          status: "queued",
          providerTurnId: null,
          error: null,
          usage: null,
          createdAt: now(),
          startedAt: null,
          endedAt: null,
        });
        turns.set(turn.id, turn);
        return turn;
      }),
    byTurnId: (id) => Effect.succeed(turns.get(id) ?? null),
    byProviderTurnId: (_session, providerTurnId) =>
      Effect.succeed(ordered().find((turn) => turn.providerTurnId === providerTurnId) ?? null),
    listTurns: () => Effect.sync(ordered),
    openTurns: () =>
      Effect.sync(() =>
        ordered().filter((turn) => turn.status === "queued" || turn.status === "running"),
      ),
    claimNextTurn: (processId) =>
      Effect.sync(() => {
        const all = ordered();
        if (all.some((turn) => turn.status === "running")) return null;
        const queued = all.find((turn) => turn.status === "queued" && turn.processId === processId);
        return queued === undefined
          ? null
          : update(queued.id, { status: "running", startedAt: now() });
      }),
    openHarnessTurn: (_session, processId, providerTurnId, reason, payer: TurnPayer) =>
      Effect.sync(() => {
        const existing = ordered().find((turn) => turn.providerTurnId === providerTurnId);
        if (existing !== undefined) return existing;
        for (const turn of ordered()) {
          if (turn.status === "running" && turn.providerTurnId === null) {
            update(turn.id, { status: "queued", startedAt: null });
          }
        }
        if (ordered().some((turn) => turn.status === "running")) return null;
        const turn = new AgentTurn({
          id: AgentTurnId.make(`turn-${ordinal}`),
          sessionId,
          processId,
          ordinal: ordinal++,
          author: null,
          origin: "harness",
          input: reason,
          status: "running",
          providerTurnId,
          error: null,
          usage: null,
          billedUserId: payer.userId,
          billedAccountId: payer.accountId,
          billedAccountName: payer.accountName,
          createdAt: now(),
          startedAt: now(),
          endedAt: null,
        });
        turns.set(turn.id, turn);
        return turn;
      }),
    requeueClaimedTurn: (id) =>
      Effect.sync(() => {
        const turn = turns.get(id);
        if (turn?.status === "running" && turn.providerTurnId === null) {
          update(id, { status: "queued", startedAt: null });
        }
      }),
    setProviderTurnId: (id, providerTurnId) => Effect.sync(() => update(id, { providerTurnId })),
    setTurnPayer: (id, payer) =>
      Effect.sync(() =>
        update(id, {
          billedUserId: payer.userId,
          billedAccountId: payer.accountId,
          billedAccountName: payer.accountName,
        }),
      ),
    bindRunningProviderTurn: () => Effect.succeed(null),
    failTurn: (id, error) =>
      Effect.sync(() => update(id, { status: "failed", error, endedAt: now() })),
    completeTurn: (providerTurnId, _session, status, _usage, error) =>
      Effect.sync(() => {
        const turn = ordered().find((candidate) => candidate.providerTurnId === providerTurnId);
        if (turn === undefined || (turn.status !== "running" && turn.status !== "queued")) {
          return null;
        }
        return update(turn.id, { status, error, endedAt: now() });
      }),
    upsertItem: (input) =>
      Effect.sync(
        () =>
          new AgentItem({
            id: AgentItemId.make(input.providerItemId),
            sessionId: input.sessionId,
            processId: input.processId,
            turnId: input.turnId,
            seq: 0,
            providerItemId: input.providerItemId,
            kind: input.kind,
            status: input.status,
            title: input.title,
            text: input.text,
            data: input.data,
            createdAt: now(),
            updatedAt: now(),
          }),
      ),
    cancelOpenForTurn: (turnId) =>
      Effect.sync(() => {
        const turn = turns.get(turnId);
        if (turn !== undefined && turn.status === "queued") {
          update(turnId, { status: "cancelled", endedAt: now() });
        }
      }),
    cancelOpenForProcess: () => Effect.void,
    requeueQueuedTurns: (from, to) =>
      Effect.sync(() => {
        for (const turn of ordered()) {
          if (turn.processId === from && turn.status === "queued")
            update(turn.id, { processId: to });
        }
      }),
    resolveProviderRequest: () => Effect.void,
  });
  return { turns, layer, ordered };
};

/** A Claude or Codex on the far side of a pipe: says what the test pushes, records what Mend sends. */
const scriptedPipe = (
  id: string,
  answer: (message: Record<string, unknown>, push: (value: unknown) => void) => void,
) => {
  const pending: Array<{ sequence: bigint; data: Uint8Array }> = [];
  let notify: (() => void) | null = null;
  let sequence = 0n;
  const sent: Array<Record<string, unknown>> = [];
  let closed = false;
  const push = (value: unknown) => {
    pending.push({
      sequence: sequence++,
      data: new TextEncoder().encode(`${JSON.stringify(value)}\n`),
    });
    notify?.();
  };
  const pipe: InteractiveSession = {
    id,
    workspaceId: "ws-1",
    runId: `run-${id}`,
    mode: "pipe",
    send: (input) => {
      const text = typeof input === "string" ? input : new TextDecoder().decode(input);
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const message = Object.fromEntries(Object.entries(parsed));
        sent.push(message);
        answer(message, push);
      }
      return Promise.resolve();
    },
    output: (options) => {
      const signal = options?.signal;
      return (async function* () {
        for (;;) {
          if (signal?.aborted === true || closed) return;
          const next = pending.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
            if (pending.length > 0) resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          notify = null;
        }
      })();
    },
    resize: () => Promise.reject(new Error("pipe sessions have no terminal")),
    signal: () => Promise.resolve(),
    status: () => Promise.resolve({ status: closed ? "exited" : "running", outputHighWater: 0n }),
    close: () => {
      closed = true;
      notify?.();
      return Promise.resolve();
    },
    attach: () => Promise.reject(new Error("not in test")),
  };
  const userTurns = () =>
    sent.flatMap((message) => {
      if (message["type"] !== "user" && message["method"] !== "turn/start") return [];
      const content = JSON.stringify(message);
      return [content];
    });
  return { pipe, push, sent, userTurns };
};

const claudePipe = (id: string) => scriptedPipe(id, () => undefined);

/** A Codex app-server whose goal and background terminals the test turns on and off. */
const codexPipe = (id: string) => {
  const state = {
    goal: null as string | null,
    terminals: [] as Array<{ processId: string; command: string }>,
    turns: 0,
  };
  const pipe = scriptedPipe(id, (message, push) => {
    const rpc = message["id"];
    if (typeof rpc !== "number" && typeof rpc !== "string") return;
    switch (message["method"]) {
      case "thread/start":
      case "thread/resume":
        push({ id: rpc, result: { thread: { id: "thread-1" } } });
        return;
      case "turn/start":
        state.turns += 1;
        push({ id: rpc, result: { turn: { id: `${id}-turn-${state.turns}` } } });
        return;
      case "thread/goal/get":
        push({
          id: rpc,
          result: {
            goal:
              state.goal === null
                ? null
                : { threadId: "thread-1", objective: state.goal, status: "active" },
          },
        });
        return;
      case "thread/backgroundTerminals/list":
        push({ id: rpc, result: { data: state.terminals, nextCursor: null } });
        return;
      default:
        push({ id: rpc, result: {} });
    }
  });
  return { ...pipe, state };
};

const pause = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const waitUntil = (predicate: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (predicate()) return;
      yield* pause(5);
    }
    expect.fail(`never: ${what}`);
  });

interface Harnessed {
  readonly pipe: InteractiveSession;
  readonly push: (value: unknown) => void;
  readonly sent: Array<Record<string, unknown>>;
}

/**
 * A conversation of Alice's on a scripted harness, with the engine's side of steering stood in:
 * each turn runs as its sender, and a hand-over stops Alice's process and attaches Bob's, as the
 * engine's `handOverConversation` does.
 */
const steeredWorld = (harness: "claude" | "codex") => {
  const world = conversationWorld();
  const processA = processOf("process-a", harness, ALICE);
  const processB = processOf("process-b", harness, BOB);
  const waits: Array<ConversationWait | null> = [];
  const handOvers: Array<{ readonly sender: string; readonly at: number }> = [];
  const pipes: Record<string, Harnessed> = {};
  const live = new Set<string>([processA.id]);
  const processes = Layer.mock(SessionProcessesRepo, {
    listForSession: () =>
      Effect.sync(() => [processA, processB].filter((process) => live.has(process.id))),
    setProviderSessionId: () => Effect.void,
  });
  const sessions = Layer.mock(SessionsRepo, { setProviderSessionId: () => Effect.void });
  const host = ProtocolHostLive.pipe(
    Layer.provide(world.layer),
    Layer.provide(processes),
    Layer.provide(sessions),
  );
  const hooksFor = (runsAs: string, attachB: Effect.Effect<void>): ProtocolHostHooks => ({
    onRequestChanged: () => Effect.void,
    onTurnCompleted: () => Effect.void,
    steering: {
      decide: (turn) =>
        Effect.succeed<SteeringDecision>(
          (turn.author ?? ALICE) === runsAs
            ? { kind: "send" }
            : { kind: "hand-over", sender: turn.author ?? ALICE },
        ),
      waiting: (wait) => Effect.sync(() => void waits.push(wait)),
      handOver: (sender) =>
        Effect.gen(function* () {
          handOvers.push({ sender, at: Date.now() });
          const protocolHost = yield* ProtocolHost;
          yield* protocolHost.detachForHandOver(processA.id);
          live.delete(processA.id);
          live.add(processB.id);
          yield* attachB;
        }).pipe(Effect.provide(host)),
    },
  });
  return { world, processA, processB, waits, handOvers, pipes, live, host, hooksFor };
};

const attachAs = (process: SessionProcess, pipe: InteractiveSession, hooks: ProtocolHostHooks) =>
  Effect.flatMap(ProtocolHost, (host) =>
    host.attach({
      process,
      pipe,
      cwd: "/workspace/repo",
      permissionMode: "bypass",
      launchedWithLoginOf: ALICE,
      runsAs: process.runsAs,
      hooks,
    }),
  );

describe("shared steering's dispatch (docs/adr/0016, Delivery 18)", () => {
  /**
   * Alice's Claude has something of its own in flight when Bob's turn arrives; Bob's turn waits,
   * the work finishes as Alice (a turn Claude opens on its own, on Alice's login), and then Bob's
   * process runs his turn, on his.
   */
  const claudeWaitsFor = (
    start: (alice: Harnessed) => void,
    end: (alice: Harnessed) => void,
    expectedWork: string,
  ) => {
    const steered = steeredWorld("claude");
    const alice = claudePipe("pipe-a");
    const bob = claudePipe("pipe-b");
    let attachBob: Effect.Effect<void> = Effect.void;
    const aliceHooks = steered.hooksFor(
      ALICE,
      Effect.suspend(() => attachBob),
    );
    attachBob = attachAs(steered.processB, bob.pipe, steered.hooksFor(BOB, Effect.void)).pipe(
      Effect.orDie,
      Effect.provide(steered.host),
    );
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachAs(steered.processA, alice.pipe, aliceHooks);
      // Alice's own turn, which starts the work and ends; Claude says it is idle.
      yield* host.submitTurn(sessionId, "start it", ALICE);
      yield* waitUntil(
        () => alice.sent.some((message) => message["type"] === "user"),
        "Alice's turn sent",
      );
      start(alice);
      alice.push({ type: "result", subtype: "success" });
      alice.push({ type: "system", subtype: "session_state_changed", state: "idle" });
      yield* pause(30);
      // Bob's turn: queued on the conversation, waiting for Alice's work.
      const bobs = yield* host.submitTurn(sessionId, "Bob's request", BOB);
      yield* waitUntil(() => steered.waits.some((wait) => wait !== null), "the waiting line");
      yield* pause(400);
      expect(steered.handOvers).toEqual([]);
      const line = steered.waits.findLast((wait) => wait !== null);
      expect(line?.runsAs).toBe(ALICE);
      expect(line?.sender).toBe(BOB);
      expect(line?.turnId).toBe(bobs.id);
      expect(line?.work.map((work) => work.kind)).toContain(expectedWork);
      expect(bob.sent).toEqual([]);
      // The work ends, and Claude answers it on its own: a turn of Alice's, on her login.
      end(alice);
      alice.push({
        type: "system",
        subtype: "init",
        uuid: "wake-1",
        session_id: "11111111-1111-4111-8111-111111111111",
      });
      alice.push({ type: "result", subtype: "success" });
      alice.push({ type: "system", subtype: "session_state_changed", state: "idle" });
      yield* waitUntil(() => steered.handOvers.length === 1, "the hand-over");
      expect(steered.handOvers[0]?.sender).toBe(BOB);
      const wake = steered.world.ordered().find((turn) => turn.origin === "harness");
      expect(wake).toMatchObject({
        status: "completed",
        billedUserId: ALICE,
        processId: steered.processA.id,
      });
      // Bob's turn, moved onto his process and sent there, runs on his login.
      yield* waitUntil(
        () => bob.sent.some((message) => message["type"] === "user"),
        "Bob's turn sent",
      );
      expect(JSON.stringify(bob.sent)).toContain("Bob's request");
      expect(steered.world.turns.get(bobs.id)).toMatchObject({
        processId: steered.processB.id,
        status: "running",
        billedUserId: BOB,
        billedAccountName: "default",
      });
      // Alice's process never got Bob's words, and her own turn ran on hers.
      expect(JSON.stringify(alice.sent)).not.toContain("Bob's request");
      expect(steered.world.ordered()[0]).toMatchObject({ author: ALICE, billedUserId: ALICE });
      expect(steered.waits.at(-1)).toBeNull();
      yield* host.detach(steered.processB.id);
    }).pipe(Effect.scoped, Effect.provide(steered.host));
  };

  it.live("B's turn runs as B with A's conversation, once A's sub-agent has finished as A", () =>
    claudeWaitsFor(
      (alice) =>
        alice.push({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "agent-1", task_type: "local_agent", description: "Agent A" }],
        }),
      (alice) => {
        alice.push({
          type: "system",
          subtype: "task_notification",
          task_id: "agent-1",
          status: "completed",
          summary: "Agent A finished",
        });
        alice.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      },
      "sub-agent",
    ),
  );

  it.live("A's monitor delays B's turn, and finishes as A", () =>
    claudeWaitsFor(
      (alice) => {
        alice.push({
          type: "assistant",
          message: {
            id: "m1",
            content: [
              {
                type: "tool_use",
                id: "tu-monitor",
                name: "Monitor",
                input: { description: "watch the build", timeout_ms: 60000 },
              },
            ],
          },
        });
        alice.push({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu-monitor", content: "started" }],
          },
          tool_use_result: { taskId: "monitor-1", timeoutMs: 60000, persistent: false },
        });
        alice.push({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            {
              task_id: "monitor-1",
              task_type: "local_bash",
              description: "watch the build",
              ambient: true,
            },
          ],
        });
      },
      (alice) => {
        alice.push({
          type: "system",
          subtype: "task_notification",
          task_id: "monitor-1",
          status: "completed",
          summary: "the build finished",
        });
        alice.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      },
      "monitor",
    ),
  );

  /** The same with Codex: a goal or a background terminal of Alice's. */
  const codexWaitsFor = (
    start: (alice: ReturnType<typeof codexPipe>) => void,
    end: (alice: ReturnType<typeof codexPipe>) => void,
    expectedWork: string,
  ) => {
    const steered = steeredWorld("codex");
    const alice = codexPipe("pipe-a");
    const bob = codexPipe("pipe-b");
    let attachBob: Effect.Effect<void> = Effect.void;
    const aliceHooks = steered.hooksFor(
      ALICE,
      Effect.suspend(() => attachBob),
    );
    attachBob = attachAs(steered.processB, bob.pipe, steered.hooksFor(BOB, Effect.void)).pipe(
      Effect.orDie,
      Effect.provide(steered.host),
    );
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachAs(steered.processA, alice.pipe, aliceHooks);
      yield* host.submitTurn(sessionId, "start it", ALICE);
      yield* waitUntil(() => alice.state.turns === 1, "Alice's turn sent");
      start(alice);
      alice.push({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "pipe-a-turn-1", status: "completed" } },
      });
      const bobs = yield* host.submitTurn(sessionId, "Bob's request", BOB);
      yield* waitUntil(
        () =>
          steered.waits.some(
            (wait) => wait?.work.some((work) => work.kind === expectedWork) === true,
          ),
        "the waiting line",
      );
      yield* pause(400);
      expect(steered.handOvers).toEqual([]);
      expect(bob.state.turns).toBe(0);
      // Codex continues on its own (the goal, or the terminal's output): a turn of Alice's.
      alice.push({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "codex-own-turn" } },
      });
      end(alice);
      alice.push({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "codex-own-turn", status: "completed" } },
      });
      yield* waitUntil(() => steered.handOvers.length === 1, "the hand-over");
      const own = steered.world.ordered().find((turn) => turn.providerTurnId === "codex-own-turn");
      expect(own).toMatchObject({ origin: "harness", status: "completed", billedUserId: ALICE });
      // The 1 s settle after Codex's last turn: the hand-over came no sooner.
      const ownEnd = own?.endedAt?.getTime() ?? 0;
      expect((steered.handOvers[0]?.at ?? 0) - ownEnd).toBeGreaterThanOrEqual(900);
      yield* waitUntil(() => bob.state.turns === 1, "Bob's turn sent");
      expect(steered.world.turns.get(bobs.id)).toMatchObject({
        processId: steered.processB.id,
        billedUserId: BOB,
      });
      yield* host.detach(steered.processB.id);
    }).pipe(Effect.scoped, Effect.provide(steered.host));
  };

  it.live("A's goal delays B's turn, and finishes as A", () =>
    codexWaitsFor(
      (alice) => {
        alice.state.goal = "ship the release";
      },
      (alice) => {
        alice.state.goal = null;
      },
      "goal",
    ),
  );

  it.live("A's background terminal delays B's turn, and finishes as A", () =>
    codexWaitsFor(
      (alice) => {
        alice.state.terminals = [{ processId: "42", command: "npm run dev" }];
      },
      (alice) => {
        alice.state.terminals = [];
      },
      "terminal",
    ),
  );

  it.live(
    "a turn Codex starts on its own after the stop is recorded as interrupted by the hand-over, under A",
    () => {
      const steered = steeredWorld("codex");
      const alice = codexPipe("pipe-a");
      return Effect.gen(function* () {
        const host = yield* ProtocolHost;
        yield* attachAs(steered.processA, alice.pipe, steered.hooksFor(ALICE, Effect.void));
        // Told to stop: then Codex starts a turn on its own (a queued prompt) before it exits.
        alice.push({
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "late-turn" } },
        });
        yield* waitUntil(
          () => steered.world.ordered().some((turn) => turn.providerTurnId === "late-turn"),
          "Codex's own turn",
        );
        yield* host.detachForHandOver(steered.processA.id);
        expect(
          steered.world.ordered().find((turn) => turn.providerTurnId === "late-turn"),
        ).toMatchObject({
          status: "interrupted",
          error: INTERRUPTED_BY_HAND_OVER,
          billedUserId: ALICE,
        });
      }).pipe(Effect.scoped, Effect.provide(steered.host));
    },
  );

  it.live("a takeover waits for A's background work, and nothing is killed", () => {
    const steered = steeredWorld("claude");
    const alice = claudePipe("pipe-a");
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachAs(steered.processA, alice.pipe, steered.hooksFor(ALICE, Effect.void));
      alice.push({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "bash-1", task_type: "local_bash", description: "npm test" }],
      });
      alice.push({ type: "system", subtype: "session_state_changed", state: "idle" });
      const takeover = yield* Effect.forkChild(host.awaitQuiescent(steered.processA.id));
      yield* pause(400);
      expect(takeover.pollUnsafe()).toBeUndefined();
      // Nothing was stopped for it: no stop_task, no interrupt.
      expect(JSON.stringify(alice.sent)).not.toMatch(/stop_task|interrupt/);
      alice.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      yield* Fiber.join(takeover);
      yield* host.detach(steered.processA.id);
    }).pipe(Effect.scoped, Effect.provide(steered.host));
  });

  it.live("same-person turns pay nothing: no hand-over, no wait", () => {
    const steered = steeredWorld("claude");
    const alice = claudePipe("pipe-a");
    return Effect.gen(function* () {
      const host = yield* ProtocolHost;
      yield* attachAs(steered.processA, alice.pipe, steered.hooksFor(ALICE, Effect.void));
      alice.push({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "bash-1", task_type: "local_bash", description: "npm test" }],
      });
      const turn = yield* host.submitTurn(sessionId, "more", ALICE);
      yield* waitUntil(
        () => alice.sent.some((message) => message["type"] === "user"),
        "Alice's turn sent",
      );
      expect(steered.handOvers).toEqual([]);
      expect(steered.waits).toEqual([]);
      expect(steered.world.turns.get(turn.id)?.billedUserId).toBe(ALICE);
      yield* host.detach(steered.processA.id);
    }).pipe(Effect.scoped, Effect.provide(steered.host));
  });
});
