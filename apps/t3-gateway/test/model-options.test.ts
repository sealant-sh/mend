import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ProviderInstanceId,
  RunId,
  ORCHESTRATION_V2_WS_METHODS as methods,
  type ModelSelection,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { FAST_TIER_REFUSAL } from "../src/server-config.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { keyedMessageFields } from "./support/keyed-message.ts";
import { pairAndConnect } from "./support/rpc.ts";
import {
  commandId,
  eventually,
  gateway,
  message,
  posts,
  projectionWhen,
  setup,
  threadId,
} from "./support/steering.ts";

type Rpc = Effect.Success<ReturnType<typeof pairAndConnect>>["rpc"];
const on = (model: string, effort?: string, harness = "codex"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(harness === "claude" ? "claudeAgent" : harness),
  model,
  ...(effort === undefined
    ? {}
    : { options: [{ id: harness === "claude" ? "effort" : "reasoningEffort", value: effort }] }),
});
const pick = (rpc: Rpc, modelSelection: ModelSelection) =>
  rpc[methods.dispatchCommand]({
    type: "thread.model-selection.set",
    commandId: commandId(),
    threadId,
    modelSelection,
  });
const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* gateway(mend, ":memory:", test(mend));
  });
const get = (rpc: Rpc) => rpc[methods.getThreadProjection]({ threadId });
const statePath = () => join(mkdtempSync(join(tmpdir(), "t3-live-choices-")), "state.sqlite");

