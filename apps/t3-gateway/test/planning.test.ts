import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  MessageId,
  ThreadId,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
  RunId,
  PlanId,
  ProviderInstanceId,
  ORCHESTRATION_V2_WS_METHODS as methods,
} from "@mend/t3-contracts";
import { Effect, Exit } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
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

describe("T3 native proposed plans", () => {
  it.live("snapshots Plan, projects an actionable card, and implements as a new default turn", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      const proposal = mend.workbench.addItem(turn, {
        kind: "plan",
        text: "# Proposal\n\nExact markdown",
        data: { _tag: "ProposedPlan" },
        status: "completed",
      });
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PLANNING");
          const dispatch = rpc[methods.dispatchCommand];
          const get = () => rpc[methods.getThreadProjection]({ threadId });
          const planCommand = {
            type: "thread.interaction-mode.set" as const,
            commandId: commandId(),
            threadId,
            interactionMode: "plan" as const,
          };
          yield* dispatch(planCommand);
          assert.strictEqual((yield* get()).thread.interactionMode, "plan");
          yield* dispatch(message("refinement", { type: "queue_after_active" }));
          yield* dispatch({ ...planCommand, commandId: commandId(), interactionMode: "default" });
          yield* dispatch(planCommand);
          assert.strictEqual((yield* get()).thread.interactionMode, "default");
          const projected = yield* get();
          assert.deepInclude(projected.plans[0], {
            kind: "proposed_plan",
            status: "active",
            markdown: "# Proposal\n\nExact markdown",
          });
          const card = projected.turnItems.find((item) => item.type === "proposed_plan");
          assert.isDefined(card);
          const sourcePlanRef = { threadId, planId: PlanId.make(`mend-plan:${proposal.id}`) };
          const implement = {
            ...message("implement", {
              type: "steer_active" as const,
              targetRunId: RunId.make(turn.id),
            }),
            sourcePlanRef,
          };
          yield* dispatch(implement);
          yield* dispatch({ ...implement, commandId: commandId() });
          assert.lengthOf(posts(mend, "/steer"), 0);
          const consumed = yield* get();
          assert.strictEqual(consumed.plans[0]?.status, "completed");
          assert.deepStrictEqual(
            consumed.runs.find((run) => run.userMessageId === implement.messageId)?.sourcePlanRef,
            sourcePlanRef,
          );
          const conflict = yield* dispatch({
            ...implement,
            commandId: commandId(),
            text: "different",
          }).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(conflict));
          mend.workbench.setTurn(turn, "completed");
          yield* eventually(() => (mend.workbench.turns.get(threadId)?.length ?? 0) >= 2);
          assert.strictEqual(
            mend.workbench.turns.get(threadId)?.[1]?.selection?.interactionMode,
            "plan",
          );
        }),
      );
    }),
  );
});

// These tests use the same WebSocket commands and subscriptions as the pinned client.
const statePath = () => join(mkdtempSync(join(tmpdir(), "mend-planning-")), "gateway.sqlite");
const toggle = (interactionMode: "plan" | "default") => ({
  type: "thread.interaction-mode.set" as const,
  commandId: commandId(),
  threadId,
  interactionMode,
});

