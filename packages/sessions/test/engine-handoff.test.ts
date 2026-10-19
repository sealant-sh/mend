import * as fs from "node:fs";
import * as path from "node:path";

import { SessionEngine } from "@mend/sessions";
import { skippedFreshen, Store } from "@mend/store";
import { buildHandoffBundle, sh } from "@mend/store/testing/handoff";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Result } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { setup, withEngine } from "./engine/fixture.ts";

/**
 * A handoff through the engine (docs/specs/mend-handoff.md, "One creation path"): it never
 * joins a worktree by name. A name already taken fails the create, and the taken worktree is
 * left as it was.
 */
describe("SessionEngine handoff", () => {
  it("refuses a handoff under a taken worktree name: no join, no second worktree, no session", async () => {
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const store = yield* Store;
          const checkout = path.join(tmp, "checkout");
          sh(tmp, ["clone", "-q", path.join(tmp, "origin"), checkout]);
          sh(checkout, ["checkout", "-q", "-b", "fix/login"]);
          fs.writeFileSync(path.join(checkout, "login.ts"), "export const login = () => true;\n");
          sh(checkout, ["add", "-A"]);
          sh(checkout, ["commit", "-q", "-m", "login"]);
          const bundle = buildHandoffBundle(checkout);
          const admitted = yield* store.admitHandoff(
            project.storePath,
            project.defaultBranch,
            bundle.bytes,
            { freshen: Effect.succeed(skippedFreshen("no credential in this test")), fileBytes: 0 },
          );
          const taken = yield* engine.ensureWorktree(
            project.id,
            { name: "fix-login", start: { kind: "base", base: null } },
            "user-fixture",
          );
          const refused = yield* engine
            .provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "fix-login",
              start: { kind: "handoff", admitted },
              ownerUserId: "user-fixture",
            })
            .pipe(Effect.result);
          if (Result.isFailure(refused) && refused.failure._tag === "GitError") {
            expect(refused.failure.stderr).toMatch(/already exists/);
          } else {
            expect.unreachable("the taken name was not refused with a GitError");
          }
          expect([...world.worktrees.values()].map((worktree) => worktree.id)).toEqual([taken.id]);
          expect(world.worktrees.get(taken.id)?.handoff).toBeNull();
          expect(world.sessions.size).toBe(0);
        }),
      { captured: makeMemoryCaptureStore() },
    );
  });
});
