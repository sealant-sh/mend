import * as fs from "node:fs";
import * as path from "node:path";

import { HotWorkspacesRepo } from "@mend/db";
import { AgentTurnId } from "@mend/domain";
import { Project } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { CUSTOM_BASE, lifecycleLayer } from "./engine/capture-fixture.ts";
import { hotWorkspacesEmptyLayer, setup, withEngine } from "./engine/fixture.ts";
import { resourcePreviewFixture } from "./engine/resource-preview-fixture.ts";

const RECIPES = `[setup]
run = ["echo setup-must-not-run"]
[service.web]
command = "echo service-must-not-run"
port = 3000
browserScheme = "http"
[preview]
service = "web"
`;

describe("setup sessions start nothing", () => {
  for (const captured of [false, true]) {
    it(`skips installs, resource preparation and a newly written preview in ${captured ? "capture" : "bind"} mode`, async () => {
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const resources = resourcePreviewFixture();
      let claims = 0;
      const pool = Layer.effect(
        HotWorkspacesRepo,
        Effect.map(HotWorkspacesRepo, (repo) => ({
          ...repo,
          claim: () =>
            Effect.sync(() => {
              claims += 1;
              return null;
            }),
        })),
      ).pipe(Layer.provide(hotWorkspacesEmptyLayer));
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const original = yield* setup(tmp, world);
            const project = new Project({
              ...original,
              installEnabled: true,
              hotSessions: 1,
              installCommand: "echo install-must-not-run",
            });
            world.projects.set(project.id, project);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: "Set up this project",
              name: null,
              start: { kind: "base", base: null },
              ownerUserId: "user-fixture",
              purpose: "setup",
              autoLand: false,
            });
            expect(claims).toBe(0);
            expect(session.purpose).toBe("setup");
            expect(session.autoLand).toBe(false);
            expect(world.worktrees.get(session.worktreeId)?.name).toBe(`wt-${session.worktreeId}`);
            yield* engine.launch(session.id, ["codex"]);
            const dir = path.join(tmp, "store", "fixture", "worktrees", session.worktree, ".mend");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "mend.toml"), RECIPES);
            const outcome = yield* engine.preparePreview(
              session.id,
              AgentTurnId.make("completed-setup-turn"),
              {
                holds: Effect.succeed(true),
                report: () => Effect.die("setup must not begin a preview"),
              },
            );
            expect(outcome).toEqual({
              _tag: "Skipped",
              why: "setup sessions write instructions; nothing starts",
            });
            expect(world.services.size).toBe(0);
            expect(world.previews.size).toBe(0);
            expect(world.setupRuns).toEqual([]);
            expect(resources.control.starts).toBe(0);
            expect(resources.control.uses).toBe(0);
            expect(
              execCalls.some((argv) =>
                argv.some(
                  (arg) =>
                    arg.includes("install-must-not-run") ||
                    arg.includes("image-setup-must-not-run"),
                ),
              ),
            ).toBe(false);
          }),
        {
          ...(captured ? { captured: makeMemoryCaptureStore() } : {}),
          resourceRuntime: resources.layer,
          hotWorkspacesLayer: pool,
          workspaceImage: { ...CUSTOM_BASE, setupCommands: ["echo image-setup-must-not-run"] },
          sealantLayer: lifecycleLayer(created, {
            execCalls,
            captureOps: {
              exec: (argv) =>
                (argv[2] ?? "").startsWith("uname -s; uname -m;")
                  ? { exitCode: 0, stdout: "Linux\nx86_64\nldd (GNU libc) 2.39\n", stderr: "" }
                  : undefined,
            },
          }),
        },
      );
    });
  }
});
