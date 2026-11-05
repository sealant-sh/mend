import { PlanId, ORCHESTRATION_V2_WS_METHODS as methods } from "@mend/t3-contracts";
import { Effect, Exit } from "effect";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { commandId, eventually, gateway, message, posts, setup, threadId } from "./support/steering.ts";

describe("T3 native proposed plans", () => {
  it.live("snapshots Plan, projects an actionable card, and implements as a new default turn", () => Effect.gen(function* () {
    const mend = yield* startFakeMend;
    const turn = setup(mend);
    const proposal = mend.workbench.addItem(turn, { kind: "plan", text: "# Proposal\n\nExact markdown", data: { _tag: "ProposedPlan" }, status: "completed" });
    yield* gateway(mend, ":memory:", Effect.gen(function* () {
      const { rpc } = yield* pairAndConnect(mend, "PLANNING");
      const dispatch = rpc[methods.dispatchCommand];
      const get = () => rpc[methods.getThreadProjection]({ threadId });
      const planCommand = { type: "thread.interaction-mode.set" as const, commandId: commandId(), threadId, interactionMode: "plan" as const };
      yield* dispatch(planCommand);
      assert.strictEqual((yield* get()).thread.interactionMode, "plan");
      yield* dispatch(message("refinement", { type: "queue_after_active" }));
      yield* dispatch({ ...planCommand, commandId: commandId(), interactionMode: "default" });
      yield* dispatch(planCommand);
      assert.strictEqual((yield* get()).thread.interactionMode, "default");
      const projected = yield* get();
      assert.deepInclude(projected.plans[0], { kind: "proposed_plan", status: "active", markdown: "# Proposal\n\nExact markdown" });
      const card = projected.turnItems.find(item => item.type === "proposed_plan");
      assert.isDefined(card);
      const sourcePlanRef = { threadId, planId: PlanId.make(`mend-plan:${proposal.id}`) };
      const implement = { ...message("implement", { type: "steer_active" as const, targetRunId: projected.runs[0]?.id ?? threadId }), sourcePlanRef };
      yield* dispatch(implement);
      yield* dispatch({ ...implement, commandId: commandId() });
      assert.lengthOf(posts(mend, "/steer"), 0);
      const consumed = yield* get();
      assert.strictEqual(consumed.plans[0]?.status, "completed");
      assert.deepStrictEqual(consumed.runs.find(run => run.userMessageId === implement.messageId)?.sourcePlanRef, sourcePlanRef);
      const conflict = yield* dispatch({ ...implement, commandId: commandId(), text: "different" }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(conflict));
      mend.workbench.setTurn(turn, "completed");
      yield* eventually(() => (mend.workbench.turns.get(threadId)?.length ?? 0) >= 2);
      assert.strictEqual(mend.workbench.turns.get(threadId)?.[1]?.selection?.interactionMode, "plan");
    }));
  }));
});
