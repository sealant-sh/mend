import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isWakeShell } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { worktreePathOf } from "@mend/store";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { sealantLaunchLayer, setup, withEngine } from "./engine/fixture.ts";

it("writes a co-located worktree file before the session has launched", async () => {
  await withEngine((world, tmp) =>
    Effect.gen(function* () {
      const project = yield* setup(tmp, world);
      const engine = yield* SessionEngine;
      const session = yield* engine.provision({
        projectId: project.id,
        harness: "codex",
        label: null,
        name: null,
        ownerUserId: "user-fixture",
        start: { kind: "base", base: null },
      });
      yield* engine.writeWorktreeFile(session.id, "docs/plan.md", "# Plan\n", "user-fixture");
      expect(
        readFileSync(
          join(worktreePathOf(project.storePath, session.worktree), "docs/plan.md"),
          "utf8",
        ),
      ).toBe("# Plan\n");
      expect(world.sessionRuns.size).toBe(0);
    }),
  );
});

it("wakes a captured worktree for a file edit without starting an agent", async () => {
  const created: Parameters<typeof sealantLaunchLayer>[0] = [];
  const spawned: ReadonlyArray<string>[] = [];
  const execs: ReadonlyArray<string>[] = [];
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
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        yield* engine.writeWorktreeFile(
          session.id,
          "docs/plan.md",
          "private plan bytes",
          "user-fixture",
        );
        expect(created).toHaveLength(1);
        expect([...world.processes.values()].every(isWakeShell)).toBe(true);
        expect(world.sessionRuns.size).toBe(0);
        expect(execs.some((argv) => argv.includes("mend-write"))).toBe(true);
        expect(JSON.stringify(execs)).not.toContain("private plan bytes");
      }),
    {
      captured: makeMemoryCaptureStore(),
      sealantLayer: sealantLaunchLayer(
        created,
        undefined,
        undefined,
        spawned,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        execs,
      ),
    },
  );
});
