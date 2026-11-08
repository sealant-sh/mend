import { AgentConversationRepo, linuxLoginNameOf } from "@mend/db";
import { AgentTurnId, SessionProcessId } from "@mend/domain";
import { AgentTurn, Worktree } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { agentConversationStub, sealantLaunchLayer, setup, withEngine } from "./engine/fixture.ts";
import { answerLayout, LAYOUT_READY, personPlatform } from "./engine/person-fixture.ts";

const owner = "user-fixture";

describe("owner branch operations in the session engine", () => {
  it("uses the owner's exec and refuses checkout while any conversation has an active turn", async () => {
    const created: CreateOptions[] = [];
    const openTurns: AgentTurn[] = [];
    const execUsers: Array<string | null> = [];
    const gitHomes: Array<string | undefined> = [];
    const gitCalls: ReadonlyArray<string>[] = [];
    const platform = sealantLaunchLayer(
      created,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        execUsers,
        execEffect: (argv, options) => {
          const layout = answerLayout(LAYOUT_READY)(argv);
          if (layout !== undefined) return Effect.succeed(layout);
          if (
            argv.includes("node") &&
            argv.some((arg) => arg.includes("Git did not finish the branch operation"))
          ) {
            gitCalls.push(argv);
            gitHomes.push(options?.user?.home);
            return Effect.succeed({
              exitCode: 0,
              stdout: JSON.stringify({ refName: "feature/owner", branch: "feature/owner" }),
              stderr: "",
            });
          }
          return undefined;
        },
      },
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: owner,
            start: { kind: "base", base: null },
          });
          const worktree = world.worktrees.get(session.worktreeId);
          if (!worktree) return yield* Effect.die("missing worktree");
          world.worktrees.set(worktree.id, new Worktree({ ...worktree, changeOwnerProven: true }));
          const result = yield* engine.changeWorktreeBranch(session.id, owner, {
            kind: "create",
            refName: "feature/owner",
            switchRef: true,
          });
          expect(result.branch).toBe("feature/owner");
          expect(world.sessions.get(session.id)?.branch).toBe("feature/owner");
          expect(world.worktrees.get(session.worktreeId)?.branch).toBe("feature/owner");
          expect(world.sessionRuns.size).toBe(0);
          expect([...world.processes.values()].every((row) => row.kind === "shell")).toBe(true);
          expect(gitCalls).toHaveLength(1);
          expect(execUsers.at(-1)).toBe(linuxLoginNameOf(owner));
          expect(gitHomes).toEqual([`/home/${linuxLoginNameOf(owner)}`]);
          openTurns.push(new AgentTurn({
            id: AgentTurnId.make("running-turn"), sessionId: session.id,
            processId: SessionProcessId.make("running-agent"), ordinal: 0, author: owner,
            input: "Work on the current branch", status: "running", providerTurnId: "provider-turn",
            error: null, usage: null, createdAt: new Date(), startedAt: new Date(), endedAt: null,
          }));
          for (const action of [
            { kind: "switch", refName: "main" },
            { kind: "create", refName: "feature/busy", switchRef: true },
          ] satisfies import("@mend/domain/workbench").WorktreeBranchAction[]) {
            const refusal = yield* Effect.flip(engine.changeWorktreeBranch(session.id, owner, action));
            expect(refusal.code).toBe("busy");
            expect(refusal.message).toMatch(/wait.*turn|stop.*turn/i);
            expect(world.worktrees.get(session.worktreeId)?.branch).toBe("feature/owner");
            expect(gitCalls).toHaveLength(1);
          }
          yield* engine.changeWorktreeBranch(session.id, owner, {
            kind: "create", refName: "feature/no-checkout", switchRef: false,
          });
          expect(gitCalls).toHaveLength(2);
          const sibling = yield* engine.provisionSessionIn(session.worktreeId, {
            harness: "codex", label: null, ownerUserId: owner,
          });
          openTurns.splice(0, openTurns.length, ...openTurns.map(turn => new AgentTurn({ ...turn, sessionId: sibling.id })));
          const refusal = yield* Effect.flip(engine.changeWorktreeBranch(session.id, owner, {
            kind: "switch", refName: "main",
          }));
          expect(refusal.message).toMatch(/wait.*turn|stop.*turn/i);
          expect(gitCalls).toHaveLength(2);

        }),
      {
        conversationLayer: Layer.succeed(AgentConversationRepo, {
          ...agentConversationStub,
          openTurns: id => Effect.succeed(openTurns.filter(turn => turn.sessionId === id)),
        }),
        captured: makeMemoryCaptureStore(),
        sealantLayer: platform,
        harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
      },
    );
  });

  it("refuses another person, unproven ownership and a shared worktree before any workspace exec", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: owner,
            start: { kind: "base", base: null },
          });
          const action = {
            kind: "switch",
            refName: "main",
          } satisfies import("@mend/domain/workbench").WorktreeBranchAction;
          expect(
            (yield* Effect.flip(engine.changeWorktreeBranch(session.id, "someone-else", action)))
              .code,
          ).toBe("forbidden");
          expect(
            (yield* Effect.flip(engine.changeWorktreeBranch(session.id, owner, action))).code,
          ).toBe("forbidden");
          const worktree = world.worktrees.get(session.worktreeId);
          if (!worktree) return yield* Effect.die("missing worktree");
          world.worktrees.set(worktree.id, new Worktree({ ...worktree, changeOwnerProven: true }));
          yield* engine.provisionSessionIn(session.worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: owner,
          });
          expect(
            (yield* Effect.flip(engine.changeWorktreeBranch(session.id, owner, action))).code,
          ).toBe("busy");
          expect(created).toHaveLength(0);
        }),
      { captured: makeMemoryCaptureStore(), sealantLayer: sealantLaunchLayer(created) },
    );
  });
});