describe("planning continuity and references", () => {
  it.live(
    "publishes a plan artifact and agrees with shell actionability without an open thread",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend);
        mend.workbench.setTurn(turn, "completed");
        yield* gateway(
          mend,
          ":memory:",
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "PLAN-EVENTS");
            const shell = yield* feed(rpc[methods.subscribeShell]({}));
            const before = yield* shell.next(
              (item): item is Extract<OrchestrationV2ShellStreamItem, { kind: "snapshot" }> =>
                item.kind === "snapshot",
            );
            assert.isFalse(before.snapshot.threads[0]?.hasActionableProposedPlan);
            const proposal = mend.workbench.addItem(turn, {
              kind: "plan",
              text: "# Observed proposal",
              data: { _tag: "ProposedPlan" },
              status: "completed",
            });
            const changed = yield* shell.next(
              (item): item is Extract<OrchestrationV2ShellStreamItem, { kind: "thread.updated" }> =>
                item.kind === "thread.updated" && item.thread.hasActionableProposedPlan,
            );
            assert.isTrue(changed.thread.hasActionableProposedPlan);
            const thread = yield* feed(rpc[methods.subscribeThread]({ threadId }));
            yield* thread.next(
              (item): item is Extract<OrchestrationV2ThreadStreamItem, { kind: "snapshot" }> =>
                item.kind === "snapshot",
            );
            const sourcePlanRef = { threadId, planId: PlanId.make(`mend-plan:${proposal.id}`) };
            yield* rpc[methods.dispatchCommand]({
              ...message("implementation-event", { type: "queue_after_active" }),
              sourcePlanRef,
            });
            const event = yield* thread.next(
              (item): item is Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }> =>
                item.kind === "event" &&
                item.event.type === "plan.updated" &&
                item.event.payload.status === "completed",
            );
            assert.strictEqual(event.event.type, "plan.updated");
            const after = yield* shell.next(
              (item): item is Extract<OrchestrationV2ShellStreamItem, { kind: "thread.updated" }> =>
                item.kind === "thread.updated" && !item.thread.hasActionableProposedPlan,
            );
            assert.isFalse(after.thread.hasActionableProposedPlan);
          }),
        );
      }),
  );

  it.live(
    "keeps queued Plan, explicit default, consumed references and keyed retries across restart",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend);
        const proposal = mend.workbench.addItem(turn, {
          kind: "plan",
          text: "# Durable",
          data: { _tag: "ProposedPlan" },
          status: "completed",
        });
        const path = statePath();
        const implementation = {
          ...message("durable-implement", { type: "queue_after_active" }),
          sourcePlanRef: { threadId, planId: PlanId.make(`mend-plan:${proposal.id}`) },
        };
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "PLAN-BEFORE");
            yield* rpc[methods.dispatchCommand](toggle("plan"));
            yield* rpc[methods.dispatchCommand](
              message("durable-refine", { type: "queue_after_active" }),
            );
            yield* rpc[methods.dispatchCommand](toggle("default"));
            yield* rpc[methods.dispatchCommand](implementation);
          }),
        );
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "PLAN-AFTER");
            const projection = yield* rpc[methods.getThreadProjection]({ threadId });
            assert.strictEqual(projection.thread.interactionMode, "default");
            assert.strictEqual(projection.plans[0]?.status, "completed");
            yield* rpc[methods.dispatchCommand]({ ...implementation, commandId: commandId() });
            const run = projection.runs.find(
              (candidate) => candidate.userMessageId === implementation.messageId,
            );
            assert.isDefined(run);
            if (run === undefined) return;
            yield* rpc[methods.dispatchCommand]({
              type: "run.interrupt",
              commandId: commandId(),
              threadId,
              runId: run.id,
              holdQueue: true,
            });
            assert.strictEqual(
              (yield* rpc[methods.getThreadProjection]({ threadId })).plans[0]?.status,
              "completed",
            );
            yield* rpc[methods.dispatchCommand]({
              type: "queue.resume",
              commandId: commandId(),
              threadId,
            });
            mend.workbench.setTurn(turn, "completed");
            yield* eventually(() => posts(mend, "/turns").length === 1);
            assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, {
              input: "durable-refine",
              selection: {
                harness: "codex",
                model: "gpt-6.1-sol",
                effort: null,
                interactionMode: "plan",
              },
            });
          }),
        );
      }),
  );

  it.live("creates an empty same-worktree thread and implements the canonical source once", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      mend.workbench.setTurn(turn, "completed");
      const proposal = mend.workbench.addItem(turn, {
        kind: "plan",
        text: "# New conversation",
        data: { _tag: "ProposedPlan" },
        status: "completed",
      });
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PLAN-NEW");
          const original = yield* rpc[methods.getThreadProjection]({ threadId });
          const createdId = ThreadId.make("plan-new-thread");
          const create = {
            type: "thread.create" as const,
            commandId: commandId(),
            threadId: createdId,
            projectId: original.thread.projectId,
            title: "Implement proposal",
            modelSelection: original.thread.modelSelection,
            runtimeMode: "approval-required" as const,
            interactionMode: "default" as const,
            branch: original.thread.branch,
            worktreePath: original.thread.worktreePath,
            createdBy: "user" as const,
            creationSource: "web" as const,
          };
          yield* rpc[methods.dispatchCommand](create);
          yield* rpc[methods.dispatchCommand](create);
          const empty = yield* rpc[methods.getThreadProjection]({ threadId: createdId });
          assert.lengthOf(empty.runs, 0);
          assert.strictEqual(empty.thread.worktreePath, original.thread.worktreePath);
          const sourcePlanRef = { threadId, planId: PlanId.make(`mend-plan:${proposal.id}`) };
          const implement = {
            ...message("implement-new", { type: "queue_after_active" }),
            threadId: createdId,
            text: "Implement this plan:\n\n# New conversation",
            sourcePlanRef,
          };
          yield* rpc[methods.dispatchCommand](implement);
          yield* eventually(() => posts(mend, "/turns").length === 1);
          assert.deepStrictEqual(posts(mend, "/turns")[0]?.body, {
            input: implement.text,
            selection: {
              harness: "codex",
              model: "gpt-6.1-sol",
              effort: null,
              interactionMode: "default",
            },
          });
          const target = yield* rpc[methods.getThreadProjection]({ threadId: createdId });
          assert.deepStrictEqual(target.runs[0]?.sourcePlanRef, sourcePlanRef);
          assert.strictEqual(
            (yield* rpc[methods.getThreadProjection]({ threadId })).plans[0]?.status,
            "completed",
          );
          assert.strictEqual(mend.workbench.sessions.size, 2);
          yield* rpc[methods.dispatchCommand]({
            type: "thread.delete",
            commandId: commandId(),
            threadId: createdId,
          });
          assert.strictEqual(
            (yield* rpc[methods.getThreadProjection]({ threadId })).plans[0]?.status,
            "completed",
          );
        }),
      );
    }),
  );

  it.live(
    "refuses wrong-mode, todo, blank, unfinished, invisible and cross-project references before sending",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend);
        const valid = mend.workbench.addItem(turn, {
          kind: "plan",
          text: "# Plan",
          data: { _tag: "ProposedPlan" },
          status: "completed",
        });
        const bad = [
          mend.workbench.addItem(turn, {
            kind: "plan",
            text: "todo",
            data: { steps: [] },
            status: "completed",
          }),
          mend.workbench.addItem(turn, {
            kind: "plan",
            text: "  ",
            data: { _tag: "ProposedPlan" },
            status: "completed",
          }),
          mend.workbench.addItem(turn, {
            kind: "plan",
            text: "# Draft",
            data: { _tag: "ProposedPlan" },
            status: "in-progress",
          }),
        ];
        mend.workbench.addProject("other-project", "other");
        mend.workbench.addSession({ id: "other-session", projectId: "other-project" });
        const other = mend.workbench.addTurn("other-session", "Other");
        const foreign = mend.workbench.addItem(other, {
          kind: "plan",
          text: "# Other",
          data: { _tag: "ProposedPlan" },
          status: "completed",
        });
        yield* gateway(
          mend,
          ":memory:",
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "PLAN-REFUSALS");
            const dispatch = rpc[methods.dispatchCommand];
            yield* dispatch(toggle("plan"));
            assert.isTrue(
              Exit.isFailure(
                yield* dispatch({
                  ...message("wrong-mode", { type: "queue_after_active" }),
                  sourcePlanRef: { threadId, planId: PlanId.make(`mend-plan:${valid.id}`) },
                }).pipe(Effect.exit),
              ),
            );
            yield* dispatch(toggle("default"));
            for (const sourcePlanRef of [
              ...bad.map((item) => ({ threadId, planId: PlanId.make(`mend-plan:${item.id}`) })),
              { threadId: ThreadId.make("missing"), planId: PlanId.make("missing") },
              {
                threadId: ThreadId.make("other-session"),
                planId: PlanId.make(`mend-plan:${foreign.id}`),
              },
            ]) {
              assert.isTrue(
                Exit.isFailure(
                  yield* dispatch({
                    ...message(`bad-${sourcePlanRef.planId}`, { type: "queue_after_active" }),
                    sourcePlanRef,
                  }).pipe(Effect.exit),
                ),
              );
            }
            assert.lengthOf(posts(mend, "/turns"), 0);
            assert.lengthOf(posts(mend, "/steer"), 0);
            mend.workbench.control.set(threadId, false);
            assert.isTrue(Exit.isFailure(yield* dispatch(toggle("plan")).pipe(Effect.exit)));
            assert.strictEqual(
              (yield* rpc[methods.getThreadProjection]({ threadId })).thread.interactionMode,
              "default",
            );
          }),
        );
      }),
  );

  it.live(
    "rolls back source consumption with a refused queue write and accepts an exact retry",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const turn = setup(mend);
        const proposal = mend.workbench.addItem(turn, {
          kind: "plan",
          text: "# Atomic",
          data: { _tag: "ProposedPlan" },
          status: "completed",
        });
        const path = statePath();
        yield* gateway(
          mend,
          path,
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "PLAN-ATOMIC");
            const database = new DatabaseSync(path);
            try {
              database.exec(
                "CREATE TRIGGER refuse_plan_queue BEFORE INSERT ON queued_messages BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
              );
              const implement = {
                ...message("atomic-implement", { type: "queue_after_active" }),
                sourcePlanRef: { threadId, planId: PlanId.make(`mend-plan:${proposal.id}`) },
              };
              assert.isTrue(
                Exit.isFailure(yield* rpc[methods.dispatchCommand](implement).pipe(Effect.exit)),
              );
              const refused = yield* rpc[methods.getThreadProjection]({ threadId });
              assert.strictEqual(refused.plans[0]?.status, "active");
              assert.isFalse(refused.runs.some((run) => run.userMessageId === implement.messageId));
              assert.lengthOf(
                database.prepare("SELECT value FROM meta WHERE key LIKE 'planning:v1:%'").all(),
                0,
              );
              database.exec("DROP TRIGGER refuse_plan_queue");
              yield* rpc[methods.dispatchCommand](implement);
              assert.strictEqual(
                (yield* rpc[methods.getThreadProjection]({ threadId })).plans[0]?.status,
                "completed",
              );
            } finally {
              database.close();
            }
          }),
        );
      }),
  );
});

