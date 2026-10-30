import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import {
  WS_METHODS,
  MessageId,
  RunId,
  ORCHESTRATION_V2_WS_METHODS as methods,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { afterAll, assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { advanceClock } from "./support/fake-workbench.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import {
  commandId,
  eventually,
  gateway,
  inputOf,
  message,
  posts,
  projectionWhen,
  promote,
  setup,
  snapshot,
  threadId,
} from "./support/steering.ts";
import {
  deriveThreadQueueWorkflowState,
  applyOrchestrationV2ProjectionEvent,
} from "./support/upstream/steering-client.mjs";
const scratch = (await promisify(execFile)("mktemp", ["-d", "-t", "steer.XXXXXX"])).stdout.trim();
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
const stateFile = () => join(scratch, `state-${++files}.sqlite`);
type Item = OrchestrationV2ThreadStreamItem;
const withGateway = <A, E, R>(
  test: (mend: FakeMend) => Effect.Effect<A, E, R>,
  statePath = ":memory:",
) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(
      Effect.scoped,
      Effect.provide(gatewayTestLayer(mend.url, statePath)),
    );
  });
describe("native steering", () => {
  it.live(
    "does not repeat an admission whose HTTP response times out",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "TIMEOUT");
          const barrier = mend.workbench.holdNextSteer("response");
          const cmd = message("timeout", {
            type: "steer_active",
            targetRunId: RunId.make(turn.id),
          });
          const sending = yield* rpc[methods.dispatchCommand](cmd).pipe(Effect.forkScoped);
          yield* Effect.promise(() => barrier.entered);
          yield* Fiber.join(sending);
          barrier.release();
          yield* rpc[methods.dispatchCommand]({ ...cmd, commandId: commandId() });
          yield* projectionWhen(
            rpc,
            (projection) => inputOf(projection, "timeout")?.status === "completed",
          );
          assert.lengthOf(posts(mend, "/steer"), 1);
          assert.lengthOf(posts(mend, "/turns"), 0);
        }),
      ),
    40_000,
  );

  for (const harness of ["codex", "claude"]) {
    for (const intent of ["auto", "steer", "restart"] as const) {
      it.live(`${harness} ${intent} preserves the message and one logical attempt`, () =>
        withGateway((mend) =>
          Effect.gen(function* () {
            const turn = setup(mend, harness);
            if (harness === "claude")
              mend.workbench.steerDelivery = { _tag: "Accepted", evidence: "transport-written" };
            const { rpc } = yield* pairAndConnect(mend, "STEER");
            const cmd = message("arbitrary/not-a-uuid", { type: "start_immediately" }, intent);
            yield* rpc[methods.dispatchCommand](cmd);
            yield* rpc[methods.dispatchCommand]({ ...cmd, commandId: commandId() });
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            const input = inputOf(projection, cmd.messageId);
            assert.strictEqual(input?.runId, turn.id);
            assert.strictEqual(input?.status, "completed");
            assert.isTrue(input?.type === "user_message" && input.inputIntent === "steer");
            assert.lengthOf(projection.runs, 1);
            assert.lengthOf(projection.attempts, 1);
            assert.lengthOf(projection.nodes, 1);
            assert.lengthOf(projection.providerTurns, 1);
            assert.strictEqual(projection.runs[0]?.activeAttemptId, projection.attempts[0]?.id);
            assert.strictEqual(projection.nodes[0]?.id, projection.providerTurns[0]?.nodeId);
            assert.strictEqual(
              projection.providerTurns[0]?.nativeTurnRef?.nativeId ?? null,
              harness === "codex" ? turn.providerTurnId : null,
            );
            const flags = projection.providerSessions[0]?.capabilities.turns;
            assert.isTrue(flags?.supportsActiveSteering);
            assert.strictEqual(flags?.activeSteeringInterruptsTools, harness === "claude");
            assert.isFalse(flags?.supportsSteeringByInterruptRestart);
            assert.lengthOf(
              projection.turnItems.filter((item) => item.type === "system_notice"),
              0,
            );
            assert.lengthOf(posts(mend, "/steer"), 1);
            assert.deepStrictEqual(posts(mend, "/steer")[0]?.body, {
              input: cmd.text,
              clientSteerId: turn.steers[0]?.clientSteerId,
            });
            assert.match(
              turn.steers[0]?.clientSteerId ?? "",
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
            assert.strictEqual(
              posts(mend, "/steer")[0]?.authorization,
              `Bearer ${mend.claims[0]?.token}`,
            );
            assert.lengthOf(posts(mend, "/turns"), 0);
            assert.lengthOf(posts(mend, "/interrupt"), 0);
            assert.lengthOf(posts(mend, "/launch"), 0);
          }),
        ),
      );
    }
  }

  it.live("waits for the admission answer while another message remains queued", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "WAIT");
        const held = mend.workbench.holdNextSteer("response");
        let answered = false;
        const sending = yield* rpc[methods.dispatchCommand](
          message("slow", { type: "steer_active", targetRunId: RunId.make(turn.id) }),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              answered = true;
            }),
          ),
          Effect.forkScoped,
        );
        yield* Effect.promise(() => held.entered);
        yield* rpc[methods.dispatchCommand](message("later", { type: "queue_after_active" }));
        assert.isFalse(answered);
        held.release();
        yield* Fiber.join(sending);
        assert.isTrue(answered);
        const projection = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.strictEqual(
          projection.runs.find((run) => run.userMessageId === "later")?.status,
          "queued",
        );
        assert.lengthOf(posts(mend, "/turns"), 0);
      }),
    ),
  );

  for (const tag of [
    "SessionNotSteerable",
    "ProtocolSessionNotLive",
    "TurnSteerKeyConflict",
    "InvalidInput",
    "NotFound",
    "NotSent",
  ]) {
    it.live(`returns a refused ${tag} promotion to its exact position`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "REFUSED");
          for (const id of ["first", "middle", "last"])
            yield* rpc[methods.dispatchCommand](message(id, { type: "queue_after_active" }));
          const before = yield* rpc[methods.getThreadProjection]({ threadId });
          const queued = before.runs.find((run) => run.userMessageId === "middle");
          assert.isDefined(queued);
          if (queued === undefined) return;
          if (tag === "NotSent")
            mend.workbench.steerDelivery = { _tag: "NotSent", reason: "not-running" };
          else
            mend.workbench.steerRefusal = {
              status:
                tag === "NotFound"
                  ? 404
                  : tag === "InvalidInput"
                    ? 400
                    : tag === "SessionNotSteerable"
                      ? 403
                      : 409,
              tag,
            };
          const result = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
            Effect.exit,
          );
          assert.isTrue(Exit.isFailure(result));
          const after = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.deepStrictEqual(
            after.runs
              .filter((run) => run.status === "queued")
              .map((run) => [run.id, run.queuePosition]),
            before.runs
              .filter((run) => run.status === "queued")
              .map((run) => [run.id, run.queuePosition]),
          );
          assert.lengthOf(
            after.messages.filter((item) => item.text === "middle"),
            1,
          );
          assert.lengthOf(posts(mend, "/turns"), 0);
          assert.lengthOf(posts(mend, "/interrupt"), 0);
        }),
      ),
    );
  }

  it.live("promotes once, removes the old run, and refuses stale queue operations", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "PROMOTE");
        yield* rpc[methods.dispatchCommand](message("promoted", { type: "queue_after_active" }));
        const before = yield* rpc[methods.getThreadProjection]({ threadId });
        const queued = before.runs.find((run) => run.userMessageId === "promoted");
        if (queued === undefined) return yield* Effect.die("Missing queued run");
        const command = promote(queued.id, turn.id);
        yield* Effect.all(
          [
            rpc[methods.dispatchCommand](command),
            rpc[methods.dispatchCommand]({ ...command, commandId: commandId() }),
          ],
          { concurrency: 2 },
        );
        const after = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.lengthOf(after.runs, 1);
        assert.lengthOf(
          after.messages.filter((item) => item.id === "promoted"),
          1,
        );
        const input = inputOf(after, "promoted");
        assert.strictEqual(input?.id, `input:${queued.id}`);
        assert.isTrue(
          input?.type === "user_message" && input.inputIntent === "promoted_queued_to_steer",
        );
        for (const stale of [
          { type: "queued-run.cancel", runId: queued.id },
          { type: "queued-run.edit", runId: queued.id, text: "changed" },
          { type: "queued-run.start", runId: queued.id },
          { type: "queued-run.reorder", runId: queued.id, beforeRunId: null },
        ] as const) {
          assert.isTrue(
            Exit.isFailure(
              yield* rpc[methods.dispatchCommand]({
                ...stale,
                threadId,
                commandId: commandId(),
              }).pipe(Effect.exit),
            ),
          );
        }
        assert.lengthOf(posts(mend, "/steer"), 1);
        assert.lengthOf(posts(mend, "/interrupt"), 0);
      }),
    ),
  );

  for (const response of ["lost", "malformed", "mismatched", "unavailable"] as const) {
    it.live(`never repeats a ${response} admission response`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          mend.workbench.steerResponse = response;
          const { rpc } = yield* pairAndConnect(mend, "UNCERTAIN");
          const cmd = message("uncertain", {
            type: "restart_active",
            targetRunId: RunId.make(turn.id),
          });
          yield* rpc[methods.dispatchCommand](cmd);
          yield* rpc[methods.dispatchCommand]({ ...cmd, commandId: commandId() });
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.strictEqual(inputOf(projection, "uncertain")?.status, "completed");
          assert.lengthOf(posts(mend, "/steer"), 1);
          assert.lengthOf(posts(mend, "/turns"), 0);
        }),
      ),
    );
  }

  for (const promotion of [false, true]) {
    it.live(`adopts exactly Mend's Queued turn for ${promotion ? "promotion" : "composer"}`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          mend.workbench.steerDelivery = {
            _tag: "Queued",
            turnId: "assigned-by-fake",
            reason: "turn-ended",
          };
          const { rpc } = yield* pairAndConnect(mend, "QUEUED");
          let queuedId: string | undefined;
          if (promotion) {
            yield* rpc[methods.dispatchCommand](message("carried", { type: "queue_after_active" }));
            queuedId = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
              (run) => run.userMessageId === "carried",
            )?.id;
          }
          yield* rpc[methods.dispatchCommand](
            queuedId === undefined
              ? message("carried", { type: "steer_active", targetRunId: RunId.make(turn.id) })
              : promote(queuedId, turn.id),
          );
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.lengthOf(
            projection.messages.filter((item) => item.id === "carried"),
            1,
          );
          const input = inputOf(projection, "carried");
          assert.notStrictEqual(input?.runId, turn.id);
          if (queuedId !== undefined) assert.strictEqual(input?.runId, queuedId);
          assert.isTrue(input?.type === "user_message" && input.inputIntent === "turn_start");
          assert.strictEqual(
            projection.runs.find((run) => run.id === input?.runId)?.status,
            "queued",
          );
          assert.lengthOf(posts(mend, "/turns"), 0);
          assert.lengthOf(mend.workbench.turns.get(threadId) ?? [], 2);
        }),
      ),
    );
  }

  for (const destination of [
    "steered-turn",
    "turn-not-from-steer",
    "turn-by-another-author",
    "turn-with-edited-input",
  ] as const) {
    it.live(`adopts no turn when a Queued receipt names a ${destination}`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          mend.workbench.steerDelivery = {
            _tag: "Queued",
            turnId: "assigned",
            reason: "turn-ended",
          };
          mend.workbench.queuedDestination = destination;
          const { rpc } = yield* pairAndConnect(mend, "DESTINATION");
          const before = yield* rpc[methods.getThreadProjection]({ threadId });
          yield* rpc[methods.dispatchCommand](
            message("misplaced", { type: "steer_active", targetRunId: RunId.make(turn.id) }),
          );
          let after = yield* rpc[methods.getThreadProjection]({ threadId });
          for (
            let attempt = 0;
            attempt < 150 && inputOf(after, "misplaced") === undefined;
            attempt++
          ) {
            yield* Effect.sleep("20 millis");
            after = yield* rpc[methods.getThreadProjection]({ threadId });
          }
          assert.strictEqual(inputOf(after, "misplaced")?.runId, turn.id);
          assert.strictEqual(
            after.runs.find((run) => run.id === turn.id)?.userMessageId,
            before.runs.find((run) => run.id === turn.id)?.userMessageId,
          );
          assert.isFalse(after.runs.some((run) => run.userMessageId === "misplaced"));
          assert.lengthOf(posts(mend, "/steer"), 1);
          assert.lengthOf(posts(mend, "/turns"), 0);
        }),
      ),
    );
  }

  for (const sender of ["someone-else", null, undefined]) {
    it.live(
      `queues a non-sender's words with sender ${String(sender)} and leaves a promotion in place`,
      () =>
        withGateway((mend) =>
          Effect.gen(function* () {
            const turn = setup(mend);
            if (sender === undefined) delete turn.steerSender;
            else turn.steerSender = sender;
            const { rpc } = yield* pairAndConnect(mend, "SENDER");
            yield* rpc[methods.dispatchCommand](
              message("mine", { type: "start_immediately" }, "steer"),
            );
            const before = yield* rpc[methods.getThreadProjection]({ threadId });
            const queued = before.runs.find((run) => run.userMessageId === "mine");
            if (queued === undefined) return yield* Effect.die("Missing fallback queue entry");
            assert.isTrue(deriveThreadQueueWorkflowState(before).canPromoteToSteer);
            yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id));
            const after = yield* rpc[methods.getThreadProjection]({ threadId });
            assert.deepStrictEqual(after.runs, before.runs);
            assert.lengthOf(posts(mend, "/steer"), 0);
            mend.workbench.setTurn(turn, "completed");
            yield* eventually(() => posts(mend, "/turns").length === 1);
            assert.strictEqual(
              posts(mend, "/turns")[0]?.authorization,
              `Bearer ${mend.claims[0]?.token}`,
            );
          }),
        ),
    );
  }

  it.live("queues exactly once when Mend observes a sender change after reservation", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "RACE");
        const barrier = mend.workbench.holdNextSteer("admission");
        const send = yield* rpc[methods.dispatchCommand](
          message("race", { type: "steer_active", targetRunId: RunId.make(turn.id) }),
        ).pipe(Effect.forkScoped);
        yield* Effect.promise(() => barrier.entered);
        turn.steerSender = "another-sender";
        barrier.release();
        yield* Fiber.join(send);
        const projection = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.lengthOf(
          projection.messages.filter((item) => item.id === "race"),
          1,
        );
        assert.strictEqual(
          projection.runs.find((run) => run.userMessageId === "race")?.status,
          "queued",
        );
        assert.lengthOf(turn.steers, 0);
        assert.lengthOf(posts(mend, "/steer"), 1);
        assert.lengthOf(posts(mend, "/turns"), 0);
      }),
    ),
  );

  for (const target of ["missing", "another-thread-turn"]) {
    it.live(`refuses ${target} without forwarding a raw turn id`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          mend.workbench.addSession({ id: "another", projectId: "project-1" });
          const other = mend.workbench.addTurn("another", "Elsewhere");
          const { rpc } = yield* pairAndConnect(mend, "TARGET");
          assert.isTrue(
            Exit.isFailure(
              yield* rpc[methods.dispatchCommand](
                message("wrong", {
                  type: "steer_active",
                  targetRunId: RunId.make(target === "missing" ? target : other.id),
                }),
              ).pipe(Effect.exit),
            ),
          );
          assert.lengthOf(posts(mend, "/steer"), 0);
          assert.lengthOf(posts(mend, "/turns"), 0);
        }),
      ),
    );
  }

  for (const boundary of ["scope", "device", "control", "empty", "image"]) {
    it.live(`refuses at the ${boundary} boundary before a durable claim`, () => {
      const path = stateFile();
      return withGateway(
        (mend) =>
          Effect.gen(function* () {
            const turn = setup(mend);
            const { rpc } = yield* pairAndConnect(
              mend,
              "BOUNDARY",
              undefined,
              boundary === "scope" ? "orchestration:read" : undefined,
            );
            if (boundary === "control") mend.workbench.control.set(threadId, false);
            if (boundary === "device") mend.revoke(mend.claims[0]?.token ?? "");
            const cmd = message("boundary", {
              type: "steer_active",
              targetRunId: RunId.make(turn.id),
            });
            const result = yield* rpc[methods.dispatchCommand]({
              ...cmd,
              text: boundary === "empty" ? " " : cmd.text,
              attachments:
                boundary === "image"
                  ? [
                      {
                        type: "image",
                        id: "foreign",
                        name: "foreign.png",
                        mimeType: "image/png",
                        sizeBytes: 12,
                      },
                    ]
                  : [],
            }).pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(result));
            assert.lengthOf(posts(mend, "/steer"), 0);
            const db = new DatabaseSync(path);
            assert.lengthOf(db.prepare("SELECT * FROM steer_messages").all(), 0);
            db.close();
          }),
        path,
      );
    });
  }

  for (const status of ["queued", "unbound", "compact"]) {
    it.live(`auto queues a ${status} target without a steer POST`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend, "codex", status === "compact" ? "/compact" : "Opening request");
          if (status === "queued") mend.workbench.setTurn(turn, "queued");
          if (status === "unbound") turn.providerTurnId = null;
          const { rpc } = yield* pairAndConnect(mend, "AUTO");
          yield* rpc[methods.dispatchCommand](
            message("after", { type: "start_immediately" }, "auto"),
          );
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.strictEqual(
            projection.runs.find((run) => run.userMessageId === "after")?.status,
            "queued",
          );
          assert.lengthOf(posts(mend, "/steer"), 0);
          if (status === "unbound") assert.lengthOf(projection.providerTurns, 0);
        }),
      ),
    );
  }

  it.live("explicit intent refuses a setup gap while legacy dispatch queues it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.setTurn(setup(mend), "completed");
        const { rpc } = yield* pairAndConnect(mend, "GAP");
        yield* rpc[methods.dispatchCommand](message("first", { type: "start_immediately" }));
        yield* eventually(() => (mend.workbench.turns.get(threadId)?.length ?? 0) === 2);
        const turn = mend.workbench.turns.get(threadId)?.[1];
        if (turn === undefined) return yield* Effect.die("Missing gateway-sent turn");
        mend.workbench.setTurn(turn, "queued");
        let starting: string | undefined;
        for (let attempt = 0; attempt < 150 && starting === undefined; attempt++) {
          starting = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
            (run) => run.userMessageId === "first" && run.status === "starting",
          )?.id;
          if (starting === undefined) yield* Effect.sleep("20 millis");
        }
        if (starting === undefined) return yield* Effect.die("The sent turn never read starting");
        assert.isTrue(
          Exit.isFailure(
            yield* rpc[methods.dispatchCommand](
              message("strict", { type: "start_immediately" }, "steer"),
            ).pipe(Effect.exit),
          ),
        );
        yield* rpc[methods.dispatchCommand](
          message("legacy", { type: "steer_active", targetRunId: RunId.make(starting) }),
        );
        const projection = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.strictEqual(
          projection.runs.find((run) => run.userMessageId === "legacy")?.status,
          "queued",
        );
        assert.isUndefined(inputOf(projection, "strict"));
        assert.lengthOf(posts(mend, "/steer"), 0);
      }),
    ),
  );

  it.live("explicit intent sends ordinarily behind an external queued turn", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        mend.workbench.setTurn(turn, "queued");
        const { rpc } = yield* pairAndConnect(mend, "EXTERNAL");
        yield* rpc[methods.dispatchCommand](
          message("ordinary", { type: "start_immediately" }, "steer"),
        );
        const input = inputOf(yield* rpc[methods.getThreadProjection]({ threadId }), "ordinary");
        assert.isTrue(input?.type === "user_message" && input.inputIntent === "queued_turn");
        mend.workbench.setTurn(turn, "completed");
        yield* eventually(() => posts(mend, "/turns").length === 1);
        assert.lengthOf(posts(mend, "/steer"), 0);
      }),
    ),
  );

  for (const delivery of ["Accepted", "Unknown", "NotSent"] as const) {
    it.live(`settles Sending to ${delivery} through live WebSocket frames`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          mend.workbench.steerDelivery = { _tag: "Sending" };
          const { rpc } = yield* pairAndConnect(mend, "SETTLE");
          const stream = yield* feed(rpc[methods.subscribeThread]({ threadId }));
          let projection = (yield* stream.next(snapshot)).projection;
          yield* rpc[methods.dispatchCommand](
            message("settlement", { type: "start_immediately" }, "steer"),
          );
          const receipt = turn.steers[0];
          if (receipt === undefined) return yield* Effect.die("No receipt");
          mend.workbench.settleSteer(
            turn,
            receipt.id,
            delivery === "Accepted"
              ? { _tag: delivery, evidence: "provider-acknowledged" }
              : { _tag: delivery, reason: "new-reason" },
          );
          for (;;) {
            const frame = yield* stream.next((item): item is Item => item.kind !== undefined);
            if (frame.kind === "snapshot") projection = frame.projection;
            if (frame.kind === "event")
              projection = applyOrchestrationV2ProjectionEvent(projection, frame.event);
            const input = inputOf(projection, "settlement");
            if (
              input?.status === (delivery === "NotSent" ? "failed" : "completed") &&
              DateTime.formatIso(input.updatedAt) === turn.steers[0]?.updatedAt
            )
              break;
          }
          assert.isTrue(deriveThreadQueueWorkflowState(projection).canPromoteToSteer);
          assert.lengthOf(
            projection.turnItems.filter((item) => item.type === "system_notice"),
            0,
          );
          assert.lengthOf(posts(mend, "/steer"), 1);
          assert.lengthOf(posts(mend, "/interrupt"), 0);
        }),
      ),
    );
  }

  it.live(
    "rejects changed text or target under an admitted id, including an ordinary-send retry",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "CONFLICT");
          const cmd = message("stable", { type: "steer_active", targetRunId: RunId.make(turn.id) });
          yield* rpc[methods.dispatchCommand](cmd);
          for (const changed of [
            { ...cmd, text: "different" },
            { ...cmd, text: "different", dispatchMode: { type: "queue_after_active" as const } },
            {
              ...cmd,
              dispatchMode: { type: "steer_active" as const, targetRunId: RunId.make("different") },
            },
          ])
            assert.isTrue(
              Exit.isFailure(
                yield* rpc[methods.dispatchCommand]({ ...changed, commandId: commandId() }).pipe(
                  Effect.exit,
                ),
              ),
            );
          assert.lengthOf(posts(mend, "/steer"), 1);
          assert.lengthOf(posts(mend, "/turns"), 0);
        }),
      ),
  );

  for (const crash of ["posting", "admitted", "adopted"]) {
    it.live(`recovers ${crash} across a gateway restart without repeating a POST`, () => {
      const path = stateFile();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend);
        if (crash === "adopted")
          mend.workbench.steerDelivery = { _tag: "Queued", turnId: "fake", reason: "turn-ended" };
        const barrier = mend.workbench.holdNextSteer(
          crash === "posting" ? "admission" : "response",
        );
        const cmd = message("survives", { type: "steer_active", targetRunId: RunId.make(turn.id) });
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "BEFORE");
            yield* rpc[methods.dispatchCommand](cmd).pipe(Effect.forkScoped);
            yield* Effect.promise(() => barrier.entered);
            const db = new DatabaseSync(path);
            const persisted = db.prepare("SELECT record FROM steer_messages").get();
            assert.include(String(persisted?.record), '"input":"survives"');
            assert.notInclude(String(persisted?.record), mend.claims[0]?.token ?? "secret");
            db.close();
          }),
        );
        barrier.release();
        yield* eventually(() => turn.steers.length === 1);
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "AFTER");
            yield* rpc[methods.dispatchCommand]({ ...cmd, commandId: commandId() });
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            assert.lengthOf(
              projection.messages.filter((item) => item.id === "survives"),
              1,
            );
            assert.strictEqual(inputOf(projection, "survives")?.status, "completed");
            assert.lengthOf(posts(mend, "/steer"), 1);
            assert.lengthOf(posts(mend, "/turns"), 0);
            if (crash === "adopted") {
              const carried = projection.runs.filter((run) => run.userMessageId === "survives");
              assert.lengthOf(carried, 1);
              assert.notStrictEqual(carried[0]?.id, turn.id);
              assert.isNotNull(carried[0]?.activeAttemptId);
            }
          }),
        );
      });
    });
  }

  it.live(
    "resumes a durable preparation with its original device before any POST was possible",
    () => {
      const path = stateFile();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend);
        const barrier = mend.workbench.holdNextImage();
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "PREPARING");
            const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
            const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
              threadId,
              messageId: MessageId.make("preparation"),
              attachments: [
                {
                  type: "image",
                  name: "image.png",
                  mimeType: "image/png",
                  sizeBytes: bytes.length,
                  dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
                },
              ],
            });
            yield* rpc[methods.dispatchCommand]({
              ...message("preparation", { type: "start_immediately" }, "steer"),
              attachments: kept.attachments,
            }).pipe(Effect.forkScoped);
            yield* Effect.promise(() => barrier.entered);
            const db = new DatabaseSync(path);
            assert.include(
              String(db.prepare("SELECT record FROM steer_messages").get()?.record),
              '"kind":"preparing"',
            );
            db.close();
            assert.lengthOf(posts(mend, "/steer"), 0);
          }),
        );
        barrier.release();
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            yield* eventually(() => turn.steers.length === 1);
            assert.strictEqual(
              posts(mend, "/steer")[0]?.authorization,
              `Bearer ${mend.claims[0]?.token}`,
            );
            const { rpc } = yield* pairAndConnect(mend, "PREPARED");
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            assert.lengthOf(
              projection.messages.filter((item) => item.id === "preparation"),
              1,
            );
            assert.lengthOf(
              projection.messages.find((item) => item.id === "preparation")?.attachments ?? [],
              1,
            );
            assert.lengthOf(posts(mend, "/steer"), 1);
          }),
        );
      });
    },
  );

  for (const phase of ["preparing", "posting", "observed"]) {
    it.live(`handles a ${phase} transaction failure without another Mend submission`, () => {
      const path = stateFile();
      return withGateway(
        (mend) =>
          Effect.gen(function* () {
            const turn = setup(mend);
            const { rpc } = yield* pairAndConnect(mend, "DISK");
            yield* rpc[methods.dispatchCommand](message("disk", { type: "queue_after_active" }));
            const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
              (run) => run.userMessageId === "disk",
            );
            if (queued === undefined) return yield* Effect.die("Missing queue entry");
            const db = new DatabaseSync(path);
            db.exec(
              `CREATE TRIGGER fail_steer BEFORE INSERT ON steer_messages WHEN json_extract(NEW.record, '$.phase.kind') = '${phase}' BEGIN SELECT RAISE(ABORT, 'disk failure'); END`,
            );
            const result = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
              Effect.exit,
            );
            assert.strictEqual(Exit.isSuccess(result), phase === "observed");
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            assert.lengthOf(
              projection.messages.filter((item) => item.id === "disk"),
              1,
            );
            assert.lengthOf(posts(mend, "/steer"), phase === "observed" ? 1 : 0);
            assert.lengthOf(posts(mend, "/turns"), 0);
            db.exec("DROP TRIGGER fail_steer");
            db.close();
          }),
        path,
      );
    });
  }

  it.live("preserves ordered image-only input and its attachment identity when promoted", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "IMAGES");
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
        const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
          threadId,
          messageId: MessageId.make("pictures"),
          attachments: ["first.png", "second.png"].map((name) => ({
            type: "image" as const,
            name,
            mimeType: "image/png",
            sizeBytes: bytes.length,
            dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
          })),
        });
        yield* rpc[methods.dispatchCommand]({
          ...message("pictures", { type: "queue_after_active" }),
          text: "",
          attachments: kept.attachments,
        });
        const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
          (run) => run.userMessageId === "pictures",
        );
        if (queued === undefined) return yield* Effect.die("Missing image queue entry");
        yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id));
        const projection = yield* rpc[methods.getThreadProjection]({ threadId });
        const input = inputOf(projection, "pictures");
        assert.isTrue(input?.type === "user_message" && input.text === "");
        if (input?.type === "user_message")
          assert.deepStrictEqual(
            input.attachments.map((image) => image.id),
            kept.attachments.map((image) => image.id),
          );
        const delivered = turn.steers[0]?.input ?? "";
        assert.isBelow(delivered.indexOf("first.png"), delivered.indexOf("second.png"));
        assert.lengthOf(posts(mend, "/images"), 2);
        assert.lengthOf(posts(mend, "/steer"), 1);
      }),
    ),
  );

  for (const action of ["run.interrupt", "thread.archive"] as const) {
    it.live(`${action} prevents a promoted message still preparing from posting`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "STOP");
          const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
          const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
            threadId,
            messageId: MessageId.make("stop-picture"),
            attachments: [
              {
                type: "image",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: bytes.length,
                dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
              },
            ],
          });
          yield* rpc[methods.dispatchCommand]({
            ...message("stop-picture", { type: "queue_after_active" }),
            attachments: kept.attachments,
          });
          const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
            (run) => run.userMessageId === "stop-picture",
          );
          if (queued === undefined) return yield* Effect.die("Missing queued image");
          const barrier = mend.workbench.holdNextImage();
          const sending = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          yield* Effect.promise(() => barrier.entered);
          yield* rpc[methods.dispatchCommand](
            action === "run.interrupt"
              ? {
                  type: action,
                  commandId: commandId(),
                  threadId,
                  runId: RunId.make(turn.id),
                  holdQueue: true,
                }
              : { type: action, commandId: commandId(), threadId },
          );
          barrier.release();
          assert.isTrue(Exit.isFailure(yield* Fiber.join(sending)));
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.strictEqual(projection.runs.find((run) => run.id === queued.id)?.status, "queued");
          assert.lengthOf(posts(mend, "/steer"), 0);
          assert.lengthOf(posts(mend, "/turns"), 0);
        }),
      ),
    );
  }

  for (const interrupted of [false, true]) {
    it.live(
      `restores a promotion once when its preparation fails${interrupted ? " after an interrupt" : ""}`,
      () =>
        withGateway((mend) =>
          Effect.gen(function* () {
            const turn = setup(mend);
            const { rpc } = yield* pairAndConnect(mend, "FAILAFTER");
            const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
            const kept = yield* rpc[WS_METHODS.assetsPersistChatAttachments]({
              threadId,
              messageId: MessageId.make("late-failure"),
              attachments: [
                {
                  type: "image",
                  name: "image.png",
                  mimeType: "image/png",
                  sizeBytes: bytes.length,
                  dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
                },
              ],
            });
            yield* rpc[methods.dispatchCommand]({
              ...message("late-failure", { type: "queue_after_active" }),
              attachments: kept.attachments,
            });
            const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
              (run) => run.userMessageId === "late-failure",
            );
            if (queued === undefined) return yield* Effect.die("Missing queued image");
            const barrier = mend.workbench.holdNextImage();
            const sending = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
              Effect.exit,
              Effect.forkScoped,
            );
            yield* Effect.promise(() => barrier.entered);
            if (interrupted)
              yield* rpc[methods.dispatchCommand]({
                type: "run.interrupt",
                commandId: commandId(),
                threadId,
                runId: RunId.make(turn.id),
                holdQueue: true,
              });
            mend.workbench.control.set(threadId, false);
            barrier.release();
            assert.isTrue(Exit.isFailure(yield* Fiber.join(sending)));
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            assert.deepStrictEqual(
              projection.runs
                .filter((run) => run.userMessageId === "late-failure")
                .map((run) => run.status),
              ["queued"],
            );
            assert.lengthOf(posts(mend, "/steer"), 0);
          }),
        ),
    );
  }

  for (const harness of ["codex", "claude"]) {
    it.live(`freezes ${harness} skill preparation through lost admission and restart`, () => {
      const path = stateFile();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend, harness);
        mend.workbench.projectSkills.set("project-1", [
          { name: "review", scope: "project", description: "Review" },
        ]);
        mend.workbench.steerResponse = "lost";
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "SKILL");
            yield* rpc[methods.dispatchCommand]({
              ...message("skill", { type: "start_immediately" }, "steer"),
              text: "please $review the parser",
            });
            assert.strictEqual(
              turn.steers[0]?.input,
              harness === "claude" ? "/review please the parser" : "please $review the parser",
            );
          }),
        );
        mend.workbench.projectSkills.clear();
        const postsBefore = posts(mend, "/images").length;
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "SKILLAFTER");
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            assert.strictEqual(
              projection.messages.find((item) => item.id === "skill")?.text,
              "please $review the parser",
            );
            assert.lengthOf(posts(mend, "/steer"), 1);
            assert.lengthOf(posts(mend, "/images"), postsBefore);
          }),
        );
      });
    });
  }

  it.live("keeps a Queued placeholder through a stale read and blocks the next ordinary turn", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        mend.workbench.steerDelivery = { _tag: "Queued", turnId: "fake", reason: "turn-ended" };
        const { rpc } = yield* pairAndConnect(mend, "DELAYED");
        const stream = yield* feed(rpc[methods.subscribeThread]({ threadId }));
        yield* stream.next(snapshot);
        const stale = mend.workbench.holdNextRequestsRead(threadId);
        mend.workbench.conversationChanged(threadId);
        yield* Effect.promise(() => Promise.all([stale.entered, stale.turnsRead]));
        yield* rpc[methods.dispatchCommand](
          message("adopt", { type: "steer_active", targetRunId: RunId.make(turn.id) }),
        );
        const destination = turn.steers[0]?.queuedTurnId;
        if (destination == null) return yield* Effect.die("Missing Queued destination");
        mend.workbench.hiddenTurns.add(destination);
        mend.workbench.setTurn(turn, "completed");
        yield* rpc[methods.dispatchCommand](message("behind", { type: "queue_after_active" }));
        stale.release();
        const read = mend.workbench.holdNextRequestsRead(threadId);
        mend.workbench.conversationChanged(threadId);
        yield* Effect.promise(() => read.entered);
        read.release();
        const before = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.lengthOf(
          before.messages.filter((item) => item.id === "adopt"),
          1,
        );
        assert.include(
          ["queued", "starting"],
          before.runs.find((run) => run.userMessageId === "adopt")?.status,
        );
        assert.lengthOf(posts(mend, "/turns"), 0);
        mend.workbench.hiddenTurns.delete(destination);
        mend.workbench.conversationChanged(threadId);
        const restored = yield* stream.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "run.updated" &&
            item.event.payload.userMessageId === "adopt" &&
            item.event.payload.activeAttemptId !== null,
        );
        assert.strictEqual(restored.event.type, "run.updated");
        assert.lengthOf(posts(mend, "/turns"), 0);
      }),
    ),
  );

  it.live(
    "settles a lost response on startup with no socket by posting it again, failed once refused, and releases the ordinary queue after its first read",
    () => {
      const path = stateFile();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend);
        mend.workbench.steerRefusal = { status: 503, tag: "Unavailable" };
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "NOSOCKET");
            yield* rpc[methods.dispatchCommand](
              message("uncertain-without-receipt", { type: "start_immediately" }, "steer"),
            );
            yield* rpc[methods.dispatchCommand](message("later", { type: "queue_after_active" }));
          }),
        );
        mend.workbench.setTurn(turn, "completed");
        mend.workbench.steerRefusal = { status: 403, tag: "TurnSteerForbidden" };
        const before = posts(mend, "/steer").length;
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            yield* eventually(() => posts(mend, "/turns").length === 1);
            yield* eventually(() => posts(mend, "/steer").length === before + 1);
            const [sent] = posts(mend, "/turns");
            assert.deepInclude(sent?.body, { input: "later" });
            const db = new DatabaseSync(path);
            yield* eventually(() => db.prepare("SELECT * FROM steer_messages").all().length === 0);
            assert.lengthOf(
              db
                .prepare("SELECT message_id FROM queued_messages WHERE message_id = ?")
                .all("uncertain-without-receipt"),
              0,
            );
            const [kept] = db.prepare("SELECT record FROM sent_steers").all();
            db.close();
            assert.deepInclude(JSON.parse(String(kept?.record)), {
              messageId: "uncertain-without-receipt",
              outcome: { kind: "failed", reason: "TurnSteerForbidden", uncertain: true },
            });
            assert.lengthOf(posts(mend, "/turns"), 1);
          }),
        );
      });
    },
  );

  it.live(
    "projects another viewer's steer from Mend readback with stable ids and no duplicate echo",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "AUTHOR");
          yield* rpc[methods.dispatchCommand](
            message("own-id", { type: "start_immediately" }, "steer"),
          );
          const observer = yield* pairAndConnect(mend, "OBSERVER", {
            id: "observer",
            name: "Observer",
            email: "observer@example.test",
          });
          const first = yield* observer.rpc[methods.getThreadProjection]({ threadId });
          const second = yield* observer.rpc[methods.getThreadProjection]({ threadId });
          const input = first.turnItems.find(
            (item) => item.type === "user_message" && item.inputIntent === "steer",
          );
          assert.isDefined(input);
          assert.deepStrictEqual(
            second.turnItems.find((item) => item.id === input?.id),
            input,
          );
          assert.lengthOf(
            first.messages.filter((item) => item.text === "own-id"),
            1,
          );
          assert.isTrue(deriveThreadQueueWorkflowState(first).canPromoteToSteer);
          assert.lengthOf(posts(mend, "/steer"), 1);
        }),
      ),
  );

  for (const winner of ["promotion", "dispatch"]) {
    it.live(`lets ${winner} win a promotion versus completion race once`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "WINNER");
          yield* rpc[methods.dispatchCommand](message("winner", { type: "queue_after_active" }));
          const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
            (run) => run.userMessageId === "winner",
          );
          if (queued === undefined) return yield* Effect.die("Missing queued run");
          if (winner === "promotion") {
            const barrier = mend.workbench.holdNextSteer("admission");
            const sending = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
              Effect.forkScoped,
            );
            yield* Effect.promise(() => barrier.entered);
            mend.workbench.setTurn(turn, "completed");
            barrier.release();
            yield* Fiber.join(sending);
          } else {
            mend.workbench.setTurn(turn, "completed");
            yield* eventually(() => posts(mend, "/turns").length === 1);
            assert.isTrue(
              Exit.isFailure(
                yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(Effect.exit),
              ),
            );
          }
          assert.lengthOf(posts(mend, "/steer"), winner === "promotion" ? 1 : 0);
          assert.lengthOf(posts(mend, "/turns"), winner === "dispatch" ? 1 : 0);
          assert.lengthOf(
            (yield* rpc[methods.getThreadProjection]({ threadId })).messages.filter(
              (item) => item.id === "winner",
            ),
            1,
          );
        }),
      ),
    );
  }

  it.live("takes edits before promotion and refuses a promotion after cancellation", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "EDIT");
        for (const id of ["edit", "cancel"])
          yield* rpc[methods.dispatchCommand](message(id, { type: "queue_after_active" }));
        const before = yield* rpc[methods.getThreadProjection]({ threadId });
        const edit = before.runs.find((run) => run.userMessageId === "edit");
        const cancel = before.runs.find((run) => run.userMessageId === "cancel");
        if (edit === undefined || cancel === undefined)
          return yield* Effect.die("Missing queue entries");
        yield* rpc[methods.dispatchCommand]({
          type: "queued-run.edit",
          commandId: commandId(),
          threadId,
          runId: edit.id,
          text: "edited",
        });
        yield* rpc[methods.dispatchCommand](promote(edit.id, turn.id));
        assert.strictEqual(turn.steers[0]?.input, "edited");
        yield* rpc[methods.dispatchCommand]({
          type: "queued-run.cancel",
          commandId: commandId(),
          threadId,
          runId: cancel.id,
        });
        assert.isTrue(
          Exit.isFailure(
            yield* rpc[methods.dispatchCommand](promote(cancel.id, turn.id)).pipe(Effect.exit),
          ),
        );
        assert.lengthOf(posts(mend, "/steer"), 1);
      }),
    ),
  );

  it.live("keeps waiting request links valid while upstream disables promotion", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const request = mend.workbench.addRequest(turn, { kind: "command-approval" });
        const { rpc } = yield* pairAndConnect(mend, "WAITING");
        const projection = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.isFalse(deriveThreadQueueWorkflowState(projection).canPromoteToSteer);
        assert.strictEqual(projection.runs[0]?.status, "waiting");
        assert.strictEqual(projection.nodes[0]?.status, "waiting");
        assert.strictEqual(
          projection.runtimeRequests.find((item) => item.id === request.id)?.nodeId,
          projection.nodes[0]?.id,
        );
        assert.strictEqual(projection.providerTurns[0]?.status, "running");
        assert.isTrue(
          Exit.isFailure(
            yield* rpc[methods.dispatchCommand](
              message("wait", { type: "start_immediately" }, "steer"),
            ).pipe(Effect.exit),
          ),
        );
        assert.lengthOf(posts(mend, "/steer"), 0);
      }),
    ),
  );
  for (const text of ["/compact", " /LOGOUT "]) {
    it.live(`refuses steering ${text}, which upstream runs only as its own turn`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "COMMAND");
          assert.isTrue(
            Exit.isFailure(
              yield* rpc[methods.dispatchCommand]({
                ...message("maintenance", { type: "start_immediately" }, "steer"),
                text,
              }).pipe(Effect.exit),
            ),
          );
          assert.lengthOf(posts(mend, "/steer"), 0);
          assert.lengthOf(posts(mend, "/interrupt"), 0);
        }),
      ),
    );
  }

  it.live("restores concurrent refused promotions in their original order", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "POSITIONS");
        for (const id of ["a", "b", "c"])
          yield* rpc[methods.dispatchCommand](message(id, { type: "queue_after_active" }));
        const before = yield* rpc[methods.getThreadProjection]({ threadId });
        const a = before.runs.find((run) => run.userMessageId === "a");
        const b = before.runs.find((run) => run.userMessageId === "b");
        if (a === undefined || b === undefined) return yield* Effect.die("Missing queued runs");
        const first = mend.workbench.holdNextSteer("admission");
        const sendingB = yield* rpc[methods.dispatchCommand](promote(b.id, turn.id)).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Effect.promise(() => first.entered);
        const second = mend.workbench.holdNextSteer("admission");
        const sendingA = yield* rpc[methods.dispatchCommand](promote(a.id, turn.id)).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Effect.promise(() => second.entered);
        mend.workbench.steerRefusal = { status: 409, tag: "ProtocolSessionNotLive" };
        first.release();
        assert.isTrue(Exit.isFailure(yield* Fiber.join(sendingB)));
        second.release();
        assert.isTrue(Exit.isFailure(yield* Fiber.join(sendingA)));
        const after = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.deepStrictEqual(
          after.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          ["a", "b", "c"],
        );
        assert.lengthOf(posts(mend, "/turns"), 0);
      }),
    ),
  );

  it.live("a steer lets go of a snooze in the state file too", () => {
    const path = stateFile();
    const snoozes = () => {
      const db = new DatabaseSync(path);
      const rows = db.prepare("SELECT snoozed_until FROM thread_lifecycles").all();
      db.close();
      return rows.map((row) => row.snoozed_until);
    };
    return withGateway(
      (mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "SNOOZE");
          yield* rpc[methods.getThreadProjection]({ threadId });
          yield* rpc[methods.dispatchCommand]({
            type: "thread.snooze",
            commandId: commandId(),
            threadId,
            snoozedUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          });
          assert.lengthOf(
            snoozes().filter((until) => until !== null),
            1,
          );
          advanceClock(Date.now());
          yield* rpc[methods.dispatchCommand](
            message("wake", { type: "steer_active", targetRunId: RunId.make(turn.id) }),
          );
          yield* eventually(() => snoozes().every((until) => until === null));
        }),
      path,
    );
  });
});