describe("live model and effort selections", () => {
  // T3 v0.1.2 SteeringCompletion.integration.test.ts:686-729 and 762 onward.
  for (const harness of ["codex", "claude"] as const) {
    it.live(
      `${harness} keeps native steering on its running selection and uses the picker on the next turn`,
      () =>
        withGateway((mend) =>
          Effect.gen(function* () {
            const active = setup(mend, harness);
            const { rpc } = yield* pairAndConnect(mend, `LIVE-${harness}`);
            const before = yield* get(rpc);
            const chosen = on(
              harness === "codex" ? "gpt-6.1-astra" : "claude-sonnet-4-6",
              "high",
              harness,
            );
            yield* pick(rpc, chosen);
            const picked = yield* get(rpc);
            assert.deepStrictEqual(picked.thread.modelSelection, chosen);
            assert.deepStrictEqual(picked.runs[0], before.runs[0]);
            assert.isNull(picked.providerSessions[0]?.model);
            assert.lengthOf(posts(mend, "/turns"), 0);
            assert.lengthOf(posts(mend, "/steer"), 0);
            assert.lengthOf(posts(mend, "/launch"), 0);
            const cmd = {
              ...message("steer", { type: "steer_active", targetRunId: RunId.make(active.id) }),
              modelSelection: chosen,
            };
            yield* rpc[methods.dispatchCommand](cmd);
            const steered = yield* get(rpc);
            assert.lengthOf(steered.runs, 1);
            assert.deepStrictEqual(steered.runs[0], before.runs[0]);
            assert.lengthOf(steered.attempts, 1);
            assert.deepStrictEqual(active.selection, {
              harness,
              interactionMode: "default",
              model: harness === "codex" ? "gpt-6.1-sol" : "fable",
              effort: null,
            });
            assert.deepStrictEqual(active.steers[0]?.selection, {
              harness,
              interactionMode: "default",
              model: chosen.model,
              effort: "high",
            });
            // Changing a picker does not change a repeated admission or reapply its side effects.
            const later = on(chosen.model, "low", harness);
            yield* pick(rpc, later);
            yield* rpc[methods.dispatchCommand]({ ...cmd, commandId: commandId() });
            assert.lengthOf(posts(mend, "/steer"), 1);
            assert.deepStrictEqual((yield* get(rpc)).thread.modelSelection, later);
            const conflict = yield* Effect.exit(
              rpc[methods.dispatchCommand]({
                ...cmd,
                commandId: commandId(),
                modelSelection: later,
              }),
            );
            assert.isTrue(Exit.isFailure(conflict));
            mend.workbench.setTurn(active, "completed");
            yield* rpc[methods.dispatchCommand](message("next", { type: "queue_after_active" }));
            yield* eventually(() => posts(mend, "/turns").length === 1);
            assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, {
              ...keyedMessageFields(posts(mend, "/turns")[0]?.body),
              input: "next",
              selection: { harness, model: later.model, effort: "low", interactionMode: "default" },
            });
            const next = yield* projectionWhen(rpc, (p) => p.runs.length === 2);
            assert.deepStrictEqual(next.runs[0]?.modelSelection, before.runs[0]?.modelSelection);
            assert.deepStrictEqual(next.runs[1]?.modelSelection, later);
            assert.lengthOf(posts(mend, "/launch"), 0);
            assert.lengthOf(posts(mend, "/interrupt"), 0);
            assert.strictEqual(
              posts(mend, "/turns")[0]?.authorization,
              `Bearer ${mend.claims[0]?.token}`,
            );
          }),
        ),
    );
  }

  it.live(
    "keeps two queued snapshots across edits, reorder, picker changes and gateway restart",
    () => {
      const path = statePath();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const active = setup(mend);
        const a = on("gpt-6.1-astra", "high");
        const b = on("gpt-6.1-sol", "low");
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "QUEUE-CHOICES");
            yield* rpc[methods.dispatchCommand]({
              ...message("a", { type: "queue_after_active" }),
              modelSelection: a,
            });
            yield* rpc[methods.dispatchCommand]({
              ...message("b", { type: "queue_after_active" }),
              modelSelection: b,
            });
            const queued = yield* get(rpc);
            const arun = queued.runs.find((r) => r.userMessageId === "a");
            const brun = queued.runs.find((r) => r.userMessageId === "b");
            if (arun === undefined || brun === undefined) return yield* Effect.die("queue missing");
            yield* rpc[methods.dispatchCommand]({
              type: "queued-run.edit",
              commandId: commandId(),
              threadId,
              runId: arun.id,
              text: "a edited",
            });
            yield* rpc[methods.dispatchCommand]({
              type: "queued-run.reorder",
              commandId: commandId(),
              threadId,
              runId: brun.id,
              beforeRunId: arun.id,
            });
            yield* pick(rpc, on("gpt-6.1-astra", "medium"));
            const edited = yield* get(rpc);
            assert.deepStrictEqual(edited.runs.find((r) => r.id === arun.id)?.modelSelection, a);
            assert.deepStrictEqual(edited.runs.find((r) => r.id === brun.id)?.modelSelection, b);
          }),
        );
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "QUEUE-RESTART");
            mend.workbench.setTurn(active, "completed");
            yield* eventually(() => posts(mend, "/turns").length === 1);
            assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, {
              ...keyedMessageFields(posts(mend, "/turns")[0]?.body),
              input: "b",
              selection: {
                harness: "codex",
                model: b.model,
                effort: "low",
                interactionMode: "default",
              },
            });
            const next = mend.workbench.turns.get(threadId)?.at(-1);
            if (next === undefined) return yield* Effect.die("turn missing");
            mend.workbench.setTurn(next, "completed");
            yield* eventually(() => posts(mend, "/turns").length === 2);
            assert.deepStrictEqual(posts(mend, "/turns")[1]?.body, {
              ...keyedMessageFields(posts(mend, "/turns")[1]?.body),
              input: "a edited",
              selection: {
                harness: "codex",
                model: a.model,
                effort: "high",
                interactionMode: "default",
              },
            });
            assert.deepStrictEqual(
              (yield* get(rpc)).thread.modelSelection,
              on("gpt-6.1-astra", "medium"),
            );
          }),
        );
      });
    },
  );

  it.live("copies the admitted selection into a late-steer queued fallback", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const active = setup(mend);
        mend.workbench.steerDelivery = { _tag: "Sending" };
        const { rpc } = yield* pairAndConnect(mend, "FALLBACK-CHOICE");
        const chosen = on("gpt-6.1-astra", "high");
        yield* rpc[methods.dispatchCommand]({
          ...message("late", { type: "steer_active", targetRunId: RunId.make(active.id) }),
          modelSelection: chosen,
        });
        yield* pick(rpc, on("gpt-6.1-sol", "low"));
        const steer = active.steers[0];
        if (steer === undefined) return yield* Effect.die("steer missing");
        const carried = mend.workbench.carrySteer(active, steer.id);
        mend.workbench.setTurn(active, "completed");
        const projection = yield* projectionWhen(rpc, (p) =>
          p.runs.some((r) => r.userMessageId === "late"),
        );
        assert.deepStrictEqual(carried.selection, {
          harness: "codex",
          interactionMode: "default",
          model: chosen.model,
          effort: "high",
        });
        assert.deepStrictEqual(
          projection.runs.find((r) => r.userMessageId === "late")?.modelSelection,
          chosen,
        );
        assert.lengthOf(posts(mend, "/turns"), 0);
      }),
    ),
  );

  it.live("persists explicit default resets independently of launch options", () => {
    const path = statePath();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const active = setup(mend);
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "RESET-1");
          yield* pick(rpc, on("gpt-6.1-astra", "high"));
          yield* pick(rpc, on("mend:codex-default"));
          assert.deepStrictEqual((yield* get(rpc)).thread.modelSelection, on("mend:codex-default"));
        }),
      );
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "RESET-2");
          assert.deepStrictEqual((yield* get(rpc)).thread.modelSelection, on("mend:codex-default"));
          mend.workbench.setTurn(active, "completed");
          yield* rpc[methods.dispatchCommand](message("reset", { type: "queue_after_active" }));
          yield* eventually(() => posts(mend, "/turns").length === 1);
          assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, {
            ...keyedMessageFields(posts(mend, "/turns")[0]?.body),
            input: "reset",
            selection: { harness: "codex", model: null, effort: null, interactionMode: "default" },
          });
        }),
      );
    });
  });

  it.live(
    "refuses unsupported options and queues another person's message without steering their turn",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const active = setup(mend);
          active.steerSender = "another-person";
          const { rpc } = yield* pairAndConnect(mend, "REFUSALS");
          for (const selected of [
            on("claude-sonnet-4-6", "high", "claude"),
            on("gpt-6.1-sol", "imaginary"),
            { ...on("gpt-6.1-sol"), options: [{ id: "serviceTier", value: "fast" }] },
          ]) {
            const refused = yield* Effect.exit(
              rpc[methods.dispatchCommand]({
                ...message("invalid", { type: "queue_after_active" }),
                modelSelection: selected,
              }),
            );
            assert.isTrue(Exit.isFailure(refused));
            if (selected.options?.[0]?.id === "serviceTier")
              assert.include(JSON.stringify(refused), FAST_TIER_REFUSAL);
          }
          const other = yield* Effect.exit(
            rpc[methods.dispatchCommand]({
              ...message("other", { type: "steer_active", targetRunId: RunId.make(active.id) }),
              modelSelection: on("gpt-6.1-astra", "high"),
            }),
          );
          assert.isTrue(Exit.isSuccess(other));
          assert.lengthOf(posts(mend, "/turns"), 0);
          assert.lengthOf(posts(mend, "/steer"), 0);
          assert.lengthOf(posts(mend, "/launch"), 0);
        }),
      ),
  );

  it.live("keeps both picker fields unchanged when persistence fails", () => {
    const path = statePath();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "ATOMIC");
          const db = new DatabaseSync(path);
          db.exec("DROP TABLE next_efforts");
          db.close();
          assert.isTrue(Exit.isFailure(yield* Effect.exit(pick(rpc, on("gpt-6.1-astra", "high")))));
          assert.strictEqual((yield* get(rpc)).thread.modelSelection.model, "gpt-6.1-sol");
        }),
      );
    });
  });
});
