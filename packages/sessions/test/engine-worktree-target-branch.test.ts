import { SessionEngine } from "@mend/sessions";
import { CaptureSections, git } from "@mend/store";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { setup, withEngine } from "./engine/fixture.ts";

// Someone presses Create worktree in T3 with a chosen branch. This is every standalone
// creation, and the returned branch must describe the checkout the next conversation receives.
describe("explicit worktree target branches", () => {
  it("checks out an existing branch without moving it or starting a conversation", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const start: { kind: "base"; base: null; targetBranch: { refName: string } } = {
          kind: "base",
          base: null,
          targetBranch: { refName: "main" },
        };
        const worktree = yield* engine.ensureWorktree(
          project.id,
          { name: "chosen", start },
          "owner",
        );
        expect(worktree.branch).toBe("main");
        expect(
          yield* git(
            ["branch", "--show-current"],
            `${project.storePath}/../worktrees/${worktree.directory}`,
          ),
        ).toBe("main");
        expect(world.sessions.size).toBe(0);
        expect(world.sessionRuns.size).toBe(0);
      }),
    );
  });

  it("creates the requested named branch from the selected ref, refusing detached refs and collisions", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const start: {
          kind: "base";
          base: null;
          targetBranch: { refName: string; newRefName: string };
        } = {
          kind: "base",
          base: null,
          targetBranch: { refName: "main", newRefName: "feature/chosen" },
        };
        const worktree = yield* engine.ensureWorktree(
          project.id,
          { name: "new-place", start },
          "owner",
        );
        expect(worktree.branch).toBe("feature/chosen");
        expect(worktree.baseRef).toBe("main");
        for (const targetBranch of [
          { refName: worktree.baseSha },
          { refName: "--force" },
          { refName: "missing" },
          { refName: "main", newRefName: "feature/chosen" },
        ]) {
          const refusedStart: {
            kind: "base";
            base: null;
            targetBranch: { refName: string; newRefName?: string };
          } = { kind: "base", base: null, targetBranch };
          const outcome = yield* Effect.result(
            engine.ensureWorktree(project.id, { name: null, start: refusedStart }, "owner"),
          );
          expect(outcome._tag).toBe("Failure");
        }
        expect(world.worktrees.size).toBe(1);
        expect(world.sessions.size).toBe(0);
      }),
    );
  });
});

it("creates a named branch from a commit while refusing a detached checkout", async () => {
  await withEngine((world, tmp) =>
    Effect.gen(function* () {
      const project = yield* setup(tmp, world);
      const engine = yield* SessionEngine;
      const commit = yield* git(["rev-parse", "main"], project.storePath);
      const worktree = yield* engine.ensureWorktree(
        project.id,
        {
          name: null,
          start: {
            kind: "base",
            base: null,
            targetBranch: { refName: commit, newRefName: "from-commit" },
          },
        },
        "owner",
      );
      expect(worktree.branch).toBe("from-commit");
      expect(
        yield* git(
          ["rev-parse", "HEAD"],
          `${project.storePath}/../worktrees/${worktree.directory}`,
        ),
      ).toBe(commit);
    }),
  );
});

it("retains the actual named branch and exact checkout in capture zero", async () => {
  const captured = makeMemoryCaptureStore();
  await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const original = yield* git(["rev-parse", "main"], project.storePath);
        for (const [name, targetBranch] of [
          ["existing", { refName: "main" }],
          ["new", { refName: "main", newRefName: "feature/captured" }],
        ] as const) {
          const worktree = yield* engine.ensureWorktree(
            project.id,
            { name, start: { kind: "base", base: null, targetBranch } },
            "owner",
          );
          const head = [...captured.captures.values()].find(
            (row) => row.worktreeId === worktree.id && row.n === 0,
          );
          const sections = Schema.decodeUnknownSync(CaptureSections)(head?.sections);
          expect(sections.git.head).toBe(`refs/heads/${worktree.branch}`);
          expect(sections.git.refs[`refs/heads/${worktree.branch}`]).toBe(original);
          expect(worktree.branch).toBe(
            "newRefName" in targetBranch ? targetBranch.newRefName : "main",
          );
        }
        const refused = yield* Effect.result(
          engine.ensureWorktree(
            project.id,
            { name: null, start: { kind: "base", base: null, targetBranch: { refName: "main" } } },
            "owner",
          ),
        );
        expect(refused._tag).toBe("Failure");
        expect(world.worktrees.size).toBe(2);
        expect(world.sessions.size).toBe(0);
      }),
    { captured },
  );
});

it("keeps native tracking reuse and refuses conflicts without joining an existing worktree", async () => {
  await withEngine((world, tmp) =>
    Effect.gen(function* () {
      const project = yield* setup(tmp, world);
      const engine = yield* SessionEngine;
      const head = yield* git(["rev-parse", "main"], project.storePath);
      yield* git(["update-ref", "refs/remotes/origin/topic", head], project.storePath);
      const worktree = yield* engine.ensureWorktree(
        project.id,
        {
          name: "remote",
          start: { kind: "base", base: null, targetBranch: { refName: "origin/topic" } },
        },
        "owner",
      );
      expect(worktree.branch).toBe("topic");
      expect(yield* git(["config", "--get", "branch.topic.merge"], project.storePath)).toBe(
        "refs/heads/topic",
      );
      for (const [name, base, owner] of [
        ["remote", null, "owner"],
        [null, "main", "owner"],
        [null, null, null],
      ] as const) {
        const outcome = yield* Effect.result(
          engine.ensureWorktree(
            project.id,
            { name, start: { kind: "base", base, targetBranch: { refName: "main" } } },
            owner,
          ),
        );
        expect(outcome._tag).toBe("Failure");
      }
      const duplicate = yield* Effect.result(
        engine.ensureWorktree(
          project.id,
          {
            name: null,
            start: { kind: "base", base: null, targetBranch: { refName: "origin/topic" } },
          },
          "owner",
        ),
      );
      expect(duplicate._tag).toBe("Failure");
      expect(world.worktrees.size).toBe(1);
      expect(yield* git(["rev-parse", "refs/heads/topic"], project.storePath)).toBe(head);
    }),
  );
});
