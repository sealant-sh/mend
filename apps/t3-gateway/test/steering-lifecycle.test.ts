import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import {
  RunId,
  ORCHESTRATION_V2_WS_METHODS as methods,
  type OrchestrationV2ThreadProjection,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { afterAll, assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
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
  threadId,
  withImage,
} from "./support/steering.ts";

const scratch = (await promisify(execFile)("mktemp", ["-d", "-t", "steer.XXXXXX"])).stdout.trim();
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
const stateFile = () => join(scratch, `state-${++files}.sqlite`);

const withGateway = <A, E, R>(
  test: (mend: FakeMend) => Effect.Effect<A, E, R>,
  statePath = ":memory:",
) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* gateway(mend, statePath, test(mend));
  });

const rows = (path: string, sql: string) => {
  const db = new DatabaseSync(path);
  const found = db.prepare(sql).all();
  db.close();
  return found;
};

const messagesWithId = (projection: OrchestrationV2ThreadProjection, id: string) =>
  projection.messages.filter((item) => item.id === id);

const runIdsAreUnique = (projection: OrchestrationV2ThreadProjection) =>
  new Set(projection.runs.map((run) => run.id)).size === projection.runs.length;

const steerError = (projection: OrchestrationV2ThreadProjection, id: string) => {
  const input = inputOf(projection, id);
  return projection.turnItems.find(
    (item) => item.type === "error" && item.parentItemId === input?.id,
  );
};

