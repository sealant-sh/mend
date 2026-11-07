import {
  CommandId,
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  WS_METHODS,
} from "@mend/t3-contracts";
import { Effect, Layer, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vitest";

import { GatewayConfig } from "../src/config.ts";
import { gateDeviceCalls } from "../src/device-gate.ts";
import { makeGatewayEnvironment } from "../src/environment.ts";
import { makePersonHub } from "../src/hub.ts";
import { MendClient, MendClientLive } from "../src/mend-client.ts";
import type { MendProject } from "../src/mend-workbench.ts";
import { makeGatewayRpcHandlers } from "../src/rpc.ts";
import { openGatewayState } from "../src/state.ts";
import { inlineFindParser } from "./support/find-parser.ts";
import { testBearerSession, unreachableMend } from "./support/stubs.ts";

const at = "2026-11-07T12:00:00.000Z";
const project: MendProject = {
  id: "adopted",
  name: "repo",
  storePath: "/store/adopted/repo.git",
  originUrl: "git@github.com:alice/repo.git",
  defaultBranch: "main",
  createdAt: at,
  updatedAt: at,
};
const repository = {
  provider: "github",
  nameWithOwner: "alice/repo",
  url: "https://github.com/alice/repo",
  sshUrl: "git@github.com:alice/repo.git",
};
const fixture = Effect.gen(function* () {
  const requests: Array<{ path: string; token: string | undefined; body: unknown }> = [];
  let current: MendProject | null = null;
  let refusal: { status: number; message: string } | null = null;
  let isPrivate = false;
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body: unknown =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : null;
      requests.push({ path: url.pathname, token: request.headers.authorization, body });
      if (refusal)
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { _tag: "StoreFailure", message: refusal.message },
            { status: refusal.status },
          ),
        );
      if (url.pathname === "/api/me/sealant")
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            accounts: [
              {
                provider: "github",
                name: "alice",
                isDefault: true,
                status: "active",
                metadata: { login: "alice" },
              },
            ],
          }),
        );
      if (url.pathname === "/api/github/repository")
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            ...repository,
            cloneUrl: isPrivate ? repository.sshUrl : repository.url,
          }),
        );
      if (url.pathname === "/api/projects/adopted/local-worktree")
        return HttpClientResponse.fromWeb(request, Response.json(null));
      if (url.pathname === "/api/projects") current = project;
      if (
        url.pathname === "/api/projects/adopted/name" &&
        typeof body === "object" &&
        body !== null &&
        "name" in body &&
        typeof body.name === "string"
      )
        current = { ...project, name: body.name };
      return HttpClientResponse.fromWeb(request, Response.json(current));
    }),
  );
  const live = yield* MendClient.pipe(
    Effect.provide(
      MendClientLive.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provide(
          Layer.succeed(GatewayConfig, {
            mendUrl: new URL("http://mend.test"),
            host: "127.0.0.1",
            port: 0,
            statePath: ":memory:",
            label: "Mend",
          }),
        ),
      ),
    ),
  );
  const mend = gateDeviceCalls(
    {
      ...unreachableMend,
      ...live,
      listProjects: () => Effect.succeed(current ? [current] : []),
      listActiveSessions: () => Effect.succeed([]),
      listSkills: () => Effect.succeed([]),
      projectSkills: () => Effect.succeed([]),
      events: () => Stream.never,
      projectDetail: () =>
        current
          ? Effect.succeed({ project: current, sessions: [], annotations: [] })
          : unreachableMend.projectDetail("", ""),
    },
    () => Effect.void,
  );
  const state = yield* openGatewayState(":memory:");
  let revoked = false;
  const hub = yield* makePersonHub({
    mend,
    viewer: testBearerSession.mendUser,
    state,
    parser: inlineFindParser,
    tokens: {
      current: () => testBearerSession.deviceToken,
      live: () => [testBearerSession.deviceToken],
      refuse: () => Effect.void,
      isRefused: () => revoked,
      refusal: () => Effect.never,
      noneLeft: Effect.never,
    },
  });
  const rpc = (session = testBearerSession) =>
    makeGatewayRpcHandlers({
      hub,
      session,
      environment: makeGatewayEnvironment({
        environmentId: EnvironmentId.make("projects"),
        label: "Mend",
        host: "127.0.0.1",
        statePath: ":memory:",
      }),
      attachmentUploads: {
        issue: () => Effect.die("No uploads in this fixture"),
        receive: () => Effect.die("No uploads in this fixture"),
        remove: () => Effect.die("No uploads in this fixture"),
      },
      assetUrls: {
        issue: () => Effect.succeed({ relativeUrl: "/unused", expiresAt: 0 }),
        open: () => Effect.die("unused"),
      },
      clientAppVersion: "0.1.2",
    });
  return {
    hub,
    rpc,
    requests,
    privateRepository: () => {
      isPrivate = true;
    },
    refuse: (status: number, message: string) => {
      refusal = { status, message };
    },
    revoke: () => {
      revoked = true;
    },
  };
});
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/Scope").Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

