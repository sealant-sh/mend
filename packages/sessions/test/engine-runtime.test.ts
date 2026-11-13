import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { UserDotfilesRepo } from "@mend/db";
import {
  defaultWorkspaceImage,
  type FamilyWorkspaceImage,
  type SessionRuntime,
  SessionRuntimeOffer,
} from "@mend/domain";
import {
  BOAT_FAILURE_KINDS,
  type BoatFailure,
  type BoatKeyHolder,
  boatProblemText,
  hostUserNamespacesRefusal,
  Project,
  type SessionDotfiles,
  Worktree,
} from "@mend/domain/workbench";
import {
  SealantClient,
  SealantClients,
  SealantClientsLive,
  SealantEnv,
  SealantIdentityStore,
  SealantPlatformError,
  toPlatformError,
} from "@mend/sealant";
import { DotfilesCloner, SessionEngine, WorkspaceHostUserNamespaces } from "@mend/sessions";
import { DotfilesStore } from "@mend/store";
import { type CreateOptions, SealantBoatError, SealantError } from "@sealant/sdk";
import { ConfigProvider, Effect, Layer, Logger, Option } from "effect";
import { describe, expect, it } from "vitest";

import { installScript } from "../src/dependency-cache.ts";
import { DOTFILES_NOT_ON_BOAT_SHARED } from "../src/person-deliveries.ts";
import { ResourceRuntime, ResourceRuntimeNone } from "../src/resources/runtime.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  failureText,
  launchOnce,
  lifecycleLayer,
  provisionIn,
  SNAPSHOT,
} from "./engine/capture-fixture.ts";
import { makeWorld, withEngine, withEngineEffect } from "./engine/fixture.ts";

const ubuntu: FamilyWorkspaceImage = {
  ...defaultWorkspaceImage,
  os: "ubuntu",
  services: { docker: false },
};