describe("steer lifecycle", () => {
  it.live("a cancelled claim's worker never sends the old words of a re-promoted message", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "STALE");
        yield* rpc[methods.dispatchCommand](
          yield* withImage(rpc, message("first", { type: "queue_after_active" })),
        );
        const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
          (run) => run.userMessageId === "first",
        );
        if (queued === undefined) return yield* Effect.die("Missing queued run");
        const old = mend.workbench.holdNextImage();
        const stale = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Effect.promise(() => old.entered);
        mend.workbench.interruptUnavailable = true;
        const interrupted = yield* rpc[methods.dispatchCommand]({
          type: "run.interrupt",
          commandId: commandId(),
          threadId,
          runId: RunId.make(turn.id),
          holdQueue: false,
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(interrupted));
        yield* rpc[methods.dispatchCommand]({
          type: "queued-run.edit",
          commandId: commandId(),
          threadId,
          runId: queued.id,
          text: "second",
        });
        const fresh = mend.workbench.holdNextImage();
        const replacement = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Effect.promise(() => fresh.entered);
        old.release();
        assert.isTrue(Exit.isFailure(yield* Fiber.join(stale)));
        fresh.release();
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(replacement)));
        assert.lengthOf(turn.steers, 1);
        assert.include(turn.steers[0]?.input ?? "", "second");
        assert.notInclude(turn.steers[0]?.input ?? "", "first");
        const projection = yield* rpc[methods.getThreadProjection]({ threadId });
        const input = inputOf(projection, "first");
        assert.isTrue(input?.type === "user_message" && input.text === "second");
        assert.strictEqual(input?.status, "completed");
      }),
    ),
  );

  it.live("posts an unconfirmed steer again under its key until Mend admits it once", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        mend.workbench.steerOutages = 1;
        const { rpc } = yield* pairAndConnect(mend, "DOUBT");
        yield* rpc[methods.dispatchCommand](
          message("doubted", { type: "start_immediately" }, "steer"),
        );
        const unconfirmed = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.strictEqual(inputOf(unconfirmed, "doubted")?.status, "pending");
        yield* projectionWhen(
          rpc,
          (projection) => inputOf(projection, "doubted")?.status === "completed",
        );
        assert.lengthOf(turn.steers, 1);
        const sent = posts(mend, "/steer").map((call) => JSON.stringify(call.body));
        assert.lengthOf(sent, 2);
        assert.strictEqual(sent[0], sent[1]);
      }),
    ),
  );

  it.live(
    "ends a steer Mend never confirms as a failed input with its words, and lets it go",
    () => {
      const path = stateFile();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        setup(mend);
        mend.workbench.steerOutages = 100;
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "NEVER");
            yield* rpc[methods.dispatchCommand](
              message("never", { type: "start_immediately" }, "steer"),
            );
            const failed = yield* projectionWhen(
              rpc,
              (projection) => inputOf(projection, "never")?.status === "failed",
            );
            const input = inputOf(failed, "never");
            assert.isTrue(input?.type === "user_message" && input.text === "never");
            assert.isDefined(steerError(failed, "never"));
            const attempts = posts(mend, "/steer").length;
            assert.isAtMost(attempts, 3);
            yield* Effect.sleep("300 millis");
            assert.lengthOf(posts(mend, "/steer"), attempts);
            assert.lengthOf(rows(path, "SELECT * FROM steer_messages"), 0);
          }),
          { queueTimings: { retryBaseMs: 20, retryMaxMs: 40 } },
        );
      });
    },
  );

  it.live("keeps a steer Mend never confirmed, and its key, through replays and a restart", () => {
    const path = stateFile();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      mend.workbench.steerOutages = 3;
      const original = message("unconfirmed", { type: "start_immediately" }, "steer");
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "KEEPKEY");
          yield* rpc[methods.dispatchCommand](original);
          yield* projectionWhen(
            rpc,
            (current) => inputOf(current, "unconfirmed")?.status === "failed",
          );
          const replay = yield* rpc[methods.dispatchCommand]({
            ...original,
            commandId: commandId(),
          }).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(replay));
        }),
        { queueTimings: { retryBaseMs: 20, retryMaxMs: 40 } },
      );
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "KEEPKEYAFTER");
          yield* projectionWhen(
            rpc,
            (current) => inputOf(current, "unconfirmed")?.status === "failed",
          );
          const replay = yield* rpc[methods.dispatchCommand]({
            ...original,
            commandId: commandId(),
          }).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(replay));
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.strictEqual(inputOf(projection, "unconfirmed")?.status, "failed");
          assert.lengthOf(messagesWithId(projection, "unconfirmed"), 1);
        }),
      );
      assert.lengthOf(posts(mend, "/steer"), 3);
    });
  });

  it.live("never sends a promotion Mend never confirmed again when its message is replayed", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "KEEPPROMOTED");
          const original = message("promoted", { type: "queue_after_active" });
          yield* rpc[methods.dispatchCommand](original);
          const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
            (run) => run.userMessageId === "promoted",
          );
          if (queued === undefined) return yield* Effect.die("Missing queued run");
          mend.workbench.steerOutages = 3;
          yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id));
          yield* projectionWhen(
            rpc,
            (current) => inputOf(current, "promoted")?.status === "failed",
          );
          const replays = [
            yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(Effect.exit),
            yield* rpc[methods.dispatchCommand]({ ...original, commandId: commandId() }).pipe(
              Effect.exit,
            ),
          ];
          assert.isTrue(replays.every(Exit.isFailure));
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.strictEqual(inputOf(projection, "promoted")?.status, "failed");
          assert.isFalse(
            projection.runs.some(
              (run) => run.userMessageId === "promoted" && run.status === "queued",
            ),
          );
          assert.lengthOf(posts(mend, "/steer"), 3);
        }),
        { queueTimings: { retryBaseMs: 20, retryMaxMs: 40 } },
      );
    }),
  );

  for (const retried of ["unavailable", "refused"] as const) {
    it.live(`never admits a late steer twice when its retries come back ${retried}`, () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend);
        const late = mend.workbench.holdNextSteer("late");
        if (retried === "unavailable") mend.workbench.steerOutages = 2;
        else mend.workbench.steerRefusal = { status: 403, tag: "SessionNotSteerable" };
        yield* gateway(
          mend,
          ":memory:",
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "LATE");
            const original = message("late", { type: "start_immediately" }, "steer");
            yield* rpc[methods.dispatchCommand](original);
            yield* projectionWhen(rpc, (current) => inputOf(current, "late")?.status === "failed");
            mend.workbench.steerRefusal = null;
            for (let replay = 0; replay < 2; replay++)
              yield* rpc[methods.dispatchCommand]({ ...original, commandId: commandId() }).pipe(
                Effect.exit,
              );
            const bodies = posts(mend, "/steer").map((call) => JSON.stringify(call.body));
            assert.lengthOf(new Set(bodies), 1);
            late.release();
            yield* eventually(() =>
              turn.steers.some(
                (steer) =>
                  steer.clientSteerId !== null && bodies[0]?.includes(steer.clientSteerId) === true,
              ),
            );
            assert.lengthOf(turn.steers, 1);
          }),
          { queueTimings: { retryBaseMs: 20, retryMaxMs: 40 } },
        );
      }),
    );
  }

  it.live("keeps a steer's key when a restart lands before its first POST is answered", () => {
    const path = stateFile();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      const late = mend.workbench.holdNextSteer("admission");
      const original = message("inflight", { type: "start_immediately" }, "steer");
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "INFLIGHT");
          yield* rpc[methods.dispatchCommand](original).pipe(Effect.exit, Effect.forkScoped);
          yield* Effect.promise(() => late.entered);
        }),
      );
      mend.workbench.steerRefusal = { status: 403, tag: "SessionNotSteerable" };
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "INFLIGHTAFTER");
          yield* projectionWhen(
            rpc,
            (current) => inputOf(current, "inflight")?.status === "failed",
          );
          mend.workbench.steerRefusal = null;
          for (let replay = 0; replay < 2; replay++)
            yield* rpc[methods.dispatchCommand]({ ...original, commandId: commandId() }).pipe(
              Effect.exit,
            );
          late.release();
          yield* eventually(() => turn.steers.length > 0);
          yield* Effect.sleep("100 millis");
          assert.lengthOf(turn.steers, 1);
          assert.lengthOf(
            new Set(posts(mend, "/steer").map((call) => JSON.stringify(call.body))),
            1,
          );
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => late.release())));
    });
  });

  it.live(
    "never promotes a steer again when a restart lands before its first POST is answered",
    () => {
      const path = stateFile();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend);
        const late = mend.workbench.holdNextSteer("admission");
        const queuedId = yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "INFLIGHTPROMOTED");
            yield* rpc[methods.dispatchCommand](
              message("inflight", { type: "queue_after_active" }),
            );
            const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
              (run) => run.userMessageId === "inflight",
            );
            if (queued === undefined) return yield* Effect.die("Missing queued run");
            yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
              Effect.exit,
              Effect.forkScoped,
            );
            yield* Effect.promise(() => late.entered);
            return queued.id;
          }),
        );
        mend.workbench.steerRefusal = { status: 403, tag: "SessionNotSteerable" };
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "INFLIGHTPROMOTEDAFTER");
            yield* eventually(() => posts(mend, "/steer").length === 2);
            yield* Effect.sleep("100 millis");
            mend.workbench.steerRefusal = null;
            yield* rpc[methods.dispatchCommand](promote(queuedId, turn.id)).pipe(Effect.exit);
            late.release();
            yield* eventually(() => turn.steers.length > 0);
            yield* Effect.sleep("100 millis");
            assert.lengthOf(turn.steers, 1);
            assert.lengthOf(
              new Set(posts(mend, "/steer").map((call) => JSON.stringify(call.body))),
              1,
            );
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => late.release())));
      });
    },
  );

  it.live("shows a carried steer Mend withdraws once, failed under its input", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        mend.workbench.steerDelivery = { _tag: "Sending" };
        const { rpc } = yield* pairAndConnect(mend, "WITHDRAW");
        yield* rpc[methods.dispatchCommand](
          message("withdrawn", { type: "start_immediately" }, "steer"),
        );
        const receipt = turn.steers[0];
        if (receipt === undefined) return yield* Effect.die("No receipt");
        mend.workbench.setTurn(turn, "completed");
        const destination = mend.workbench.carrySteer(turn, receipt.id);
        yield* projectionWhen(rpc, (projection) =>
          projection.runs.some(
            (run) => run.userMessageId === "withdrawn" && run.activeAttemptId !== null,
          ),
        );
        mend.workbench.withdrawSteer(turn, receipt.id);
        const projection = yield* projectionWhen(
          rpc,
          (current) => inputOf(current, "withdrawn")?.status === "failed",
        );
        assert.lengthOf(messagesWithId(projection, "withdrawn"), 1);
        assert.strictEqual(inputOf(projection, "withdrawn")?.runId, turn.id);
        assert.isDefined(steerError(projection, "withdrawn"));
        assert.isUndefined(projection.runs.find((run) => run.id === destination.id));
        assert.isTrue(runIdsAreUnique(projection));
        assert.lengthOf(posts(mend, "/turns"), 0);
      }),
    ),
  );

  it.live("returns a promotion to its place once when Mend withdraws its Queued turn", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "WITHDRAWQ");
        for (const id of ["first", "middle", "last"])
          yield* rpc[methods.dispatchCommand](message(id, { type: "queue_after_active" }));
        const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
          (run) => run.userMessageId === "middle",
        );
        if (queued === undefined) return yield* Effect.die("Missing queued run");
        mend.workbench.steerDelivery = { _tag: "Queued", turnId: "fake", reason: "turn-ended" };
        const held = mend.workbench.holdNextSteer("response");
        const promoting = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Effect.promise(() => held.entered);
        yield* projectionWhen(rpc, (projection) =>
          projection.runs.some((run) => run.id === queued.id && run.activeAttemptId !== null),
        );
        const receipt = turn.steers[0];
        if (receipt === undefined) return yield* Effect.die("No receipt");
        mend.workbench.withdrawSteer(turn, receipt.id);
        held.release();
        assert.isTrue(Exit.isFailure(yield* Fiber.join(promoting)));
        const projection = yield* projectionWhen(
          rpc,
          (current) =>
            current.runs.filter((run) => run.id === queued.id).length === 1 &&
            current.runs.find((run) => run.id === queued.id)?.status === "queued",
        );
        assert.isTrue(runIdsAreUnique(projection));
        assert.lengthOf(messagesWithId(projection, "middle"), 1);
        assert.deepStrictEqual(
          projection.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          ["first", "middle", "last"],
        );
        assert.lengthOf(posts(mend, "/turns"), 0);
      }),
    ),
  );

  it.live("never maps a Queued destination before a read shows it is the steer's own", () => {
    const path = stateFile();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      mend.workbench.steerDelivery = { _tag: "Queued", turnId: "fake", reason: "turn-ended" };
      mend.workbench.queuedDestination = "turn-with-edited-input";
      mend.workbench.hideDestinations = true;
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "DELAYED");
          yield* rpc[methods.dispatchCommand](
            message("delayed", { type: "start_immediately" }, "steer"),
          );
          mend.workbench.hiddenTurns.clear();
          mend.workbench.conversationChanged(threadId);
          yield* projectionWhen(rpc, (projection) =>
            projection.runs.some((run) => run.id === turn.steers[0]?.queuedTurnId),
          );
        }),
      );
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "DELAYEDAFTER");
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.lengthOf(messagesWithId(projection, "delayed"), 1);
          assert.isTrue(runIdsAreUnique(projection));
        }),
      );
    });
  });

  it.live("keeps a recovered composer steer Mend refuses as a failed input with its words", () => {
    const path = stateFile();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      const barrier = mend.workbench.holdNextImage();
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "RECOVER");
          yield* rpc[methods.dispatchCommand](
            yield* withImage(rpc, message("recovered", { type: "start_immediately" }, "steer")),
          ).pipe(Effect.forkScoped);
          yield* Effect.promise(() => barrier.entered);
        }),
      );
      barrier.release();
      mend.workbench.steerRefusal = { status: 403, tag: "SessionNotSteerable" };
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "RECOVERED");
          const projection = yield* projectionWhen(
            rpc,
            (current) => inputOf(current, "recovered")?.status === "failed",
          );
          const input = inputOf(projection, "recovered");
          assert.isTrue(input?.type === "user_message" && input.text === "recovered");
          assert.isDefined(steerError(projection, "recovered"));
          assert.lengthOf(messagesWithId(projection, "recovered"), 1);
        }),
      );
    });
  });

  it.live("a retried message waits for its unfinished steer, so its words are never dropped", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const barrier = mend.workbench.holdNextImage();
        const sent = yield* Effect.scoped(
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "GONE");
            const original = yield* withImage(
              rpc,
              message("retried", { type: "start_immediately" }, "auto"),
            );
            yield* rpc[methods.dispatchCommand](original).pipe(Effect.forkScoped);
            yield* Effect.promise(() => barrier.entered);
            return original;
          }),
        );
        mend.workbench.setTurn(turn, "completed");
        const { rpc } = yield* pairAndConnect(mend, "BACK");
        yield* projectionWhen(rpc, (projection) => projection.runs[0]?.status === "completed");
        const retry = yield* rpc[methods.dispatchCommand]({ ...sent, commandId: commandId() }).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Effect.sleep("100 millis");
        yield* rpc[methods.dispatchCommand]({
          type: "thread.archive",
          commandId: commandId(),
          threadId,
        });
        barrier.release();
        const retried = yield* Fiber.join(retry);
        const projection = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.notStrictEqual(
          Exit.isFailure(retried),
          messagesWithId(projection, "retried").length === 1,
        );
        assert.lengthOf(posts(mend, "/steer"), 0);
      }),
    ),
  );

  it.live("keeps a steer whose caller left as a failed input when archiving stops it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const barrier = mend.workbench.holdNextImage();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "LEFT");
            yield* rpc[methods.dispatchCommand](
              yield* withImage(rpc, message("left", { type: "start_immediately" }, "steer")),
            ).pipe(Effect.forkScoped);
            yield* Effect.promise(() => barrier.entered);
          }),
        );
        const { rpc } = yield* pairAndConnect(mend, "ARCHIVER");
        yield* rpc[methods.dispatchCommand]({
          type: "thread.archive",
          commandId: commandId(),
          threadId,
        });
        barrier.release();
        const projection = yield* projectionWhen(
          rpc,
          (current) => inputOf(current, "left")?.status === "failed",
        );
        assert.lengthOf(messagesWithId(projection, "left"), 1);
        assert.lengthOf(posts(mend, "/steer"), 0);
      }),
    ),
  );

  it.live("retries a refused promotion's return to the queue until the state file keeps it", () => {
    const path = stateFile();
    return withGateway(
      (mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "REKEEP");
          yield* rpc[methods.dispatchCommand](message("rekept", { type: "queue_after_active" }));
          const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
            (run) => run.userMessageId === "rekept",
          );
          if (queued === undefined) return yield* Effect.die("Missing queued run");
          const db = new DatabaseSync(path);
          db.exec(
            `CREATE TRIGGER fail_restore BEFORE INSERT ON queued_messages WHEN NEW.run_id = '${queued.id}' BEGIN SELECT RAISE(ABORT, 'disk failure'); END`,
          );
          mend.workbench.steerRefusal = { status: 409, tag: "ProtocolSessionNotLive" };
          const result = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
            Effect.exit,
          );
          assert.isTrue(Exit.isFailure(result));
          db.exec("DROP TRIGGER fail_restore");
          db.close();
          yield* eventually(
            () =>
              rows(path, `SELECT run_id FROM queued_messages WHERE run_id = '${queued.id}'`)
                .length === 1,
          );
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.strictEqual(projection.runs.find((run) => run.id === queued.id)?.status, "queued");
          assert.lengthOf(messagesWithId(projection, "rekept"), 1);
        }),
      path,
    );
  });

  it.live("returns a recovered promotion whose sender is gone to its place, failed", () => {
    const path = stateFile();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      const barrier = mend.workbench.holdNextImage();
      const queuedId = yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "SENDER");
          for (const id of ["before", "orphan", "after"])
            yield* rpc[methods.dispatchCommand](
              id === "orphan"
                ? yield* withImage(rpc, message(id, { type: "queue_after_active" }))
                : message(id, { type: "queue_after_active" }),
            );
          const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
            (run) => run.userMessageId === "orphan",
          );
          if (queued === undefined) return yield* Effect.die("Missing queued run");
          yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(Effect.forkScoped);
          yield* Effect.promise(() => barrier.entered);
          return queued.id;
        }),
      );
      barrier.release();
      const db = new DatabaseSync(path);
      db.exec(`UPDATE bearer_sessions SET revoked_at = ${Date.now()}`);
      db.close();
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "OTHERDEVICE");
          const projection = yield* projectionWhen(
            rpc,
            (current) => current.runs.find((run) => run.id === queuedId)?.status === "failed",
          );
          assert.deepStrictEqual(
            projection.runs
              .filter((run) => run.status === "queued" || run.status === "failed")
              .map((run) => run.userMessageId),
            ["before", "orphan", "after"],
          );
          assert.lengthOf(messagesWithId(projection, "orphan"), 1);
          assert.lengthOf(posts(mend, "/steer"), 0);
        }),
      );
    });
  });

  it.live("archiving then unarchiving never revives a promotion still preparing", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "REVIVE");
        yield* rpc[methods.dispatchCommand](
          yield* withImage(rpc, message("revived", { type: "queue_after_active" })),
        );
        const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
          (run) => run.userMessageId === "revived",
        );
        if (queued === undefined) return yield* Effect.die("Missing queued run");
        const barrier = mend.workbench.holdNextImage();
        const promoting = yield* rpc[methods.dispatchCommand](promote(queued.id, turn.id)).pipe(
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Effect.promise(() => barrier.entered);
        for (const type of ["thread.archive", "thread.unarchive"] as const)
          yield* rpc[methods.dispatchCommand]({ type, commandId: commandId(), threadId });
        barrier.release();
        assert.isTrue(Exit.isFailure(yield* Fiber.join(promoting)));
        yield* Effect.sleep("200 millis");
        const projection = yield* rpc[methods.getThreadProjection]({ threadId });
        assert.strictEqual(projection.runs.find((run) => run.id === queued.id)?.status, "queued");
        assert.lengthOf(posts(mend, "/steer"), 0);
        assert.lengthOf(posts(mend, "/turns"), 0);
      }),
    ),
  );

  it.live(
    "shows a Queued destination as queued behind the running turn, which stays steerable",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = setup(mend);
          mend.workbench.steerDelivery = { _tag: "Queued", turnId: "fake", reason: "compact-turn" };
          const { rpc } = yield* pairAndConnect(mend, "BEHIND");
          yield* rpc[methods.dispatchCommand](
            message("carried", { type: "start_immediately" }, "steer"),
          );
          const projection = yield* projectionWhen(rpc, (current) =>
            current.runs.some(
              (run) => run.userMessageId === "carried" && run.activeAttemptId !== null,
            ),
          );
          assert.strictEqual(
            projection.runs.find((run) => run.userMessageId === "carried")?.status,
            "queued",
          );
          mend.workbench.steerDelivery = { _tag: "Accepted", evidence: "provider-acknowledged" };
          yield* rpc[methods.dispatchCommand](
            message("steered", { type: "start_immediately" }, "steer"),
          );
          assert.strictEqual(turn.steers.at(-1)?.input, "steered");
          assert.lengthOf(posts(mend, "/steer"), 2);
        }),
      ),
  );

  for (const intent of ["auto", "steer"] as const) {
    it.live(`queues /goal sent with ${intent} intent as its own turn, as upstream does`, () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "GOAL");
          yield* rpc[methods.dispatchCommand]({
            ...message("goal", { type: "start_immediately" }, intent),
            text: "/goal build a feature",
          });
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.strictEqual(
            projection.runs.find((run) => run.userMessageId === "goal")?.status,
            "queued",
          );
          assert.lengthOf(posts(mend, "/steer"), 0);
        }),
      ),
    );
  }

  it.live("keeps only what readback needs once a steer resolves", () => {
    const path = stateFile();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PRUNE");
          yield* rpc[methods.dispatchCommand](
            message("resolved", { type: "start_immediately" }, "steer"),
          );
          yield* eventually(() => rows(path, "SELECT * FROM steer_messages").length === 0);
        }),
      );
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PRUNED");
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          const input = inputOf(projection, "resolved");
          assert.strictEqual(input?.status, "completed");
          assert.isTrue(input?.type === "user_message" && input.inputIntent === "steer");
          assert.lengthOf(messagesWithId(projection, "resolved"), 1);
        }),
      );
    });
  });

  it.live("sends a plain message with nothing running even when Mend's items cannot be read", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = setup(mend);
        mend.workbench.setTurn(turn, "completed");
        mend.workbench.itemsUnavailable.add(threadId);
        const { rpc } = yield* pairAndConnect(mend, "PLAIN");
        yield* rpc[methods.dispatchCommand](
          message("plain", { type: "start_immediately" }, "auto"),
        );
        yield* eventually(() => posts(mend, "/turns").length === 1);
        assert.lengthOf(posts(mend, "/steer"), 0);
      }),
    ),
  );
});
