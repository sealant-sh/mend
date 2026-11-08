import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultWorkspaceImage, type FamilyWorkspaceImage } from "@mend/domain";
import { Project, Worktree } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { installScript } from "../src/dependency-cache.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { failureText, launchOnce, lifecycleLayer } from "./engine/capture-fixture.ts";
import { makeWorld, withEngine } from "./engine/fixture.ts";

const ubuntu: FamilyWorkspaceImage = {
  ...defaultWorkspaceImage,
  os: "ubuntu",
  services: { docker: false },
};

describe("the server's session runtime choice", () => {
  for (const runtime of ["docker", "boat"] as const) {
    it(`requests ${runtime} explicitly and pins it to the worktree`, async () => {
      const created: CreateOptions[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            expect(world.worktrees.get(session.worktreeId)?.sessionRuntime).toBe(runtime);
            yield* engine.launch(session.id, ["codex"]);
            expect(created).toHaveLength(1);
            expect(created[0]?.runtime).toBe(runtime);
          }),
        { sessionRuntime: runtime, workspaceImage: ubuntu, sealantLayer: lifecycleLayer(created) },
      );
    });
  }

  for (const runtime of [undefined, null, "docker", "boat"] as const) {
    it(`keeps Kubernetes ${runtime === undefined ? "unset selection" : (runtime ?? "automatic selection")} through workspace creation`, async () => {
      const created: CreateOptions[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            expect(world.worktrees.get(session.worktreeId)?.sessionRuntime).toBe(runtime ?? null);
            yield* engine.launch(session.id, ["codex"]);
            expect(created).toHaveLength(1);
            expect(created[0]?.runtime).toBe(runtime ?? undefined);
          }),
        {
          deploymentMode: "kubernetes",
          ...(runtime === undefined ? {} : { sessionRuntime: runtime }),
          workspaceImage: ubuntu,
          captured: makeMemoryCaptureStore(),
          sealantLayer: lifecycleLayer(created),
        },
      );
    });
  }

  for (const legacy of [false, true]) {
    it(`${legacy ? "keeps the legacy path" : "keeps Boat"} on stop/resume after restart with another server choice`, async () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-runtime-restart-"));
      const fixture = { world: makeWorld(), tmp: scratch };
      const created: CreateOptions[] = [];
      const options = { fixture, workspaceImage: ubuntu, sealantLayer: lifecycleLayer(created) };
      try {
        const persistedSession = await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              if (legacy) {
                const worktree = world.worktrees.get(session.worktreeId);
                if (worktree === undefined) throw new Error("worktree missing");
                world.worktrees.set(
                  worktree.id,
                  new Worktree({ ...worktree, sessionRuntime: null }),
                );
              }
              yield* engine.launch(session.id, ["codex"]);
              yield* engine.stop(session.id);
              return session;
            }),
          { ...options, sessionRuntime: "boat" },
        );
        await withEngine(
          () =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              yield* engine.resumeSession(persistedSession.id, "shell");
              expect(created).toHaveLength(2);
              expect(created.map((request) => request.runtime)).toEqual(
                legacy ? [undefined, undefined] : ["boat", "boat"],
              );
            }),
          { ...options, sessionRuntime: "docker" },
        );
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });
  }

  it("refuses an existing Arch project with the environment fix before creating a workspace", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          const outcome = yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
          expect(created).toEqual([]);
          expect(failureText(outcome)).toContain(
            "Switch the project's environment to Ubuntu or Nix",
          );
        }),
      { sessionRuntime: "boat", sealantLayer: lifecycleLayer(created) },
    );
  });

  it("shows an admission refusal without trying Docker", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          const outcome = yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
          expect(created.map((options) => options.runtime)).toEqual(["boat"]);
          expect(failureText(outcome)).toContain(
            "Boat is not enabled for this session owner on this server.",
          );
        }),
      {
        sessionRuntime: "boat",
        workspaceImage: ubuntu,
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            beforeCreate: () =>
              Effect.fail(
                new SealantPlatformError({
                  code: "boat-production-capability-unverified",
                  status: 503,
                  cause: null,
                  message: "Boat execution is not available on this deployment.",
                }),
              ),
          },
        }),
      },
    );
  });

  it("does not send a Boat dependency install to the server's npm mirror", async () => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const command = "pnpm install --frozen-lockfile";
    const mirror = "http://npm-mirror:4873/";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session, project } = yield* launchOnce(world, tmp);
          world.projects.set(project.id, new Project({ ...project, installCommand: command }));
          yield* engine
            .launch(session.id, ["codex"])
            .pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv({ env: { MEND_NPM_MIRROR_URL: mirror } }),
              ),
            );
          expect(execCalls.some((argv) => argv[2] === installScript(command))).toBe(true);
          expect(execCalls.some((argv) => argv.join(" ").includes(mirror))).toBe(false);
        }),
      {
        sessionRuntime: "boat",
        workspaceImage: ubuntu,
        captured: makeMemoryCaptureStore(),
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
});
