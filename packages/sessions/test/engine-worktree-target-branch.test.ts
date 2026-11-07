import { SessionEngine } from "@mend/sessions";
import { git } from "@mend/store";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { setup, withEngine } from "./engine/fixture.ts";

// Someone presses Create worktree in T3 with a chosen branch. This is every standalone
// creation, and the returned branch must describe the checkout the next conversation receives.
describe("explicit worktree target branches", () => {
  it("checks out an existing branch without moving it or starting a conversation", async () => {
    await withEngine((world,tmp) => Effect.gen(function* () {
      const project = yield* setup(tmp,world);
      const engine = yield* SessionEngine;
      const start: {kind:"base";base:null;targetBranch:{refName:string}} = {kind:"base",base:null,targetBranch:{refName:"main"}};
      const worktree = yield* engine.ensureWorktree(project.id,{name:"chosen",start},"owner");
      expect(worktree.branch).toBe("main");
      expect(yield* git(["branch","--show-current"],`${project.storePath}/../worktrees/${worktree.directory}`)).toBe("main");
      expect(world.sessions.size).toBe(0);
      expect(world.sessionRuns.size).toBe(0);
    }));
  });

  it("creates the requested named branch from the selected ref, refusing detached refs and collisions", async () => {
    await withEngine((world,tmp) => Effect.gen(function* () {
      const project = yield* setup(tmp,world);
      const engine = yield* SessionEngine;
      const start: {kind:"base";base:null;targetBranch:{refName:string;newRefName:string}} = {kind:"base",base:null,targetBranch:{refName:"main",newRefName:"feature/chosen"}};
      const worktree = yield* engine.ensureWorktree(project.id,{name:"new-place",start},"owner");
      expect(worktree.branch).toBe("feature/chosen");
      expect(worktree.baseRef).toBe("main");
      for (const targetBranch of [{refName:worktree.baseSha},{refName:"--force"},{refName:"missing"},{refName:"main",newRefName:"feature/chosen"}]) {
        const refusedStart: {kind:"base";base:null;targetBranch:{refName:string;newRefName?:string}} = {kind:"base",base:null,targetBranch};
        const outcome = yield* Effect.result(engine.ensureWorktree(project.id,{name:null,start:refusedStart},"owner"));
        expect(outcome._tag).toBe("Failure");
      }
      expect(world.worktrees.size).toBe(1);
      expect(world.sessions.size).toBe(0);
    }));
  });
});