describe("project operations through the gateway", () => {
  it("discovers the caller's selected account and reports unreadable auth as unknown", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const discovered = yield* f.rpc()[WS_METHODS.serverDiscoverSourceControl]();
        expect(discovered.sourceControlProviders[0]?.auth).toMatchObject({
          status: "authenticated",
          account: { _tag: "Some", value: "alice" },
        });
        expect(f.requests[0]?.token).toBe(`Bearer ${testBearerSession.deviceToken}`);
        f.refuse(502, "Connected accounts are unavailable.");
        const unavailable = yield* f.rpc()[WS_METHODS.serverDiscoverSourceControl]();
        expect(unavailable.sourceControlProviders[0]?.auth.status).toBe("unknown");
      }),
    ));
  it("adopts a URL privately as the paired person and publishes the managed path before answering", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const result = yield* f.rpc()[WS_METHODS.sourceControlCloneRepository]({
          remoteUrl: "https://github.com/alice/repo.git",
          destinationPath: "/a/client/path/repo",
        });
        expect(result.cwd).toBe(project.storePath);
        expect((yield* f.hub.shellSnapshot).projects).toContainEqual(
          expect.objectContaining({ id: project.id, workspaceRoot: project.storePath }),
        );
        expect(f.requests).toContainEqual({
          path: "/api/projects",
          token: `Bearer ${testBearerSession.deviceToken}`,
          body: {
            name: "repo",
            source: "https://github.com/alice/repo.git",
            visibility: "private",
          },
        });
      }),
    ));
  it("looks up GitHub as the caller, then clones with the caller's configured git access", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(
          yield* f.rpc()[WS_METHODS.sourceControlLookupRepository]({
            provider: SourceControlProviderKind.make("github"),
            repository: "alice/repo",
          }),
        ).toEqual(repository);
        yield* f.rpc()[WS_METHODS.sourceControlCloneRepository]({
          provider: SourceControlProviderKind.make("github"),
          repository: "alice/repo",
          destinationPath: "repo",
        });
        expect(f.requests.find((request) => request.path === "/api/projects")?.body).toEqual({
          name: "repo",
          source: repository.url,
          visibility: "private",
        });
        expect(f.requests.every((r) => r.token === `Bearer ${testBearerSession.deviceToken}`)).toBe(
          true,
        );
      }),
    ));
  it("clones a private picker's HTTPS URL over SSH, like Mend's own picker", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        f.privateRepository();
        const rpc = f.rpc();
        const selected = yield* rpc[WS_METHODS.sourceControlLookupRepository]({
          provider: SourceControlProviderKind.make("github"),
          repository: "https://github.com/alice/repo",
        });
        // Pinned T3 sends only this URL, with neither provider nor repository metadata.
        const result = yield* rpc[WS_METHODS.sourceControlCloneRepository]({
          remoteUrl: selected.url,
          destinationPath: "/client/private-repo",
        });
        expect(result.remoteUrl).toBe(repository.sshUrl);
        expect(f.requests.find((request) => request.path === "/api/projects")).toEqual({
          path: "/api/projects",
          token: `Bearer ${testBearerSession.deviceToken}`,
          body: { name: "private-repo", source: repository.sshUrl, visibility: "private" },
        });
      }),
    ));
  it("renames in Mend and refreshes the shell, preserving a readable refusal", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.rpc()[WS_METHODS.sourceControlCloneRepository]({
          remoteUrl: "https://github.com/alice/repo.git",
          destinationPath: "repo",
        });
        yield* f.rpc()[WS_METHODS.projectsMutate]({
          type: "project.update",
          commandId: CommandId.make("rename"),
          projectId: ProjectId.make(project.id),
          title: "renamed",
        });
        expect((yield* f.hub.shellSnapshot).projects[0]?.title).toBe("renamed");
        f.refuse(422, "That name is already in use.");
        const error = yield* Effect.flip(
          f.rpc()[WS_METHODS.projectsMutate]({
            type: "project.update",
            commandId: CommandId.make("refused"),
            projectId: ProjectId.make(project.id),
            title: "taken",
          }),
        );
        expect(error.message).toContain("That name is already in use.");
      }),
    ));
  it("refuses local paths, unsupported hosts and read-only writes before any adoption", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.flip(
          f.rpc()[WS_METHODS.sourceControlCloneRepository]({
            remoteUrl: "/host/private",
            destinationPath: "repo",
          }),
        );
        yield* Effect.flip(
          f.rpc()[WS_METHODS.sourceControlLookupRepository]({
            provider: SourceControlProviderKind.make("gitlab"),
            repository: "alice/repo",
          }),
        );
        const readOnly = f.rpc({ ...testBearerSession, scopes: ["orchestration:read"] });
        yield* Effect.flip(
          readOnly[WS_METHODS.sourceControlCloneRepository]({
            remoteUrl: "https://github.com/alice/repo",
            destinationPath: "repo",
          }),
        );
        f.revoke();
        yield* Effect.flip(
          f.rpc()[WS_METHODS.sourceControlCloneRepository]({
            remoteUrl: "https://github.com/alice/repo",
            destinationPath: "repo",
          }),
        );
        expect(f.requests).toEqual([]);
      }),
    ));
});
