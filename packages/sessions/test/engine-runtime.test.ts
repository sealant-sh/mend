import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { defaultWorkspaceImage, type FamilyWorkspaceImage } from "@mend/domain";
import { Project, Worktree } from "@mend/domain/workbench";
import {
  SealantClient,
  SealantClients,
  SealantClientsLive,
  SealantEnv,
  SealantIdentityStore,
  SealantPlatformError,
  toPlatformError,
} from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { type CreateOptions, SealantError } from "@sealant/sdk";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { installScript } from "../src/dependency-cache.ts";
import { ResourceRuntime, ResourceRuntimeNone } from "../src/resources/runtime.ts";
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

  for (const runtime of ["docker", "boat"] as const) {
    it(`${runtime === "boat" ? "tells Core a Boat workspace has no resources only while its worktree binds none" : "never tells Core a Docker workspace has no resources"}`, async () => {
      const created: CreateOptions[] = [];
      const bindings = { present: false };
      const resourceRuntime = Layer.effect(
        ResourceRuntime,
        Effect.gen(function* () {
          const none = yield* ResourceRuntime;
          return { ...none, bindsAny: () => Effect.sync(() => bindings.present) };
        }),
      ).pipe(Layer.provide(ResourceRuntimeNone));
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            yield* engine.stop(session.id);
            bindings.present = true;
            yield* engine.resumeSession(session.id, "shell");
            expect(created.map((options) => options.resources)).toEqual(
              runtime === "boat" ? ["none", undefined] : [undefined, undefined],
            );
          }),
        {
          sessionRuntime: runtime,
          workspaceImage: ubuntu,
          sealantLayer: lifecycleLayer(created),
          resourceRuntime,
        },
      );
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

  for (const refusal of [
    {
      status: 503,
      _tag: "WorkspaceServiceUnavailableError",
      code: "unsupported-runtime",
      message: "No runtime adapter is registered for target.runtime.family 'boat'.",
      copy: "This server runs sessions on Boat, but Boat is not set up on it. Ask the server operator to give the server the Boat key and deployment settings, or to switch sessions back to Docker with `mend server setup --session-runtime docker`.",
    },
    {
      status: 422,
      _tag: "WorkspaceRuntimeRequirementUnsupportedError",
      code: "runtime-requirement-unsupported",
      message: "This environment needs an unsupported runtime feature.",
      copy: "Boat cannot run this project's environment. This environment needs an unsupported runtime feature. Change the project's environment or ask the server operator to change where new sessions run.",
    },
    {
      status: 422,
      _tag: "WorkspaceRuntimeRequirementUnsupportedError",
      code: "runtime-os-unsupported",
      message: "Boat does not support this operating system.",
      copy: "Boat runs Ubuntu and Nix environments. Switch the project's environment to Ubuntu or Nix, then start the session again.",
    },
  ]) {
    it(`surfaces Core's HTTP ${refusal.status} ${refusal.code} as an actionable typed refusal without trying Docker`, async () => {
      const requests: Array<{
        method: string | undefined;
        url: string | undefined;
        body: unknown;
      }> = [];
      const core = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests.push({
            method: request.method,
            url: request.url,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          response.writeHead(refusal.status, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ _tag: refusal._tag, code: refusal.code, message: refusal.message }),
          );
        });
      });
      await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
      try {
        const address = core.address();
        if (address === null || typeof address === "string") throw new Error("Core did not listen");
        const clients = SealantClientsLive.pipe(
          Layer.provide(
            Layer.succeed(SealantEnv, {
              baseUrl: `http://127.0.0.1:${address.port}`,
              serviceKey: Option.none(),
            }),
          ),
          Layer.provide(
            Layer.succeed(SealantIdentityStore, {
              user: (userId) =>
                Effect.succeed({ id: userId, email: `${userId}@mend.test`, name: userId }),
              sealantUserId: (userId) => Effect.succeed(`su-${userId}`),
              record: () => Effect.void,
            }),
          ),
        );
        const sealantLayer: Layer.Layer<SealantClient> = Layer.effect(
          SealantClient,
          Effect.gen(function* () {
            const inner = yield* SealantClient;
            const live = yield* SealantClients;
            return {
              ...inner,
              createWorkspace: (...args) =>
                live
                  .forPrincipal()
                  .pipe(Effect.flatMap((client) => client.createWorkspace(...args))),
            };
          }),
        ).pipe(Layer.provide(Layer.merge(lifecycleLayer([]), clients)));
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              const error = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              expect(error).toBeInstanceOf(SealantPlatformError);
              if (error._tag !== "SealantPlatformError")
                throw new Error("launch lost its platform refusal");
              expect(error.code).toBe(refusal.code);
              expect(error.cause).toBeInstanceOf(SealantError);
              expect(error.message).toBe(refusal.copy);
              expect(world.sessions.get(session.id)).toMatchObject({
                status: "failed",
                summary: `launch failed: ${refusal.copy}`,
                sealantWorkspaceId: null,
              });
              expect(requests).toEqual([
                {
                  method: "POST",
                  url: "/v1/workspaces",
                  body: expect.objectContaining({
                    spec: expect.objectContaining({
                      target: expect.objectContaining({
                        runtime: { family: "boat", mode: "require" },
                      }),
                    }),
                  }),
                },
              ]);
            }),
          {
            sessionRuntime: "boat",
            workspaceImage: ubuntu,
            captured: makeMemoryCaptureStore(),
            sealantLayer,
          },
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          core.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      }
    });
  }

  it("says a Boat server with no resource gateway cannot start a session whose worktree has resources", async () => {
    const created: CreateOptions[] = [];
    const copy =
      "This server's Boat setup has no resource gateway, so sessions whose worktree uses project resources cannot start on Boat until the server operator configures one.";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          const error = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          if (error._tag !== "SealantPlatformError")
            throw new Error("launch lost its platform refusal");
          expect(error.code).toBe("gateway-unavailable");
          expect(error.message).toBe(copy);
          expect(world.sessions.get(session.id)).toMatchObject({
            status: "failed",
            summary: `launch failed: ${copy}`,
          });
        }),
      {
        sessionRuntime: "boat",
        workspaceImage: ubuntu,
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            beforeCreate: () =>
              Effect.fail(
                toPlatformError(
                  new SealantError(
                    'Workspace ws-boat reached terminal status "failed" before becoming ready: no resource gateway',
                    { code: "gateway-unavailable" },
                  ),
                ),
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