/** What Core 872's `workspace.ready()` rejects with when Boat refused the launch's VM. */
const boatRefusal = (kind: BoatFailure["kind"]) =>
  new SealantBoatError(
    'Workspace ws-boat reached terminal status "failed" before becoming ready: {"provider":"boat","code":"api_key_expired","requestId":"req_engine1"}',
    {
      kind,
      retryable: kind === "rate-limited" || kind === "no-machine" || kind === "no-answer",
      operation: "create",
      status: 403,
      code: "api_key_planted",
      requestId: "req_engine1",
      ...(kind === "permission-missing" ? { permission: "sandbox.create" } : {}),
    },
    { code: "workspace_not_ready" },
  );

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

  /**
   * A Boat install keeps the host's Docker socket for image builds and resources, so the host's
   * user namespaces read as refused on Ubuntu 24.04. A Boat session runs in a Boat VM that carries
   * its own Docker engine and starts there; a Docker session still fails before anything is made.
   */
  for (const runtime of ["docker", "boat"] as const) {
    it(`${runtime === "boat" ? "starts a Boat session" : "refuses a Docker session"} on a host that refuses user namespaces`, async () => {
      const created: CreateOptions[] = [];
      const setting = "kernel.apparmor_restrict_unprivileged_userns = 0";
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const outcome = yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
            if (runtime === "boat") {
              expect(outcome._tag).toBe("Success");
              expect(created.map((request) => request.runtime)).toEqual(["boat"]);
              expect(world.sessions.get(session.id)?.status).toBe("running");
            } else {
              expect(failureText(outcome)).toContain(hostUserNamespacesRefusal(setting));
              expect(created).toEqual([]);
            }
          }),
        {
          sessionRuntime: runtime,
          workspaceImage: ubuntu,
          sealantLayer: lifecycleLayer(created),
          hostUserNamespaces: Layer.succeed(WorkspaceHostUserNamespaces, {
            observe: () => Effect.succeed({ allowed: false, setting }),
          }),
        },
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

  /**
   * SLNT-794: on a server that offers both, each organization's choice decides where its new
   * worktrees run; a worktree keeps the runtime it was made with when the choice changes.
   */
  const both = new SessionRuntimeOffer({ offered: ["docker", "boat"], default: "docker" });
  for (const runtime of ["docker", "boat"] as const) {
    it(`launches a new worktree on ${runtime} when its organization chose ${runtime}`, async () => {
      const created: CreateOptions[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            expect(world.worktrees.get(session.worktreeId)?.sessionRuntime).toBe(runtime);
            yield* engine.launch(session.id, ["codex"]);
            expect(created.map((request) => request.runtime)).toEqual([runtime]);
          }),
        {
          sessionRuntimes: both,
          organizationRuntimes: new Map([["org-test", runtime]]),
          workspaceImage: ubuntu,
          sealantLayer: lifecycleLayer(created),
        },
      );
    });
  }

  it("gives an organization that has not chosen the server's default, whatever another chose", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          expect(created.map((request) => request.runtime)).toEqual(["boat"]);
        }),
      {
        sessionRuntimes: new SessionRuntimeOffer({ offered: ["docker", "boat"], default: "boat" }),
        organizationRuntimes: new Map([["org-other", "docker"]]),
        workspaceImage: ubuntu,
        sealantLayer: lifecycleLayer(created),
      },
    );
  });

  it("keeps an existing worktree's runtime after its organization changes its choice", async () => {
    const created: CreateOptions[] = [];
    const choices = new Map<string, SessionRuntime>([["org-test", "docker"]]);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, project, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.stop(session.id);
          choices.set("org-test", "boat");
          yield* engine.resumeSession(session.id, "shell");
          expect(world.worktrees.get(session.worktreeId)?.sessionRuntime).toBe("docker");
          const next = yield* provisionIn(project);
          expect(next.session.worktreeId).not.toBe(session.worktreeId);
          expect(world.worktrees.get(next.session.worktreeId)?.sessionRuntime).toBe("boat");
          yield* engine.launch(next.session.id, ["codex"]);
          expect(created.map((request) => request.runtime)).toEqual(["docker", "docker", "boat"]);
        }),
      {
        sessionRuntimes: both,
        organizationRuntimes: choices,
        workspaceImage: ubuntu,
        sealantLayer: lifecycleLayer(created),
      },
    );
  });

  it("ignores a choice the server no longer offers and uses its default", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          expect(created.map((request) => request.runtime)).toEqual(["docker"]);
        }),
      {
        sessionRuntime: "docker",
        organizationRuntimes: new Map([["org-test", "boat"]]),
        workspaceImage: ubuntu,
        sealantLayer: lifecycleLayer(created),
      },
    );
  });

  /**
   * SLNT-790: a Boat workspace runs in, and is billed to, its organization's Boat account when the
   * organization has connected a key; Core pins the account for the workspace's life. Each launch
   * asks again, so a stopped session's next launch follows the key the organization has then.
   */
  it("names the organization's Boat account on a Boat launch, and follows a key change on resume", async () => {
    const created: CreateOptions[] = [];
    const accounts = new Map([["org-test", "core-boat-acme"]]);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.stop(session.id);
          accounts.delete("org-test");
          yield* engine.resumeSession(session.id, "shell");
          expect(created.map((options) => options.boatAccountId)).toEqual([
            "core-boat-acme",
            undefined,
          ]);
        }),
      {
        sessionRuntime: "boat",
        workspaceImage: ubuntu,
        sealantLayer: lifecycleLayer(created),
        boatAccounts: accounts,
      },
    );
  });

  /**
   * SLNT-797: a person's own key in the organization decides their Boat launches over the
   * organization's, and the session records which key decided. A colleague's launch in the same
   * organization still names the organization's account.
   */
  it("names a person's own Boat account over the organization's, records which key decided, and follows its removal", async () => {
    const created: CreateOptions[] = [];
    const personAccounts = new Map([["org-test/user-fixture", "core-boat-own"]]);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session, project } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          expect(world.sessions.get(session.id)?.boatKey).toBe("person");
          world.members.set("user-colleague", "member");
          const colleague = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-colleague",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(colleague.id, ["codex"]);
          expect(world.sessions.get(colleague.id)?.boatKey).toBe("organization");
          yield* engine.stop(session.id);
          personAccounts.delete("org-test/user-fixture");
          yield* engine.resumeSession(session.id, "shell");
          expect(world.sessions.get(session.id)?.boatKey).toBe("organization");
          expect(created.map((options) => options.boatAccountId)).toEqual([
            "core-boat-own",
            "core-boat-acme",
            "core-boat-acme",
          ]);
        }),
      {
        sessionRuntime: "boat",
        workspaceImage: ubuntu,
        sealantLayer: lifecycleLayer(created),
        boatAccounts: new Map([["org-test", "core-boat-acme"]]),
        personBoatAccounts: personAccounts,
      },
    );
  });

  it("records the server's key for a Boat launch with no key, and none for a Docker launch", async () => {
    for (const runtime of ["boat", "docker"] as const) {
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            expect(world.sessions.get(session.id)?.boatKey).toBe(
              runtime === "boat" ? "server" : null,
            );
          }),
        { sessionRuntime: runtime, workspaceImage: ubuntu, sealantLayer: lifecycleLayer([]) },
      );
    }
  });

  it("never names a Boat account for a Docker launch, key or not", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          expect(created.map((options) => options.boatAccountId)).toEqual([undefined]);
        }),
      {
        sessionRuntime: "docker",
        workspaceImage: ubuntu,
        sealantLayer: lifecycleLayer(created),
        boatAccounts: new Map([["org-test", "core-boat-acme"]]),
      },
    );
  });

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

  /**
   * A shared-layout launch sends its owner's dotfiles with the create as archives. Core's Boat
   * runtime refuses any create that carries them, so a Boat launch sends none, resolves none, and
   * names each source the person keeps as not applied. Docker sends them as before.
   */
  for (const runtime of ["docker", "boat"] as const) {
    it(`${runtime === "boat" ? "starts a shared Boat session without dotfiles archives and says so" : "sends a shared Docker session's dotfiles with the create"}`, async () => {
      const created: CreateOptions[] = [];
      const cloned: string[] = [];
      let recorded: SessionDotfiles | null = null;
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            yield* engine.launch(session.id, ["codex"]);
            recorded = world.sessions.get(session.id)?.dotfiles ?? null;
          }),
        {
          sessionRuntime: runtime,
          workspaceImage: ubuntu,
          sealantLayer: lifecycleLayer(created),
          userDotfilesLayer: Layer.succeed(UserDotfilesRepo, {
            repository: () =>
              Effect.succeed(
                runtime === "boat"
                  ? {
                      url: "https://example.test/dotfiles.git",
                      ref: null,
                      subdirectory: null,
                      manager: "auto" as const,
                      bootstrap: true,
                    }
                  : null,
              ),
            setRepository: (_userId, value) => Effect.succeed(value),
            startAgentsAfterInstall: () => Effect.succeed(false),
            setStartAgentsAfterInstall: (_userId, value) => Effect.succeed(value),
          }),
          dotfilesClonerLayer: Layer.succeed(DotfilesCloner, {
            archive: (_owner, repository) =>
              Effect.sync(() => {
                cloned.push(repository.url);
                return { data: "cmVwbw==", manager: "auto" as const, bootstrap: true };
              }),
          }),
          dotfilesStoreLayer: Layer.succeed(DotfilesStore, {
            snapshot: () => Effect.die("not in test"),
            current: () =>
              Effect.succeed({
                sha: SNAPSHOT.sha,
                source: "laptop",
                committedAt: new Date(0),
                files: [],
              }),
            archive: () => Effect.succeed({ sha: SNAPSHOT.sha, data: SNAPSHOT.data }),
            clear: () => Effect.void,
          }),
        },
      );
      expect(created).toHaveLength(1);
      if (runtime === "docker") {
        expect(created[0]?.dotfiles).toEqual({
          archives: [{ data: SNAPSHOT.data, manager: "copy", bootstrap: false }],
        });
        expect(recorded).toEqual({ repository: null, snapshotSha: SNAPSHOT.sha, notApplied: [] });
        return;
      }
      expect(created[0]?.dotfiles).toBeUndefined();
      expect(cloned).toEqual([]);
      expect(recorded).toEqual({
        repository: { url: "https://example.test/dotfiles.git", ref: null },
        snapshotSha: null,
        notApplied: [
          { source: "repository", reason: DOTFILES_NOT_ON_BOAT_SHARED },
          { source: "snapshot", reason: DOTFILES_NOT_ON_BOAT_SHARED },
        ],
      });
    });
  }

  for (const refusal of [
    {
      status: 503,
      _tag: "WorkspaceServiceUnavailableError",
      code: "unsupported-runtime",
      message: "No runtime adapter is registered for target.runtime.family 'boat'.",
      copy: "This server runs sessions on Boat, but Boat is not set up on it, so nothing was started.\nThe person who runs this Mend server gives it the Boat key and deployment settings with mend server setup, or switches sessions back to Docker with mend server setup --session-runtime docker.",
    },
    {
      status: 422,
      _tag: "WorkspaceRuntimeRequirementUnsupportedError",
      code: "runtime-requirement-unsupported",
      message: "This environment needs an unsupported runtime feature.",
      copy: "Boat cannot run this project's environment: This environment needs an unsupported runtime feature.\nChange the project's environment, or ask an owner of this organization to choose another runtime in Settings, Organization, Defaults where the server offers one.",
    },
    {
      status: 422,
      _tag: "WorkspaceRuntimeRequirementUnsupportedError",
      code: "runtime-os-unsupported",
      message: "Boat supports Ubuntu and Nix; Arch is unsupported.",
      copy: "Boat supports Ubuntu and Nix; Arch is unsupported.\nSwitch the project's environment to one Boat runs, then start the session again.",
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
                summary: `launch refused · ${refusal.copy}`,
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
      "This server's Boat setup has no resource gateway, so a session whose worktree uses project resources cannot start on Boat.\nThe person who runs this Mend server configures one. Nothing was started.";
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
            summary: `launch refused · ${copy}`,
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

  for (const holder of ["organization", "server"] satisfies ReadonlyArray<BoatKeyHolder>) {
    for (const kind of BOAT_FAILURE_KINDS) {
      it(`ends a Boat launch Boat refused for ${kind} on the ${holder}'s key with the table's words`, async () => {
        const logs: Array<string> = [];
        const captureLogs = Logger.layer([
          Logger.make(({ message }) => {
            logs.push(Array.isArray(message) ? message.join(" ") : String(message));
          }),
        ]);
        await Effect.runPromise(
          withEngineEffect(
            (world, tmp) =>
              Effect.gen(function* () {
                const { engine, session } = yield* launchOnce(world, tmp);
                const error = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
                if (error._tag !== "SealantPlatformError")
                  throw new Error("launch lost its platform failure");
                const failure = error.boat;
                if (failure === undefined) throw new Error("launch lost Boat's reason");
                const words = boatProblemText({ kind, failure }, { holder, place: "launch" });
                expect(error.message).toBe(words);
                const summary = world.sessions.get(session.id)?.summary ?? "";
                expect(summary).toBe(`launch failed · ${words}`);
                const [first] = summary.split("\n");
                expect(first).toMatch(/^launch failed · .*this session's VM did not start\.$/);
                for (const secret of ["api_key_planted", "req_engine1", "terminal status"])
                  expect(summary).not.toContain(secret);
              }),
            {
              sessionRuntime: "boat",
              workspaceImage: ubuntu,
              ...(holder === "organization"
                ? { boatAccounts: new Map([["org-test", "core-boat-acme"]]) }
                : {}),
              sealantLayer: lifecycleLayer([], {
                captureOps: {
                  beforeCreate: () => Effect.fail(toPlatformError(boatRefusal(kind))),
                },
              }),
            },
          ).pipe(Effect.provide(captureLogs)),
        );
        expect(logs.join("\n")).toContain(
          `boat refused · ${kind} · api_key_planted · request req_engine1 · create · 403`,
        );
      });
    }
  }

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