it.live(
  "launches in Plan, saves its first admitted choice, and retains an explicit default reset",
  () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      const path = statePath();
      const launchedId = ThreadId.make("launched-plan");
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PLAN-LAUNCH");
          const original = yield* rpc[methods.getThreadProjection]({ threadId });
          const launched = yield* rpc[methods.launchThread]({
            commandId: commandId(),
            threadId: launchedId,
            projectId: original.thread.projectId,
            title: "Plan launch",
            generateTitle: false,
            modelSelection: original.thread.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "plan",
            workspaceStrategy: {
              type: "existing_worktree",
              worktreePath: original.thread.worktreePath ?? "/missing",
            },
            initialMessage: {
              messageId: MessageId.make("first-plan"),
              text: "Propose the change",
              attachments: [],
            },
          });
          assert.strictEqual(launched.projection.thread.interactionMode, "plan");
          yield* eventually(() => posts(mend, "/turns").length === 1);
          assert.deepInclude(posts(mend, "/turns")[0]?.body, {
            selection: {
              harness: "codex",
              model: "gpt-6.1-sol",
              effort: null,
              interactionMode: "plan",
            },
          });
          yield* rpc[methods.dispatchCommand]({ ...toggle("default"), threadId: launchedId });
        }),
      );
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PLAN-LAUNCH-RESET");
          assert.strictEqual(
            (yield* rpc[methods.getThreadProjection]({ threadId: launchedId })).thread
              .interactionMode,
            "default",
          );
          yield* rpc[methods.dispatchCommand]({
            ...message("after-plan-launch", { type: "queue_after_active" }),
            threadId: launchedId,
          });
          assert.strictEqual(
            (yield* rpc[methods.getThreadProjection]({ threadId: launchedId })).thread
              .interactionMode,
            "default",
          );
          const session = Array.from(mend.workbench.sessions.values()).find(
            (candidate) => candidate.id !== threadId,
          );
          assert.isDefined(session);
          const prior =
            session === undefined ? undefined : mend.workbench.turns.get(session.id)?.[0];
          if (prior === undefined) return;
          mend.workbench.setTurn(prior, "completed");
          yield* eventually(() => posts(mend, "/turns").length === 2);
          assert.deepInclude(posts(mend, "/turns")[1]?.body, {
            selection: {
              harness: "codex",
              model: "gpt-6.1-sol",
              effort: null,
              interactionMode: "default",
            },
          });
        }),
      );
    }),
);

