import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadLaunchInput,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
} from "@mend/t3-contracts";
import { Effect, Exit, Layer, Result, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vitest";

import { GatewayConfig } from "../src/config.ts";
import { gateDeviceCalls } from "../src/device-gate.ts";
import { makeGatewayEnvironment } from "../src/environment.ts";
import { makePersonHub, ThreadCommandRefused, type PersonHub } from "../src/hub.ts";
import { MendClient, MendClientLive, MendNotFound } from "../src/mend-client.ts";
import type { MendProject, MendSession } from "../src/mend-workbench.ts";
import { personProjectPaths } from "../src/project-paths.ts";
import { makeGatewayRpcHandlers } from "../src/rpc.ts";
import { openGatewayState } from "../src/state.ts";
import { inlineFindParser } from "./support/find-parser.ts";
import { testBearerSession, unreachableMend } from "./support/stubs.ts";

const person = testBearerSession.mendUser;
const at = "2026-10-25T12:00:00.000Z";
const makeProject = (id: string, name: string, scratch = false): MendProject => ({
  id,
  name,
  storePath: `/store/${id}/repo.git`,
  defaultBranch: "main",
  originUrl: null,
  scratchOwnerUserId: scratch ? person.id : null,
  createdAt: at,
  updatedAt: at,
});
const handlers = (hub: PersonHub, session = testBearerSession) =>
  makeGatewayRpcHandlers({
    environment: makeGatewayEnvironment({
      environmentId: EnvironmentId.make("creation-env"),
      label: "Mend",
      host: "127.0.0.1",
      statePath: ":memory:",
    }),
    assetUrls: {
      issue: () => Effect.succeed({ relativeUrl: "/unused", expiresAt: 0 }),
      open: () => Effect.die("unused"),
    },
    session,
    hub,
    clientAppVersion: "0.1.2",
  });
const fixture = () =>
  Effect.gen(function* () {
    const projects = new Map<string, MendProject>();
    const sessions: MendSession[] = [];
    const writes: Array<{ token: string; name: string; kind: string }> = [];
    const createdSessions: Array<{ projectId: string; name: string | null; base: string | null }> =
      [];
    let readable = true;
    let refusal = false;
    const calls: MendClient["Service"] = {
      ...unreachableMend,
      listProjects: () => Effect.succeed([...projects.values()]),
      listActiveSessions: () => Effect.succeed([]),
      listSkills: () => Effect.succeed([]),
      projectSkills: () => Effect.succeed([]),
      events: () => Stream.never,
      projectDetail: (_token, id) =>
        readable && projects.has(id)
          ? Effect.succeed({
              project: projects.get(id) ?? makeProject(id, "missing"),
              sessions: sessions.filter((s) => s.projectId === id),
              annotations: [],
            })
          : Effect.fail(new MendNotFound({ operation: "detail" })),
      createProject: (token, name) =>
        Effect.sync(() => {
          writes.push({ token, name, kind: "named" });
          const p = makeProject(`named-${projects.size}`, `${name}-2`);
          projects.set(p.id, p);
          return p;
        }),
      ensureScratchProject: (token) =>
        Effect.sync(() => {
          writes.push({ token, name: "", kind: "scratch" });
          const p = projects.get("scratch") ?? makeProject("scratch", "scratch-person", true);
          projects.set(p.id, p);
          return p;
        }),
      createSession: (_token, projectId, input) =>
        Effect.sync(() => {
          createdSessions.push({ projectId, name: input.name, base: input.base });
          const id = `session-${sessions.length}`;
          const s: MendSession = {
            id,
            projectId,
            worktreeId: `wt-${id}`,
            harness: input.harness,
            label: input.label,
            worktree: `wt-${id}`,
            branch: `mend/${id}`,
            baseSha: "a".repeat(40),
            baseRef: input.base,
            status: "idle",
            ownerUserId: person.id,
            createdAt: at,
            updatedAt: at,
          };
          sessions.push(s);
          return s;
        }),
      listTurns: () => Effect.succeed([]),
      listItems: () => Effect.succeed([]),
      listRequests: () => Effect.succeed([]),
      workspaceRetirement: () => Effect.succeed(null),
      conversationWait: () => Effect.succeed(null),
      launchProtocol: (_token, id) =>
        Effect.succeed(
          sessions.find((s) => s.id === id) ??
            sessions[0] ?? {
              id,
              projectId: "scratch",
              worktreeId: id,
              harness: "codex",
              label: null,
              worktree: id,
              branch: id,
              baseSha: "a".repeat(40),
              baseRef: "main",
              status: "idle",
              ownerUserId: person.id,
              createdAt: at,
              updatedAt: at,
            },
        ),
    };
    const reconnect = () =>
      Effect.gen(function* () {
        const state = yield* openGatewayState(":memory:");
        return yield* makePersonHub({
          mend: gateDeviceCalls(calls, () => Effect.void),
          viewer: person,
          state,
          parser: inlineFindParser,
          tokens: {
            current: () => testBearerSession.deviceToken,
            live: () => [testBearerSession.deviceToken],
            refuse: () => Effect.void,
            isRefused: () => refusal,
            refusal: () => Effect.never,
            noneLeft: Effect.never,
          },
        });
      });
    const hub = yield* reconnect();
    return {
      hub,
      reconnect,
      rpc: handlers(hub),
      projects,
      writes,
      createdSessions,
      unreadable: () => {
        readable = false;
      },
      revoke: () => {
        refusal = true;
      },
    };
  });
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/Scope").Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

describe("project creation through the gateway", () => {
  it("posts only a name or empty scratch body as the person, preserving refusals without repeating writes", async () => {
    const requests: Array<{
      method: string;
      path: string;
      authorization: string | undefined;
      body: unknown;
    }> = [];
    let status = 200;
    const transport = HttpClient.make((request, url) =>
      Effect.sync(() => {
        requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.authorization,
          body:
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : null,
        });
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            status === 200
              ? makeProject("new", "notes")
              : { _tag: "StoreFailure", message: "Choose another name." },
            { status },
          ),
        );
      }),
    );
    const live = MendClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, transport),
          Layer.succeed(GatewayConfig, {
            mendUrl: new URL("http://mend.invalid"),
            host: "127.0.0.1",
            port: 0,
            label: "test",
            statePath: ":memory:",
          }),
        ),
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const mend = yield* MendClient;
        expect((yield* mend.createProject("device-person", "notes")).name).toBe("notes");
        yield* mend.ensureScratchProject("device-person");
        status = 422;
        const refused = yield* mend.createProject("device-person", "notes").pipe(Effect.result);
        expect(Result.isFailure(refused) && refused.failure.message).toContain(
          "Choose another name.",
        );
        status = 401;
        const revoked = yield* mend.ensureScratchProject("revoked-person").pipe(Effect.result);
        expect(Result.isFailure(revoked) && revoked.failure._tag).toBe("MendDeviceRefused");
      }).pipe(Effect.provide(live), Effect.scoped),
    );
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/projects/new",
        authorization: "Bearer device-person",
        body: { name: "notes" },
      },
      {
        method: "POST",
        path: "/api/projects/scratch",
        authorization: "Bearer device-person",
        body: {},
      },
      {
        method: "POST",
        path: "/api/projects/new",
        authorization: "Bearer device-person",
        body: { name: "notes" },
      },
      {
        method: "POST",
        path: "/api/projects/scratch",
        authorization: "Bearer revoked-person",
        body: {},
      },
    ]);
  });
  it("advertises both buttons before first use, then publishes the allocated name before answering", async () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const config = yield* f.rpc[WS_METHODS.serverGetConfig]();
        expect(config.newProjectsRoot).toBe("Mend");
        expect(config.scratchWorkspaceRoot).toBe(
          personProjectPaths(person.id).scratchWorkspaceRoot,
        );
        expect(f.writes).toEqual([]);
        const answer = yield* f.rpc[WS_METHODS.projectsCreateNew]({ name: "Café Notes!" });
        const shell = yield* f.hub.shellSnapshot;
        expect(shell.projects.find((p) => p.id === answer.projectId)).toMatchObject({
          title: "cafe-notes-2",
          workspaceRoot: answer.workspaceRoot,
        });
        expect(f.writes).toEqual([
          { token: testBearerSession.deviceToken, name: "cafe-notes", kind: "named" },
        ]);
      }),
    ));
  it("treats path-shaped names as text and refuses adopting a client path", async () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* f.rpc[WS_METHODS.projectsCreateNew]({ name: "../../etc/passwd" });
        expect(f.writes).toEqual([
          { token: testBearerSession.deviceToken, name: "etc-passwd", kind: "named" },
        ]);
        expect(result.workspaceRoot).toMatch(/^\/store\/named-\d+\/repo.git$/);
        const mutation = yield* f.rpc[WS_METHODS.projectsMutate]({
          type: "project.create",
          commandId: CommandId.make("path-source"),
          projectId: ProjectId.make("forged"),
          title: "Host",
          workspaceRoot: "/etc",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(mutation)).toBe(true);
        expect(f.writes).toHaveLength(1);
      }),
    ));
  it("reuses scratch, recognises it by the client's exact path comparison, and resolves only known roots", async () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* f.rpc[WS_METHODS.projectsEnsureScratch]();
        const second = yield* f.rpc[WS_METHODS.projectsEnsureScratch]();
        expect(first).toEqual(second);
        const restarted = yield* f.reconnect();
        expect(yield* handlers(restarted)[WS_METHODS.projectsEnsureScratch]()).toEqual(first);
        const config = yield* f.rpc[WS_METHODS.serverGetConfig]();
        const shell = yield* f.hub.shellSnapshot;
        const scratch = shell.projects.find((p) => p.id === first.projectId);
        expect(scratch).toMatchObject({
          title: "No project",
          workspaceRoot: config.scratchWorkspaceRoot,
        });
        expect(yield* f.hub.locationOf(config.scratchWorkspaceRoot ?? "missing")).toMatchObject({
          projectId: first.projectId,
          sessionId: null,
          hasOrigin: false,
        });
        for (const root of [
          "/etc",
          `${config.scratchWorkspaceRoot}/../etc`,
          personProjectPaths("someone-else").scratchWorkspaceRoot,
          "Mend",
        ])
          expect(yield* f.hub.locationOf(root)).toBe(null);
        expect(personProjectPaths(person.id)).toEqual(personProjectPaths(person.id));
        expect(personProjectPaths(person.id)).not.toEqual(personProjectPaths("someone-else"));
      }),
    ));
  it("does not answer a project absent from the shell or create with a refused/read-only device", async () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.unreadable();
        expect(
          Exit.isFailure(
            yield* f.rpc[WS_METHODS.projectsCreateNew]({ name: "notes" }).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect((yield* f.hub.shellSnapshot).projects).toEqual([]);
        const readOnly = handlers(f.hub, { ...testBearerSession, scopes: ["orchestration:read"] });
        expect(
          Exit.isFailure(yield* readOnly[WS_METHODS.projectsEnsureScratch]().pipe(Effect.exit)),
        ).toBe(true);
        f.revoke();
        expect(
          Exit.isFailure(yield* f.rpc[WS_METHODS.projectsEnsureScratch]().pipe(Effect.exit)),
        ).toBe(true);
        expect(f.writes).toHaveLength(1);
      }),
    ));
  it("starts every new scratch thread in its own worktree from main, including root requests", async () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const { projectId } = yield* f.rpc[WS_METHODS.projectsEnsureScratch]();
        const launch = (
          n: number,
          workspaceStrategy: OrchestrationV2ThreadLaunchInput["workspaceStrategy"],
        ) =>
          f.rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
            commandId: CommandId.make(`command-${n}`),
            threadId: ThreadId.make(`thread-${n}`),
            projectId: ProjectId.make(projectId),
            title: "scratch",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-6.1-sol",
              options: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy,
          });

        for (const n of [1, 2]) yield* launch(n, { type: "root" });
        yield* launch(1, { type: "root" });
        expect(f.createdSessions).toEqual([
          { projectId, name: null, base: "main" },
          { projectId, name: null, base: "main" },
        ]);
        const shell = yield* f.hub.shellSnapshot;
        expect(new Set(shell.threads.map((t) => t.worktreePath)).size).toBe(2);
        yield* launch(3, {
          type: "worktree",
          baseRef: "other",
          branch: "custom/branch",
          startFromOrigin: true,
        });
        expect(f.createdSessions[2]).toEqual({ projectId, name: null, base: "main" });
        const joined = yield* launch(4, {
          type: "existing_worktree",
          worktreePath: shell.threads[0]?.worktreePath ?? "/missing",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(joined)).toBe(true);
        expect(f.createdSessions).toHaveLength(3);
      }),
    ));
  it("starts a scratch thread from the scratch project's own default branch", async () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.projects.set("scratch", {
          ...makeProject("scratch", "scratch-person", true),
          defaultBranch: "trunk",
        });
        const { projectId } = yield* f.rpc[WS_METHODS.projectsEnsureScratch]();
        yield* f.rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make("command-trunk"),
          threadId: ThreadId.make("thread-trunk"),
          projectId: ProjectId.make(projectId),
          title: "scratch",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6.1-sol",
            options: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
        expect(f.createdSessions).toEqual([{ projectId, name: null, base: "trunk" }]);
      }),
    ));
  it("preserves Mend refusal text and keeps path-based creation and browsing refused", async () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture();
        const refusedHub = {
          ...f.hub,
          createProject: () =>
            Effect.fail(
              new ThreadCommandRefused({
                reason: "Choose another name.",
                authorization: false,
              }),
            ),
        };
        const rpc = handlers(refusedHub);
        const result = yield* rpc[WS_METHODS.projectsCreateNew]({ name: "notes" }).pipe(
          Effect.exit,
        );
        expect(JSON.stringify(result)).toContain("Choose another name.");
        expect(Exit.isFailure(yield* rpc[WS_METHODS.filesystemBrowse]().pipe(Effect.exit))).toBe(
          true,
        );
      }),
    ));
});