it.live(
  "shares planning choices across one account's devices and keeps another account's history separate",
  () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      const proposal = mend.workbench.addItem(turn, {
        kind: "plan",
        text: "# Shared view",
        data: { _tag: "ProposedPlan" },
        status: "completed",
      });
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const first = yield* pairAndConnect(mend, "PLAN-ACCOUNT-A");
          const same = yield* pairAndConnect(mend, "PLAN-ACCOUNT-A-DEVICE2");
          const other = yield* pairAndConnect(mend, "PLAN-ACCOUNT-B", {
            id: "user-2",
            name: "Bea",
            email: "bea@example.com",
          });
          yield* first.rpc[methods.dispatchCommand](toggle("plan"));
          assert.strictEqual(
            (yield* same.rpc[methods.getThreadProjection]({ threadId })).thread.interactionMode,
            "plan",
          );
          assert.strictEqual(
            (yield* other.rpc[methods.getThreadProjection]({ threadId })).thread.interactionMode,
            "default",
          );
          yield* first.rpc[methods.dispatchCommand](toggle("default"));
          yield* first.rpc[methods.dispatchCommand]({
            ...message("account-a-implement", { type: "queue_after_active" }),
            sourcePlanRef: { threadId, planId: PlanId.make(`mend-plan:${proposal.id}`) },
          });
          assert.strictEqual(
            (yield* same.rpc[methods.getThreadProjection]({ threadId })).plans[0]?.status,
            "completed",
          );
          assert.strictEqual(
            (yield* other.rpc[methods.getThreadProjection]({ threadId })).plans[0]?.status,
            "active",
          );
        }),
      );
    }),
);

it.live(
  "replays a native steer after the interaction preference changes, retaining its fallback choice",
  () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      mend.workbench.steerDelivery = { _tag: "Accepted", evidence: "provider-acknowledged" };
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PLAN-STEER-RETRY");
          const original = yield* rpc[methods.getThreadProjection]({ threadId });
          yield* rpc[methods.dispatchCommand](toggle("plan"));
          const steer = {
            ...message("mode-steer", { type: "steer_active", targetRunId: RunId.make(turn.id) }),
            modelSelection: original.thread.modelSelection,
          };
          yield* rpc[methods.dispatchCommand](steer);
          yield* rpc[methods.dispatchCommand](toggle("default"));
          yield* rpc[methods.dispatchCommand]({ ...steer, commandId: commandId() });
          assert.lengthOf(posts(mend, "/steer"), 1);
          const receipt = turn.steers[0];
          assert.isDefined(receipt);
          if (receipt === undefined) return;
          assert.strictEqual(receipt.selection?.interactionMode, "plan");
          const carried = mend.workbench.carrySteer(turn, receipt.id);
          assert.strictEqual(carried.selection?.interactionMode, "plan");
        }),
      );
    }),
);

it.live("replays an admission with the same catalog-clamped effort after a picker change", () =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    const active = setup(mend);
    yield* gateway(
      mend,
      ":memory:",
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "PLAN-CLAMPED-RETRY");
        yield* rpc[methods.dispatchCommand](toggle("plan"));
        const queued = {
          ...message("clamped", { type: "queue_after_active" }),
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
            options: [{ id: "reasoningEffort", value: "ultra" }],
          },
        };
        yield* rpc[methods.dispatchCommand](queued);
        yield* rpc[methods.dispatchCommand](toggle("default"));
        yield* rpc[methods.dispatchCommand]({ ...queued, commandId: commandId() });
        const conflict = yield* rpc[methods.dispatchCommand]({
          ...queued,
          commandId: commandId(),
          modelSelection: {
            ...queued.modelSelection,
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(conflict));
        mend.workbench.setTurn(active, "completed");
        yield* eventually(() => posts(mend, "/turns").length === 1);
        assert.deepInclude(posts(mend, "/turns")[0]?.body, {
          selection: {
            harness: "codex",
            model: "gpt-5.5",
            effort: "xhigh",
            interactionMode: "plan",
          },
        });
      }),
    );
  }),
);

for (const status of ["interrupted", "failed"] as const) {
  it.live(`retains ${status} proposal markdown as a draft without implementation actions`, () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const turn = setup(mend);
      mend.workbench.setTurn(turn, status);
      const item = mend.workbench.addItem(turn, {
        kind: "plan",
        text: "# Partial proposal",
        data: { _tag: "ProposedPlan" },
        status: "completed",
      });
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, `PLAN-DRAFT-${status}`);
          const projection = yield* projectionWhen(rpc, (value) => value.plans.length === 1);
          assert.deepInclude(projection.plans[0], {
            kind: "proposed_plan",
            status: "draft",
            markdown: "# Partial proposal",
          });
          assert.isTrue(
            projection.turnItems.some(
              (card) => card.type === "proposed_plan" && card.markdown === "# Partial proposal",
            ),
          );
          const refused = yield* rpc[methods.dispatchCommand]({
            ...message(`implement-${status}`, { type: "queue_after_active" }),
            sourcePlanRef: { threadId, planId: PlanId.make(`mend-plan:${item.id}`) },
          }).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(refused));
          assert.lengthOf(posts(mend, "/turns"), 0);
        }),
      );
    }),
  );
}

it.live("refuses sends and toggles after a restart encounters invalid planning metadata", () =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    setup(mend);
    const path = statePath();
    yield* gateway(
      mend,
      path,
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "PLAN-CORRUPT-BEFORE");
        yield* rpc[methods.dispatchCommand](toggle("plan"));
      }),
    );
    const database = new DatabaseSync(path);
    try {
      database
        .prepare("UPDATE meta SET value = ? WHERE key LIKE 'planning:v1:%'")
        .run('{"interactionMode":"invalid"}');
    } finally {
      database.close();
    }
    yield* gateway(
      mend,
      path,
      Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "PLAN-CORRUPT-AFTER");
        for (const command of [
          toggle("default"),
          message("unrecorded-plan", { type: "queue_after_active" }),
        ]) {
          assert.isTrue(
            Exit.isFailure(yield* rpc[methods.dispatchCommand](command).pipe(Effect.exit)),
          );
        }
        assert.lengthOf(posts(mend, "/turns"), 0);
        assert.lengthOf(posts(mend, "/steer"), 0);
      }),
    );
  }),
);
