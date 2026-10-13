import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import {
  HotWorkspacesRepo,
  ProjectLinksRepo,
  ProjectLinkNotFoundError,
  SessionRepositoriesRepoMemory,
  ReferenceNotFoundError,
  ReferencesRepo,
  WorktreesRepo,
  AgentMemoryRepo,
  UserDotfilesRepo,
  UserGitAuthorRepo,
  InstanceRolesRepo,
  SessionChannelTokensRepoMemory,
  harnessLayoutsRepoMemory,
  piProfileDigest,
  agentMemoryDigest,
} from "@mend/db";
import {
  OrganizationId,
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
  defaultSettings,
  type DotfilesRepository,
  ReferenceId,
} from "@mend/domain";
import {
  HotWorkspace,
  Project,
  ResolvedGitAuthor,
  Session,
  SessionProcess,
  SessionRun,
  PiProfile,
  serviceStartCorrelation,
  Reference,
} from "@mend/domain/workbench";
import { LAUNCH_BOOTING, LAUNCH_PREPARING } from "@mend/domain/workbench";
import { PersonLayoutPlatformNone, SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  CaptureRuntimeOff,
  HarnessStateNotFoundError,
  LegacyBenchReadOnlyError,
  ProtocolHost,
  SessionEngine,
  SessionEngineLive,
  SessionRepositoryLocalLive,
  SessionNotLiveError,
  WorkspaceGitHooks,
  WorkspaceGitHooksLive,
  WorkspaceHostUserNamespacesUnobserved,
} from "@mend/sessions";
import {
  DotfilesStore,
  DotfilesStoreError,
  Store,
  StoreConfig,
  DeploymentConfigColocated,
  harnessHomePathOf,
  processStatePathOf,
} from "@mend/store";
import type {
  CreateOptions,
  InteractiveSessionStatus,
  SessionOptions,
  WorkspacePhase,
  WorkspaceRuntimeInfo,
} from "@sealant/sdk";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Schedule } from "effect";

import { HarnessLayoutConfigShared } from "../src/harness-layout-steps.ts";
import { HARNESS_UPDATES_OFF_ENV, NO_PAGER_ENV, OPENCODE_SEED } from "../src/harness-seeds.ts";
import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import {
  CUSTOM_BASE,
  NEWER_SNAPSHOT,
  SNAPSHOT,
  dotfilesStoreLayer,
  isShellProfileExec,
  launchOnce,
  lifecycleLayer,
  type LaunchImage,
  until,
} from "./engine/capture-fixture.ts";
import {
  agentBridgeStubLayer,
  agentConversationStubLayer,
  agentMemoryLayerOf,
  auditLayer,
  byWorkspaceCreatorIn,
  changesLayer,
  checkpointsLayer,
  dotfilesClonerLayer,
  dotfilesStoreStubLayer,
  emptyClusterBindings,
  emptyEnvironment,
  emptySecrets,
  foldersEmptyLayer,
  gitAuthorStubLayer,
  gitOpsStubLayer,
  hotWorkspacesEmptyLayer,
  launchSkill,
  makeWorld,
  mendKeysStubLayer,
  now,
  organizationsLayer,
  piProfilesLayerOf,
  pickedUpWrites,
  projectClusterBindingsLayer,
  projectEnvironmentLayer,
  projectLinksEmptyLayer,
  projectMountsEmptyLayer,
  projectRecipesEmptyLayer,
  projectSecretsLayer,
  projectsLayer,
  protocolHostStubLayer,
  recordingProtocolHostLayer,
  referencesEmptyLayer,
  sealantDeadLayer,
  sealantLaunchLayer,
  secretCipherStubLayer,
  secretFilesLayerOf,
  servedSocketApis,
  serviceHostStubLayer,
  serviceStateLayer,
  sessionProcessesLayer,
  sessionRunsLayer,
  sessionSocketStubLayer,
  sessionsLayer,
  settingsLayer,
  setup,
  setupSibling,
  skillsForLaunchLayer,
  skillsStubLayer,
  sourcePolicyLayer,
  testDrainPolicy,
  userDotfilesStubLayer,
  withEngine,
  withEngineEffect,
  worktreesLayer,
} from "./engine/fixture.ts";

/** No machine key and no transport log in these worlds. */
// Dotfiles resolve per owner; the engine fixtures run without any configured, so launches
// carry no archives and stamp an empty record.
/** The exec that writes the owner's git author as system config (`gitAuthorConfigArgv`). */
const isGitAuthorExec = (argv: ReadonlyArray<string>): boolean => argv[3] === "mend-git-author";

/** The owner's pi profile; none unless a test brings one. */
/** A live process row in a workspace, as the engine records one. */
const liveProcessRow = (
  id: string,
  sessionId: SessionId,
  workspaceId: SealantWorkspaceId,
  kind: "shell" | "agent-pty",
  harness: string | null,
) =>
  new SessionProcess({
    id: SessionProcessId.make(id),
    sessionId,
    sealantWorkspaceId: workspaceId,
    sealantSessionId: `pty-${id}`,
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind,
    harness,
    providerSessionId: null,
    protocolOptions: null,
    label: kind,
    argv: kind === "shell" ? ["bash", "-i"] : [harness ?? "pi"],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: now(),
    exitedAt: null,
    updatedAt: now(),
  });

/** Another person's pi profile, as a restored harness home brings it. */
const plantForeignPiProfile = (home: string) => {
  const file = path.join(home, ".pi/agent/mend/profile/extensions/theirs/index.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export default () => {};\n");
};

const bigintSafe = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

describe("SessionEngine", () => {
  it.each([
    { ownerUserId: null, isOperator: false, transports: false },
    { ownerUserId: "non-operator", isOperator: false, transports: false },
    { ownerUserId: "verified-operator", isOperator: true, transports: true },
  ])(
    "starts locally with owner $ownerUserId while enforcing the named origin's authority",
    async (control) => {
      const requested: string[] = [];
      const roleQueries: string[] = [];
      const server = http.createServer((request, response) => {
        requested.push(request.url ?? "");
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No recorder address.");
      try {
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const project = yield* setup(tmp, world);
              execFileSync("git", [
                "-C",
                project.storePath,
                "remote",
                "set-url",
                "origin",
                `http://127.0.0.1:${address.port}/private.git`,
              ]);
              // Older projects may have no recorded source; their actual named target is still checked.
              world.projects.set(
                project.id,
                new Project({ ...project, originUrl: null, gitAuthMode: "bridge" }),
              );
              const session = yield* (yield* SessionEngine).provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: control.ownerUserId,
                base: null,
              });
              expect(session.baseSha).toBe(project.adoptedSha);
              expect(world.sessions.has(session.id)).toBe(true);
            }),
          {
            instanceRolesLayer: Layer.mock(InstanceRolesRepo, {
              isOperator: (userId) =>
                Effect.sync(() => {
                  roleQueries.push(userId);
                  return control.isOperator;
                }),
            }),
          },
        );
        expect(requested.length > 0).toBe(control.transports);
        expect(roleQueries).toEqual(control.ownerUserId === null ? [] : [control.ownerUserId]);
        if (control.transports)
          expect(requested).toEqual(["/private.git/info/refs?service=git-upload-pack"]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    },
  );

  it("launches with the configured image and the user's GitHub token", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });

          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.os).toBe("nix");
          expect(created[0]?.packages).toEqual(["bat", "lazygit"]);
          expect(created[0]?.services).toEqual({ docker: true });
          expect(created[0]?.credentials).toEqual({ codex: true, github: true });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        workspaceImage: {
          mode: "family",
          os: "nix",
          packages: ["bat", "lazygit"],
          shell: "bash",
          services: { docker: true },
        },
      },
    );
  });

  it("refuses to launch into an existing worktree whose store holds a login or token, and mounts nothing", async () => {
    // Review 5 of mend#640, R5-1: a join returns the worktree without `Store.createWorktree`, so
    // the store gate alone let an older server's credential reach the workspace's mounts.
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const input = {
            projectId: project.id,
            harness: "codex",
            label: null,
            name: "legacy",
            ownerUserId: "user-fixture",
            base: null,
          };
          const first = yield* engine.provision(input);
          execFileSync("git", [
            "-C",
            project.storePath,
            "config",
            "remote.origin.url",
            "http://user:LEGACY-TOKEN@127.0.0.1:9/repo",
          ]);
          const joined = yield* engine.provision(input);
          expect(joined.worktreeId).toBe(first.worktreeId);
          const refused = yield* engine.launch(joined.id, ["codex"]).pipe(Effect.flip);
          expect(
            refused._tag === "DotfilesResolveError" ? refused.message : refused._tag,
          ).toContain("remote.origin.url (a login or token");
          expect(JSON.stringify(refused)).not.toContain("LEGACY-TOKEN");
          expect(created).toHaveLength(0);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it.each(["references", "links"] as const)(
    "refuses to launch when the project's %s cannot be read, rather than mount them unchecked",
    async (failing) => {
      // A read that fails refuses as a finding does (fail closed): what it could not list would
      // be mounted without its git config checked.
      const created: CreateOptions[] = [];
      const broken = Effect.die("the database is not answering");
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
              base: null,
            });
            const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
            expect(
              refused._tag === "DotfilesResolveError" ? refused.message : refused._tag,
            ).toContain(
              failing === "references"
                ? "could not read this project's selected references"
                : "could not read this project's linked projects",
            );
            expect(created).toHaveLength(0);
          }),
        {
          sealantLayer: sealantLaunchLayer(created),
          ...(failing === "references"
            ? {
                referencesLayer: Layer.succeed(ReferencesRepo, {
                  create: () => Effect.die("not in test"),
                  byId: (id) => Effect.fail(new ReferenceNotFoundError({ referenceId: id })),
                  byName: () => Effect.succeed(null),
                  listAll: () => Effect.succeed([]),
                  listForOrganization: () => Effect.succeed([]),
                  byIdsInOrganization: () => Effect.succeed([]),
                  remove: () => Effect.void,
                  setHead: () => Effect.void,
                  listForProject: () => broken,
                  setForProject: () => Effect.void,
                }),
              }
            : {
                projectLinksLayer: Layer.succeed(ProjectLinksRepo, {
                  create: () => Effect.die("not in test"),
                  byId: (id) => Effect.fail(new ProjectLinkNotFoundError({ linkId: id })),
                  listForProject: () => broken,
                  remove: () => Effect.void,
                }),
              }),
        },
      );
    },
  );

  it("refuses to launch with a selected reference whose clone holds a login or token", async () => {
    const created: CreateOptions[] = [];
    const selected: Array<Reference> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const clone = path.join(tmp, "legacy-reference");
          execFileSync("git", ["clone", "-q", path.join(tmp, "origin"), clone]);
          execFileSync("git", [
            "-C",
            clone,
            "config",
            "remote.origin.url",
            "https://user:REFERENCE-TOKEN@host.invalid/repo",
          ]);
          selected.push(
            new Reference({
              id: ReferenceId.make("legacy-reference"),
              name: "legacy-reference",
              organizationId: project.organizationId,
              createdByUserId: "user-fixture",
              originUrl: "https://host.invalid/repo",
              path: clone,
              pinnedRef: null,
              headSha: null,
              refreshedAt: null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            }),
          );
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(
            refused._tag === "DotfilesResolveError" ? refused.message : refused._tag,
          ).toContain("a login or token");
          expect(JSON.stringify(refused)).not.toContain("REFERENCE-TOKEN");
          expect(created).toHaveLength(0);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        referencesLayer: Layer.succeed(ReferencesRepo, {
          create: () => Effect.die("not in test"),
          byId: (id) => Effect.fail(new ReferenceNotFoundError({ referenceId: id })),
          byName: () => Effect.succeed(null),
          listAll: () => Effect.succeed(selected),
          listForOrganization: () => Effect.succeed(selected),
          byIdsInOrganization: () => Effect.succeed(selected),
          remove: () => Effect.void,
          setHead: () => Effect.void,
          listForProject: () => Effect.succeed(selected),
          setForProject: () => Effect.void,
        }),
      },
    );
  });

  it("reports the platform's runtime-specific Docker refusal without Kubernetes-only advice", async () => {
    const created: CreateOptions[] = [];
    const platformCause = new Error("MicroVM capability refusal");
    const platformMessage =
      "This deployment runs workspaces on the 'microvm' runtime, which has no workspace-scoped Docker. Turn Docker off for this workspace.";

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
            base: null,
          });

          const failure = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);

          expect(failure).toBeInstanceOf(SealantPlatformError);
          const platformFailure = failure instanceof SealantPlatformError ? failure : null;
          expect(platformFailure?.code).toBe("workspace-docker-unsupported");
          expect(platformFailure?.status).toBe(422);
          expect(platformFailure?.cause).toBe(platformCause);
          expect(platformFailure?.message).toBe(`launch refused · Docker · ${platformMessage}`);
          expect(platformFailure?.message).not.toContain("Sealant chart");
          expect(platformFailure?.message).not.toContain("workspaces.docker");
          expect(created).toHaveLength(1);
          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("failed");
          expect(settled?.summary).toContain(platformMessage);
          expect(settled?.summary).not.toContain("Sealant chart");
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          () => false,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Effect.fail(
              new SealantPlatformError({
                code: "workspace-docker-unsupported",
                status: 422,
                message: platformMessage,
                cause: platformCause,
              }),
            ),
        ),
        workspaceImage: {
          mode: "family",
          os: "ubuntu",
          packages: [],
          shell: "bash",
          services: { docker: true },
        },
      },
    );
  });

  it("delivers the launching owner's skills and lets project skills override by name", async () => {
    const created: CreateOptions[] = [];
    const requestedOwners: Array<string | null> = [];
    const skillsLayer = skillsForLaunchLayer((ownerUserId, projectId) =>
      Effect.sync(() => {
        requestedOwners.push(ownerUserId);
        return {
          user: [
            launchSkill("global", "owner global", {
              scope: "user",
              userId: ownerUserId ?? "missing-owner",
            }),
            launchSkill("shared", "owner shared", {
              scope: "user",
              userId: ownerUserId ?? "missing-owner",
            }),
          ],
          project: [launchSkill("shared", "project shared", { scope: "project", projectId })],
        };
      }),
    );
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
            ownerUserId: "owner-1",
            base: null,
          });

          yield* engine.launch(session.id, ["codex"]);

          const skillsRoot = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "skills",
          );
          expect(fs.readFileSync(path.join(skillsRoot, "global", "SKILL.md"), "utf8")).toBe(
            "owner global",
          );
          expect(fs.readFileSync(path.join(skillsRoot, "shared", "SKILL.md"), "utf8")).toBe(
            "project shared",
          );
          expect(requestedOwners).toEqual(["owner-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created), skillsLayer },
    );
  });

  it("excludes user skills when the project's inheritance setting is off", async () => {
    const created: CreateOptions[] = [];
    const skillsLayer = skillsForLaunchLayer((ownerUserId, projectId) =>
      Effect.succeed({
        user: [
          launchSkill("global", "owner global", {
            scope: "user",
            userId: ownerUserId ?? "missing-owner",
          }),
        ],
        project: [launchSkill("local", "project local", { scope: "project", projectId })],
      }),
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const noInheritance = new Project({ ...project, inheritUserSkills: false });
          world.projects.set(project.id, noInheritance);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "owner-2",
            base: null,
          });

          yield* engine.launch(session.id, ["codex"]);

          const skillsRoot = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "skills",
          );
          expect(fs.existsSync(path.join(skillsRoot, "global"))).toBe(false);
          expect(fs.readFileSync(path.join(skillsRoot, "local", "SKILL.md"), "utf8")).toBe(
            "project local",
          );
        }),
      { sealantLayer: sealantLaunchLayer(created), skillsLayer },
    );
  });

  it("delivers the owner's pi profile to a pi session, and to no other", async () => {
    const created: CreateOptions[] = [];
    const files = [
      {
        path: "extensions/git-info/index.ts",
        encoding: "utf8",
        contents: "export default () => {};\n",
      },
    ] as const;
    const asked: Array<string> = [];
    const piProfilesLayer = piProfilesLayerOf((userId) =>
      Effect.sync(() => {
        asked.push(userId);
        return {
          profile: new PiProfile({
            fileCount: 1,
            bytes: files[0].contents.length,
            extensions: ["git-info"],
            packages: [],
            digest: piProfileDigest(files),
            revision: 1,
            updatedAt: new Date(0),
          }),
          files,
        };
      }),
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const start = (harness: string) =>
            engine.provision({
              projectId: project.id,
              harness,
              label: null,
              name: null,
              ownerUserId: "owner-pi",
              base: null,
            });
          const pi = yield* start("pi");
          yield* engine.launch(pi.id, ["pi"]);
          const codex = yield* start("codex");
          yield* engine.launch(codex.id, ["codex"]);

          const delivered = (sessionId: typeof pi.id) =>
            path.join(
              harnessHomePathOf(project.storePath, sessionId),
              ".pi/agent/mend/profile/extensions/git-info/index.ts",
            );
          expect(fs.readFileSync(delivered(pi.id), "utf8")).toBe(files[0].contents);
          expect(fs.existsSync(delivered(codex.id))).toBe(false);
          expect(asked).toEqual(["owner-pi"]);
        }),
      { sealantLayer: sealantLaunchLayer(created), piProfilesLayer },
    );
  });

  it("refuses a pi launch whose owner's profile cannot be delivered", async () => {
    const created: CreateOptions[] = [];
    const files = [
      { path: "extensions/mine/index.ts", encoding: "utf8", contents: "export default 1;\n" },
    ] as const;
    const piProfilesLayer = piProfilesLayerOf(() =>
      Effect.succeed({
        profile: new PiProfile({
          fileCount: 1,
          bytes: files[0].contents.length,
          extensions: ["mine"],
          packages: [],
          digest: piProfileDigest(files),
          revision: 1,
          updatedAt: new Date(0),
        }),
        files,
      }),
    );
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "pi",
            label: null,
            name: null,
            ownerUserId: "owner-with-profile",
            base: null,
          });
          const home = harnessHomePathOf(project.storePath, session.id);
          plantForeignPiProfile(home);
          fs.writeFileSync(path.join(home, ".mend"), "not a directory");
          const failure = yield* engine.launch(session.id, ["pi"]).pipe(Effect.flip);
          const platformFailure = failure instanceof SealantPlatformError ? failure : null;
          expect(platformFailure?.code).toBe("PI_PROFILE_NOT_DELIVERED");
          expect(world.sessions.get(session.id)?.status).toBe("failed");
        }),
      { sealantLayer: sealantLaunchLayer(created), piProfilesLayer },
    );
  });

  it("a pi follow-up in a retained workspace runs on its owner's profile, and on the one there beside a live pi", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const provision = (ownerUserId: string) =>
            engine.provision({
              projectId: project.id,
              harness: "pi",
              label: null,
              name: null,
              ownerUserId,
              base: null,
            });
          const session = yield* provision("owner-a");
          yield* engine.launch(session.id, ["pi"]);
          const workspaceId =
            [...world.processes.values()].find((process) => process.sessionId === session.id)
              ?.sealantWorkspaceId ?? SealantWorkspaceId.make("workspace-1");
          const shell = liveProcessRow("shell-a", session.id, workspaceId, "shell", null);
          world.processes.set(shell.id, shell);
          const stopAgent = Effect.gen(function* () {
            yield* engine.stop(session.id);
            const agentLive = () =>
              [...world.processes.values()].some(
                (process) =>
                  process.sessionId === session.id &&
                  process.kind === "agent-pty" &&
                  process.exitedAt === null,
              );
            for (let i = 0; i < 200 && agentLive(); i++) yield* Effect.sleep(Duration.millis(10));
            expect(agentLive()).toBe(false);
          });
          const home = harnessHomePathOf(project.storePath, session.id);
          const profile = path.join(home, ".pi/agent/mend/profile");

          // No pi runs there: the profile the harness home holds is moved aside, as at a launch.
          yield* stopAgent;
          plantForeignPiProfile(home);
          yield* engine.launchFollowUp(session.id, "Carry on.", "follow-up:pi-1", "owner-a");
          expect(fs.existsSync(profile)).toBe(false);
          expect(fs.readdirSync(path.join(home, ".mend/pi-profile-kept")).length).toBeGreaterThan(
            0,
          );

          // Another person's pi runs in the workspace: the launch runs on the profile already
          // there, which is left as it is.
          yield* stopAgent;
          plantForeignPiProfile(home);
          const other = yield* provision("owner-b");
          const theirs = liveProcessRow("pi-b", other.id, workspaceId, "agent-pty", "pi");
          world.processes.set(theirs.id, theirs);
          yield* engine.launchFollowUp(session.id, "Carry on.", "follow-up:pi-2", "owner-a");
          expect(fs.existsSync(profile)).toBe(true);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("moves aside a pi profile that is not the owner's, and refuses the launch when it cannot", async () => {
    // A pi launch runs on its owner's freshly delivered profile, on no profile, or not at all.
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const start = () =>
            engine.provision({
              projectId: project.id,
              harness: "pi",
              label: null,
              name: null,
              ownerUserId: "owner-without-profile",
              base: null,
            });
          const moved = yield* start();
          const movedHome = harnessHomePathOf(project.storePath, moved.id);
          plantForeignPiProfile(movedHome);
          yield* engine.launch(moved.id, ["pi"]);
          expect(fs.existsSync(path.join(movedHome, ".pi/agent/mend/profile"))).toBe(false);
          const kept = fs.readdirSync(path.join(movedHome, ".mend/pi-profile-kept"));
          expect(kept).toHaveLength(1);

          // The profile cannot be moved: the session fails instead of running it.
          const stuck = yield* start();
          const stuckHome = harnessHomePathOf(project.storePath, stuck.id);
          plantForeignPiProfile(stuckHome);
          fs.writeFileSync(path.join(stuckHome, ".mend"), "not a directory");
          const failure = yield* engine.launch(stuck.id, ["pi"]).pipe(Effect.flip);
          const platformFailure = failure instanceof SealantPlatformError ? failure : null;
          expect(platformFailure?.code).toBe("PI_PROFILE_NOT_DELIVERED");
          expect(world.sessions.get(stuck.id)?.status).toBe("failed");
          expect(fs.existsSync(path.join(stuckHome, ".pi/agent/mend/profile"))).toBe(true);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("delivers the owner's agent memory at launch and reads back what the agent learned when it stops", async () => {
    const created: CreateOptions[] = [];
    const root = ".claude/projects/-workspace-repo/memory";
    const index = { path: `${root}/MEMORY.md`, encoding: "utf8", contents: "- one\n" } as const;
    const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
    const agentMemoryLayer = agentMemoryLayerOf({
      forLaunch: (userId) =>
        Effect.succeed(
          userId === "owner-memory"
            ? [{ ...index, digest: agentMemoryDigest(index), updatedBySession: null }]
            : [],
        ),
      readBack: (input) =>
        Effect.sync(() => {
          readBacks.push(input);
          return { saved: [], merged: [], deleted: [], skipped: [] };
        }),
    });
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "owner-memory",
            base: null,
          });
          yield* engine.launch(session.id, ["claude"]);
          const home = harnessHomePathOf(project.storePath, session.id);
          expect(fs.readFileSync(path.join(home, index.path), "utf8")).toBe("- one\n");

          // The agent learned something, then the session stopped.
          fs.writeFileSync(path.join(home, root, "learned.md"), "the API listens on 3101\n");
          yield* engine.stop(session.id);
          yield* until(() => readBacks.length > 0, "agent memory read back");
          const [readBack] = readBacks;
          expect(readBack?.userId).toBe("owner-memory");
          expect(readBack?.sessionId).toBe(session.id);
          expect(readBack?.delivered).toEqual({ [index.path]: agentMemoryDigest(index) });
          expect(readBack?.session.map((file) => file.path).toSorted()).toEqual([
            index.path,
            `${root}/learned.md`,
          ]);
        }),
      { sealantLayer: sealantLaunchLayer(created), agentMemoryLayer },
    );
  });

  it("carries the owner's earlier Codex conversations into a Codex launch, minus what Codex summarised (docs/adr/0009, Codex)", async () => {
    const created: CreateOptions[] = [];
    const summarisedId = "11111111-1111-4111-8111-111111111111";
    const pendingId = "22222222-2222-4222-8222-222222222222";
    // The stored summary database lists one of the two conversations as summarised.
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-codex-db-"));
    const dbFile = path.join(dbDir, "memories_1.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec(
      "create table stage1_outputs (thread_id text primary key, source_updated_at integer not null)",
    );
    const summarisedAt = Math.floor((Date.now() - 8 * 60 * 60 * 1000) / 1000);
    db.prepare("insert into stage1_outputs values (?, ?)").run(summarisedId, summarisedAt);
    db.close();
    const database = {
      path: ".codex/memories_1.sqlite",
      encoding: "base64",
      contents: fs.readFileSync(dbFile).toString("base64"),
    } as const;
    const agentMemoryLayer = agentMemoryLayerOf({
      forLaunch: () =>
        Effect.succeed([
          { ...database, digest: agentMemoryDigest(database), updatedBySession: null },
        ]),
    });
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const provision = () =>
            engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: "owner-codex",
              base: null,
            });
          // Two earlier Codex sessions of the owner's, each with a harvested conversation that
          // ended eight hours ago.
          for (const providerSessionId of [summarisedId, pendingId]) {
            const earlier = yield* provision();
            yield* engine.launch(earlier.id, ["codex"]);
            const agent = [...world.processes.values()].find(
              (row) => row.sessionId === earlier.id && row.kind === "agent-pty",
            );
            if (agent === undefined) throw new Error("the earlier launch recorded no agent");
            world.processes.set(
              agent.id,
              new SessionProcess({ ...agent, status: "exited", exitCode: 0, exitedAt: now() }),
            );
            const stateDir = processStatePathOf(project.storePath, earlier.id, agent.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({
                harness: "codex",
                providerSessionId,
                // The summary's own time: Codex summarised this exact revision.
                capturedAt: new Date(summarisedAt * 1000).toISOString(),
              }),
            );
            fs.writeFileSync(
              path.join(stateDir, "transcript.native"),
              `${JSON.stringify({ type: "session_meta", payload: { id: providerSessionId, timestamp: "2026-09-30T08:00:00Z" } })}\n`,
            );
          }

          const session = yield* provision();
          yield* engine.launch(session.id, ["codex"]);
          const home = harnessHomePathOf(project.storePath, session.id);
          const carried = path.join(
            home,
            `.codex/sessions/2026/09/30/rollout-2026-09-30T08-00-00-${pendingId}.jsonl`,
          );
          yield* until(() => fs.existsSync(carried), "the pending conversation carried in");
          expect(
            fs
              .readFileSync(path.join(home, ".mend/carried-transcripts"), "utf8")
              .trim()
              .split("\n")
              .toSorted(),
          ).toEqual([summarisedId, pendingId].toSorted());
          // The summarised one is there as a stub: its first line, at the summary's time, so Codex
          // keeps its summary without making it again.
          const stub = path.join(
            home,
            `.codex/sessions/2026/09/30/rollout-2026-09-30T08-00-00-${summarisedId}.jsonl`,
          );
          expect(fs.readFileSync(stub, "utf8").trim().split("\n")).toHaveLength(1);
          expect(Math.floor(fs.statSync(stub).mtimeMs / 1000)).toBe(summarisedAt);
          expect(fs.readFileSync(carried, "utf8")).toContain(pendingId);
        }),
      { sealantLayer: sealantLaunchLayer(created), agentMemoryLayer },
    );
  });

  it("launches a protocol agent through a pipe and records an agent-protocol process", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const openedOptions: SessionOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    const authors: Array<string | null> = [];
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
            base: null,
          });

          yield* engine.launchProtocol(
            session.id,
            {
              mode: "protocol",
              prompt: "inspect replay",
              model: "gpt-test",
              effort: "high",
              permissionMode: "ask",
            },
            "user-1",
          );

          expect(openedOptions).toEqual([{ mode: "pipe" }]);
          // Codex's memory is on in every Codex session Mend starts (docs/adr/0009, "Codex").
          // Its shell snapshot is off: it writes exported values into the harness home. Its
          // background server is off: it copies Codex's release into the harness home.
          expect(spawned[0]?.slice(-8)).toEqual([
            "codex",
            "-c",
            "features.shell_snapshot=false",
            "-c",
            "features.daemon_auto_start=false",
            "-c",
            "features.memories=true",
            "app-server",
          ]);
          expect(attached).toHaveLength(1);
          expect(attached[0]?.mode).toBe("pipe");
          expect(attached[0]?.process.kind).toBe("agent-protocol");
          expect(attached[0]?.process.argv).toEqual(["codex", "app-server"]);
          expect(submitted).toEqual(["inspect replay"]);
          // The session records the model and effort the admitted launch runs on
          // (docs/models-audit.md).
          expect(world.sessions.get(session.id)?.model).toBe("gpt-test");
          expect(world.sessions.get(session.id)?.effort).toBe("high");

          const duplicate = yield* engine
            .launchProtocol(session.id, { mode: "protocol", permissionMode: "bypass" }, null)
            .pipe(Effect.flip);
          expect(duplicate).toBeInstanceOf(SealantPlatformError);
          expect(duplicate instanceof SealantPlatformError ? duplicate.code : null).toBe(
            "session_active",
          );
          expect(attached).toHaveLength(1);

          yield* engine.stop(session.id);
          yield* engine.resumeSession(session.id, null);
          expect(attached[1]?.process.kind).toBe("agent-protocol");

          yield* engine.stop(session.id);
          yield* engine.launchFollowUp(session.id, "address the review", "follow-up-1", "user-2");
          expect(attached[2]?.process.kind).toBe("agent-protocol");
          expect(attached[2]?.process.launchCorrelationId).toBe("follow-up-1");
          expect(submitted).toEqual(["inspect replay", "address the review"]);
          // The follow-up turn is the reviewer's, never an anonymous one.
          expect(authors).toEqual(["user-1", "user-2"]);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          openedOptions,
        ),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted, authors),
      },
    );
  });

  it("brings an ask session back asking: resume, follow-up and a relaunch that names no mode", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    const authors: Array<string | null> = [];
    const permissionModes: Array<"bypass" | "ask"> = [];
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
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            {
              mode: "protocol",
              prompt: "inspect replay",
              model: "gpt-test",
              effort: "high",
              permissionMode: "ask",
            },
            "user-1",
          );

          // POST /sessions/:id/resume after a stop (an idle stop included).
          yield* engine.stop(session.id, "idle · stopped after 15 min · reply to resume");
          yield* engine.resumeSession(session.id, null);
          // A follow-up to the stopped session relaunches it.
          yield* engine.stop(session.id);
          yield* engine.launchFollowUp(session.id, "address the review", "follow-up-1", "user-2");
          // POST /sessions/:id/launch with no permission mode, as the Slack runner sends it.
          yield* engine.stop(session.id);
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", prompt: "and the other test" },
            "user-2",
          );

          expect(attached).toHaveLength(4);
          expect(permissionModes).toEqual(["ask", "ask", "ask", "ask"]);
          for (const { process } of attached) {
            expect(process.kind).toBe("agent-protocol");
            expect(process.protocolOptions).toEqual({
              model: "gpt-test",
              effort: "high",
              permissionMode: "ask",
            });
          }

          // A relaunch that names a mode is taken as given.
          yield* engine.stop(session.id);
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            null,
          );
          expect(permissionModes.at(-1)).toBe("bypass");
          expect(attached.at(-1)?.process.protocolOptions?.permissionMode).toBe("bypass");
          // ...and is what the next resume keeps.
          yield* engine.stop(session.id);
          yield* engine.resumeSession(session.id, null);
          expect(permissionModes.at(-1)).toBe("bypass");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(
          attached,
          submitted,
          authors,
          permissionModes,
        ),
      },
    );
  });

  it("resumes a claude ask session without the bypass flag", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    const permissionModes: Array<"bypass" | "ask"> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", prompt: "inspect replay", permissionMode: "ask" },
            "user-1",
          );
          yield* engine.stop(session.id);
          yield* engine.resumeSession(session.id, null);
          yield* engine.stop(session.id);
          yield* engine.launchFollowUp(session.id, "address the review", "follow-up-1", "user-2");

          expect(attached).toHaveLength(3);
          expect(permissionModes).toEqual(["ask", "ask", "ask"]);
          for (const { process } of attached) {
            expect(process.argv).not.toContain("bypassPermissions");
            expect(process.protocolOptions?.permissionMode).toBe("ask");
          }
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted, [], permissionModes),
      },
    );
  });

  it("resumes a bypass session as bypass", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    const permissionModes: Array<"bypass" | "ask"> = [];
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
            base: null,
          });
          // A first launch that names no mode runs on the default.
          yield* engine.launchProtocol(session.id, { mode: "protocol", prompt: "go" }, "user-1");
          yield* engine.stop(session.id);
          yield* engine.resumeSession(session.id, null);
          yield* engine.stop(session.id);
          yield* engine.launchFollowUp(session.id, "address the review", "follow-up-1", "user-2");

          expect(permissionModes).toEqual(["bypass", "bypass", "bypass"]);
          expect(attached.map(({ process }) => process.protocolOptions?.permissionMode)).toEqual([
            "bypass",
            "bypass",
            "bypass",
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted, [], permissionModes),
      },
    );
  });

  it("settles a stop with the summary it was given: the idle stop's words", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
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
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", prompt: "inspect replay", permissionMode: "bypass" },
            "user-1",
          );

          yield* engine.stop(session.id, "idle · stopped after 15 min · reply to resume");

          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("stopped");
          expect(settled?.summary).toBe("idle · stopped after 15 min · reply to resume");
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-protocol",
          );
          expect(agent?.status).toBe("stopped");
          expect(agent?.exitedAt).not.toBeNull();

          // Resume works as after any stop.
          yield* engine.resumeSession(session.id, null);
          expect(attached[1]?.process.kind).toBe("agent-protocol");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("resumes an idle protocol session in the workspace retained by its shell", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const openedOptions: SessionOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
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
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          const shell = yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("idle");

          const resumed = yield* engine.resumeSession(session.id, null);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          expect(world.processes.get(shell.id)?.exitedAt).toBeNull();
          expect(attached).toHaveLength(2);
          expect(attached[1]?.mode).toBe("pipe");
          expect(attached[1]?.process.kind).toBe("agent-protocol");
          expect(attached[1]?.process.sealantWorkspaceId).toBe(shell.sealantWorkspaceId);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          stopped,
          undefined,
          undefined,
          undefined,
          undefined,
          openedOptions,
        ),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("honors a fresh protocol resume while a shell retains the old workspace", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
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
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          const shell = yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("idle");

          const resumed = yield* engine.resumeSession(session.id, null, true);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          expect(stopped).toEqual(["workspace-1"]);
          expect(world.processes.get(shell.id)?.exitedAt).not.toBeNull();
          expect(attached).toHaveLength(2);
          expect(attached[1]?.process.kind).toBe("agent-protocol");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, stopped),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("restores harvested state into the fresh workspace a protocol resume provisions", async () => {
    // Live failure 2026-08-28 (PoC session 59e473f4): launchProtocol passed an explicit
    // null state to launchInternal, which skips the restore — while the composed argv
    // still resumed by provider id. On a fresh workspace claude then exited 1 with
    // "No conversation found with session ID". The restore must reach the new workspace.
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-protocol",
          );
          if (agent === undefined || agent.providerSessionId === null) {
            throw new Error("the protocol launch recorded no provider session id");
          }
          yield* engine.stop(session.id);
          // The settle-path harvest (forked) clears the manifest before its capture fails
          // against the empty exec output; wait for its pack attempt before planting state.
          const packRan = () =>
            execCalls.some((argv) => argv.join(" ").includes("mend-harness-state"));
          for (let i = 0; i < 400 && !packRan(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          expect(packRan()).toBe(true);
          const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
          fs.mkdirSync(stateDir, { recursive: true });
          fs.writeFileSync(
            path.join(stateDir, "manifest.json"),
            JSON.stringify({
              harness: "claude",
              providerSessionId: agent.providerSessionId,
              capturedAt: new Date().toISOString(),
            }),
          );
          fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "fake-archive");

          const resumed = yield* engine.resumeSession(session.id, null);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          // The saved state was staged into the worktree and unpacked in the NEW workspace
          // before the harness started.
          const restoreExec = execCalls.find((argv) =>
            argv.join(" ").includes(".mend-harness-state-"),
          );
          expect(restoreExec?.join(" ")).toContain("tar -xzf");
          // And the relaunch still resumes the native conversation.
          const resumeArgv = spawned.at(-1) ?? [];
          expect(resumeArgv).toContain("--resume");
          expect(resumeArgv).toContain(agent.providerSessionId);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          stopped,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
        ),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("falls back to a fresh protocol launch when the retained workspace disappears", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    let simulateDisappearance = false;
    let workspaceLookups = 0;
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
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("idle");
          simulateDisappearance = true;

          const resumed = yield* engine.resumeSession(session.id, null);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          expect(stopped).toEqual(["workspace-1"]);
          expect(attached).toHaveLength(2);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, stopped, undefined, () => {
          if (!simulateDisappearance) return false;
          workspaceLookups += 1;
          return workspaceLookups === 2;
        }),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("a caller that goes away mid-launch leaves the launch running: the agent starts and the session reads running", async () => {
    // Alpha 2026-09-30 (cc05cb8a, 48763b65): a client that gave up on the launch request
    // interrupted the launch wherever it stood — a running agent whose session read `starting`
    // with `started_at` null for good. The caller's interruption now ends only its own wait.
    const created: CreateOptions[] = [];
    const createAsked = await Effect.runPromise(Deferred.make<void>());
    const createAnswered = await Effect.runPromise(Deferred.make<void>());
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
            base: null,
          });
          const caller = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
          yield* Deferred.await(createAsked);
          yield* Fiber.interrupt(caller);
          expect(world.sessions.get(session.id)?.status).toBe("starting");

          yield* Deferred.succeed(createAnswered, undefined);
          yield* until(
            () => world.sessions.get(session.id)?.status === "running",
            "the launch the caller left to reach running",
          );
          const running = world.sessions.get(session.id);
          expect(running?.startedAt).not.toBeNull();
          expect(running?.sealantRunId).not.toBeNull();
          expect(
            [...world.processes.values()].some(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            ),
          ).toBe(true);
        }),
      {
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            beforeCreate: () =>
              Deferred.succeed(createAsked, undefined).pipe(
                Effect.andThen(Deferred.await(createAnswered)),
              ),
          },
        }),
      },
    );
  });

  it("a stop while the launch still sets up its machine: the agent never starts and the session reads stopped", async () => {
    // Alpha 2026-10-01 (3c4e991b): a stop during a launch found no agent to end, and the launch
    // went on and started one. Now the launch looks for the stop just before the agent starts.
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const createAsked = await Effect.runPromise(Deferred.make<void>());
    const createAnswered = await Effect.runPromise(Deferred.make<void>());
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
            base: null,
          });
          const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
          yield* Deferred.await(createAsked);

          yield* engine.stop(session.id);
          yield* Deferred.succeed(createAnswered, undefined);
          const launched = yield* Fiber.await(launching);

          expect(Exit.isFailure(launched)).toBe(true);
          expect(JSON.stringify(launched)).toContain("stopped while starting");
          expect(spawned).toEqual([]);
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
          expect(
            [...world.processes.values()].filter(
              (process) => process.sessionId === session.id && process.exitedAt === null,
            ),
          ).toEqual([]);
        }),
      {
        sealantLayer: lifecycleLayer(created, {
          spawned,
          captureOps: {
            beforeCreate: () =>
              Deferred.succeed(createAsked, undefined).pipe(
                Effect.andThen(Deferred.await(createAnswered)),
              ),
          },
        }),
      },
    );
  });

  it("a stop while the image builds reads stopped from then on, and the build failing after it keeps the stop's words", async () => {
    // RC 3 (2026-10-11): `mend stop` said ✓ stopped, and the session read `starting` for minutes
    // while its image build ran on; the build failing later would have rewritten it `failed`.
    const created: CreateOptions[] = [];
    const createAsked = await Effect.runPromise(Deferred.make<void>());
    const buildEnds = await Effect.runPromise(Deferred.make<void>());
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
            base: null,
          });
          const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
          yield* Deferred.await(createAsked);
          expect(engine.launchUnderWay(session.id)).toBe(true);

          yield* engine.stop(session.id);
          // The launch is still under way, standing down: it is not read as starting.
          expect(engine.launchUnderWay(session.id)).toBe(false);
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
          const stoppedWords = world.sessions.get(session.id)?.summary ?? null;

          yield* Deferred.succeed(buildEnds, undefined);
          yield* Fiber.await(launching);
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
          expect(world.sessions.get(session.id)?.summary ?? null).toBe(stoppedWords);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Deferred.succeed(createAsked, undefined).pipe(
              Effect.andThen(Deferred.await(buildEnds)),
              Effect.andThen(
                Effect.fail(
                  new SealantPlatformError({
                    code: "workspace_image_build_stalled",
                    status: null,
                    message: "The image build for workspace workspace-1 reported no progress.",
                    cause: null,
                  }),
                ),
              ),
            ),
        ),
      },
    );
  });

  it("a stop after the launch's last look, before the agent's row: the launch ends and so does the agent", async () => {
    // The alpha case itself: the stop landed while the platform was opening the agent, two
    // seconds before its process row. The launch's agent reopened the stopped session as
    // `running` and nothing ended it. The launch now stops the session again as it ends.
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const openAsked = await Effect.runPromise(Deferred.make<void>());
    const openAnswered = await Effect.runPromise(Deferred.make<void>());
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
            base: null,
          });
          const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
          yield* Deferred.await(openAsked);

          yield* engine.stop(session.id);
          yield* Deferred.succeed(openAnswered, undefined);
          yield* Fiber.await(launching);

          expect(spawned).toHaveLength(1);
          const agents = [...world.processes.values()].filter(
            (process) => process.sessionId === session.id && process.kind === "agent-pty",
          );
          expect(agents).toHaveLength(1);
          expect(agents[0]?.exitedAt).not.toBeNull();
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
        }),
      {
        sealantLayer: lifecycleLayer(created, {
          spawned,
          captureOps: {
            aroundOpen: () =>
              Deferred.succeed(openAsked, undefined).pipe(
                Effect.andThen(Deferred.await(openAnswered)),
              ),
          },
        }),
      },
    );
  });

  it("the same in capture mode: the stop drains the executor and the agent the launch started ends with it", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const openAsked = await Effect.runPromise(Deferred.make<void>());
    const openAnswered = await Effect.runPromise(Deferred.make<void>());
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
            base: null,
          });
          const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
          yield* Deferred.await(openAsked);

          yield* engine.stop(session.id);
          yield* Deferred.succeed(openAnswered, undefined);
          yield* Fiber.await(launching);
          yield* until(
            () => world.sessions.get(session.id)?.status === "stopped",
            "the stopped launch to settle stopped",
          );

          const agents = [...world.processes.values()].filter(
            (process) => process.sessionId === session.id && process.kind === "agent-pty",
          );
          expect(spawned).toHaveLength(1);
          expect(agents.every((agent) => agent.exitedAt !== null)).toBe(true);
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: lifecycleLayer(created, {
          spawned,
          captureOps: {
            aroundOpen: () =>
              Deferred.succeed(openAsked, undefined).pipe(
                Effect.andThen(Deferred.await(openAnswered)),
              ),
          },
        }),
      },
    );
  });

  it.each([
    [
      "opencode",
      ["env", 'OPENCODE_PERMISSION={"*":"allow"}', "opencode"],
      "OPENCODE_DISABLE_AUTOUPDATE=1",
    ],
    ["pi", ["pi", "--approve"], "PI_SKIP_VERSION_CHECK=1"],
  ] as const)(
    "launches %s in the unified image, past its permission default and behind its seed",
    async (harness, tail, seed) => {
      const created: CreateOptions[] = [];
      const spawned: ReadonlyArray<string>[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness,
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(session.id, [harness]);

            const argv = spawned.at(-1) ?? [];
            expect(argv.slice(-tail.length)).toEqual([...tail]);
            expect(argv.join(" ")).toContain(seed);
            // The shell's shape: the unified image, which bakes every agent CLI.
            expect(created.at(-1)?.harness.id).toBe("codex");
          }),
        { sealantLayer: lifecycleLayer(created, { spawned }) },
      );
    },
  );

  it("launches opencode co-located behind its plain seed, with no MCP link, and says when it could not read what was there", async () => {
    // Co-located: the session's own home keeps its MCP logins (no link, no removal). Its launch
    // snapshot reads that home; a database there that does not open leaves the snapshot unknown,
    // and the session line says the conversation may not be resumable, once the agent runs.
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "opencode",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          const db = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".local",
            "share",
            "opencode",
            "opencode.db",
          );
          fs.mkdirSync(path.dirname(db), { recursive: true });
          fs.writeFileSync(db, "not a database");
          yield* engine.launch(session.id, ["opencode"]);

          const argv = spawned.at(-1) ?? [];
          expect(argv.slice(0, 3)).toEqual(["sh", "-c", OPENCODE_SEED]);
          expect(argv.join(" ")).not.toContain("mcp-auth.json");
          expect(world.sessions.get(session.id)?.summary ?? "").toContain(
            "could not read its conversations before it started",
          );
        }),
      { sealantLayer: lifecycleLayer(created, { spawned }) },
    );
  });

  it("a cold launch says where it stands while the platform builds the image and boots the executor, and answers once it runs", async () => {
    // Alpha 2026-09-30: the first launch after an image recipe change waited ~8 min for the
    // MicroVM image build and the session line said nothing but `starting`.
    const created: CreateOptions[] = [];
    const answered = await Effect.runPromise(Deferred.make<void>());
    let executorUp = false;
    const executor: WorkspaceRuntimeInfo = {
      kind: "microvm",
      resourceId: "microvm-1",
      reference: "microvm-1",
      status: "pending",
      deadline: null,
    };
    const watchedCreates = Layer.effect(
      SealantClient,
      Effect.gen(function* () {
        const client = yield* SealantClient;
        return {
          ...client,
          // The create is accepted, then gets ready only once the test says: the watch runs
          // beside it with the handle, as `SealantClient.createWorkspace` runs it.
          createWorkspace: (options, launch, watch) =>
            client.createWorkspace(options, launch).pipe(
              Effect.tap((workspace) =>
                Effect.gen(function* () {
                  if (watch === undefined) return;
                  const watcher = yield* Effect.forkChild(
                    watch({ ...workspace, runtime: async () => (executorUp ? executor : null) }),
                  );
                  yield* Deferred.await(answered);
                  yield* Fiber.interrupt(watcher);
                }),
              ),
            ),
        };
      }),
    ).pipe(Layer.provide(lifecycleLayer(created)));
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
            base: null,
          });
          const launching = yield* engine
            .launch(session.id, ["codex"])
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* until(
            () => world.sessions.get(session.id)?.summary === LAUNCH_BOOTING,
            "booting, as the create is accepted",
          );
          // No executor on the platform past `imageBuildAfter`: the image is being built.
          yield* until(
            () => world.sessions.get(session.id)?.summary === LAUNCH_PREPARING,
            "the image build line",
          );
          expect(world.sessions.get(session.id)?.status).toBe("starting");
          executorUp = true;
          yield* until(
            () => world.sessions.get(session.id)?.summary === LAUNCH_BOOTING,
            "booting, once the executor exists",
          );
          yield* Deferred.succeed(answered, undefined);
          const launched = yield* Fiber.join(launching);
          expect(launched.status).toBe("running");
          expect(world.sessions.get(session.id)?.summary ?? null).toBe(
            "codex is starting on the new machine",
          );
        }),
      { sealantLayer: watchedCreates },
    );
  });

  it("a cold launch says Core's own launch phase: queued, building the image step by step, booting (sealant#342)", async () => {
    const created: CreateOptions[] = [];
    const answered = await Effect.runPromise(Deferred.make<void>());
    let phase: WorkspacePhase | null = { name: "queued" };
    let runtimeReads = 0;
    const watchedCreates = Layer.effect(
      SealantClient,
      Effect.gen(function* () {
        const client = yield* SealantClient;
        return {
          ...client,
          createWorkspace: (options, launch, watch) =>
            client.createWorkspace(options, launch).pipe(
              Effect.tap((workspace) =>
                Effect.gen(function* () {
                  if (watch === undefined) return;
                  const watcher = yield* Effect.forkChild(
                    watch({
                      ...workspace,
                      phase: async () => phase,
                      runtime: async () => {
                        runtimeReads++;
                        return null;
                      },
                    }),
                  );
                  yield* Deferred.await(answered);
                  yield* Fiber.interrupt(watcher);
                }),
              ),
            ),
        };
      }),
    ).pipe(Layer.provide(lifecycleLayer(created)));
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
            base: null,
          });
          const launching = yield* engine
            .launch(session.id, ["codex"])
            .pipe(Effect.forkChild({ startImmediately: true }));
          const summary = () => world.sessions.get(session.id)?.summary;
          yield* until(() => summary() === "queued · waiting for a worker", "queued");
          phase = {
            name: "image-build",
            imageBuild: { step: 3, steps: 12, progressAt: new Date(0).toISOString() },
          };
          yield* until(
            () => summary() === "building the workspace image · step 3/12",
            "the build's step",
          );
          phase = { name: "image-build", imageBuild: { progressAt: new Date(0).toISOString() } };
          yield* until(() => summary() === "building the workspace image", "a build with no step");
          phase = { name: "boot" };
          yield* until(() => summary() === LAUNCH_BOOTING, "booting");
          // Core said where the launch stands: the executor was never read to guess it.
          expect(runtimeReads).toBe(0);
          yield* Deferred.succeed(answered, undefined);
          const launched = yield* Fiber.join(launching);
          expect(launched.status).toBe("running");
        }),
      { sealantLayer: watchedCreates },
    );
  });

  it("launches Claude stream-json with one provider session id", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });

          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );

          const process = attached[0]?.process;
          const sessionFlag = process?.argv.indexOf("--session-id") ?? -1;
          expect(process?.kind).toBe("agent-protocol");
          expect(process?.argv).toContain("stream-json");
          expect(process?.providerSessionId).toBe(process?.argv.at(sessionFlag + 1));
          expect(attached[0]?.mode).toBe("pipe");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("records an exited protocol process and failed run when adapter initialization fails", async () => {
    const created: CreateOptions[] = [];
    const attached: SessionProcess[] = [];
    const failingHost = Layer.succeed(ProtocolHost, {
      rehydrate: () => Effect.die("not in test"),
      attach: (input) =>
        Effect.gen(function* () {
          attached.push(input.process);
          return yield* Effect.fail(
            new SealantPlatformError({
              code: "protocol-init-failed",
              status: null,
              message: "initialize failed",
              cause: null,
            }),
          );
        }),
      submitTurn: () => Effect.die("not in test"),
      interruptTurn: () => Effect.die("not in test"),
      respondRequest: () => Effect.die("not in test"),
      detach: () => Effect.void,
      has: () => Effect.succeed(false),
      quiescence: () => Effect.succeed(null),
      awaitQuiescent: () => Effect.void,
      endWork: () => Effect.void,
      detachForHandOver: () => Effect.void,
    });
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
            base: null,
          });

          const error = yield* engine
            .launchProtocol(session.id, { mode: "protocol", permissionMode: "ask" }, "user-1")
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(SealantPlatformError);
          expect(error).toMatchObject({ code: "protocol-init-failed" });
          expect(attached).toHaveLength(1);
          const attempted = attached[0];
          if (attempted === undefined) throw new Error("protocol adapter was not attached");
          expect(attempted.sessionId).toBe(session.id);
          expect(attempted.sealantRunId).not.toBeNull();
          const process = world.processes.get(attempted.id);
          expect(process).toMatchObject({
            id: attempted.id,
            sessionId: session.id,
            kind: "agent-protocol",
            sealantRunId: attempted.sealantRunId,
            sealantSessionId: attempted.sealantSessionId,
            status: "exited",
            exitedAt: expect.any(Date),
          });
          expect(world.sessions.get(session.id)?.status).toBe("failed");
          expect(
            [...world.sessionRuns.values()].find(
              (run) => run.sealantRunId === attempted.sealantRunId,
            ),
          ).toMatchObject({
            sessionId: session.id,
            status: "failed",
            settledAt: expect.any(Date),
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: failingHost,
      },
    );
  });

  it("keeps a legacy bench review-only", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: "bench",
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });

          const error = yield* engine.launch(session.id, ["bash"]).pipe(Effect.flip);
          expect(error).toBeInstanceOf(LegacyBenchReadOnlyError);
          expect(created).toEqual([]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("launches a shell session in the image's configured login shell", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });

          // The UI's shell harness always requests ["bash"] — the sentinel for
          // "an interactive shell" — but the PTY must run the image's shell so
          // the owner's dotfiles actually load. Flags ride along.
          yield* engine.launch(session.id, ["bash"]);
          expect(spawned.at(-1)).toEqual(["zsh"]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
        workspaceImage: {
          mode: "family",
          os: "arch",
          packages: [],
          shell: "zsh",
          services: { docker: false },
        },
      },
    );
  });

  it("runs `bash -c` as bash, its argv untouched, in a zsh image (RC 0.36.0-next.761)", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    // bash-only builtins: zsh answers "command not found" for both.
    const argv = ["bash", "-c", "echo $0; shopt -s extglob && shopt -q extglob && echo ok"];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "run",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });

          // Only the bare `["bash"]` sentinel is the login shell; a bash with arguments is the
          // person's own program.
          yield* engine.launch(session.id, argv);
          const ran = spawned.at(-1);
          expect(ran).toEqual(argv);
          const [program, ...args] = ran ?? [];
          expect(execFileSync(program ?? "", args, { encoding: "utf8" })).toBe("bash\nok\n");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
        workspaceImage: {
          mode: "family",
          os: "arch",
          packages: [],
          shell: "zsh",
          services: { docker: false },
        },
      },
    );
  });

  it("keeps the GitHub token when the harness account is unavailable", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });

          yield* engine.launch(session.id, ["codex"]);

          expect(created.map((options) => options.credentials)).toEqual([
            { codex: true, github: true },
            { codex: true },
            { github: true },
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, (credentials) => credentials?.codex === true),
      },
    );
  });

  it("gives a shell session the codex account when only codex is connected", async () => {
    // The shell ladder must degrade per provider: a create naming an
    // unconnected account fails whole, so a codex-only user used to fall all
    // the way to `undefined` and open a shell with no agent auth at all.
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });

          yield* engine.launch(session.id, ["bash", "-i"]);

          const attempts = created.map((options) => options.credentials);
          expect(attempts.at(-1)).toEqual({ codex: true });
          expect(attempts).toEqual([
            { claude: true, codex: true, github: true },
            { codex: true, github: true },
            { claude: true, github: true },
            { claude: true, codex: true },
            { codex: true },
          ]);
        }),
      {
        // Only codex is connected: any bundle naming claude or github is refused.
        sealantLayer: sealantLaunchLayer(
          created,
          (credentials) => credentials?.claude === true || credentials?.github === true,
        ),
      },
    );
  });

  it("delivers the exact follow-up in a workspace retained by a shell lease", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);

          // A live shell in the same workspace holds a lease (docs/SESSION-SERVICES.md).
          const shell = new SessionProcess({
            id: SessionProcessId.make("shell-1"),
            sessionId: session.id,
            sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
            sealantSessionId: "pty-2",
            sealantRunId: null,
            launchCorrelationId: null,
            serviceId: null,
            attemptOrdinal: null,
            kind: "shell",
            harness: null,
            providerSessionId: null,
            protocolOptions: null,
            label: "shell",
            argv: ["bash", "-i"],
            status: "running",
            exitCode: null,
            workspacePort: null,
            protocol: "tcp",
            hostPort: null,
            createdAt: now(),
            exitedAt: null,
            updatedAt: now(),
          });
          world.processes.set(shell.id, shell);

          yield* engine.stop(session.id);
          // The sweep is a forked fiber; wait for it to end the agent's record.
          const agentExited = () =>
            [...world.processes.values()].some(
              (process) => process.kind === "agent-pty" && process.exitedAt !== null,
            );
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          expect(agentExited()).toBe(true);
          expect(stopped).toEqual([]);
          const retained = [...world.processes.values()].filter(
            (process) => process.exitedAt === null,
          );
          expect(retained.map((process) => process.kind)).toEqual(["shell"]);

          const instruction =
            "  Address exactly the selected Review comments.\nKeep trailing bytes.  ";
          const resumed = yield* engine.launchFollowUp(
            session.id,
            instruction,
            "follow-up:delivery-1",
            "user-fixture",
          );
          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          const afterResume = [...world.processes.values()].filter(
            (process) => process.exitedAt === null,
          );
          expect(afterResume.map((process) => process.kind).toSorted()).toEqual([
            "agent-pty",
            "shell",
          ]);
          const deliveryProcess = afterResume.find(
            (process) => process.launchCorrelationId === "follow-up:delivery-1",
          );
          const transportArgv = deliveryProcess?.argv ?? [];
          expect(transportArgv.slice(0, 2)).toEqual(["sh", "-c"]);
          expect(transportArgv[2]).toContain(
            "exec codex -c features.shell_snapshot=false -c features.daemon_auto_start=false -c features.memories=true --dangerously-bypass-approvals-and-sandbox",
          );
          expect(Buffer.from(transportArgv.slice(4).join(""), "base64").toString("utf8")).toBe(
            instruction,
          );
          expect(deliveryProcess?.sealantRunId).not.toBeNull();
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("stops the workspace when no lease outlives the agent", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);

          yield* engine.stop(session.id);
          for (let i = 0; i < 200 && stopped.length === 0; i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          expect(stopped).toEqual(["workspace-1"]);
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          expect(live).toEqual([]);

          const settledBeforeRetry = world.sessions.get(session.id);
          // Someone else's follow-up never starts the terminal: only the owner types there
          // (docs/adr/0013).
          const teammate = yield* engine
            .launchFollowUp(session.id, "Carol's words.", "follow-up:teammate", "user-2")
            .pipe(Effect.flip);
          expect(teammate).toMatchObject({
            _tag: "SealantPlatformError",
            code: "terminal_owner_only",
          });
          const failure = yield* engine
            .launchFollowUp(
              session.id,
              "This launch cannot restore missing native state.",
              "follow-up:missing-state",
              "user-fixture",
            )
            .pipe(Effect.flip);
          expect(failure).toBeInstanceOf(HarnessStateNotFoundError);
          const settledAfterRetry = world.sessions.get(session.id);
          expect(settledAfterRetry?.status).toBe(settledBeforeRetry?.status);
          expect(settledAfterRetry?.settledAt).toEqual(settledBeforeRetry?.settledAt);
          expect(created).toHaveLength(1);
          expect(
            [...world.processes.values()].some(
              (process) => process.launchCorrelationId === "follow-up:missing-state",
            ),
          ).toBe(false);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("folds status over processes: a shell keeps the session idle after its agent stops", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const shell = yield* engine.openShell(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("running");

          // Stop ends the AGENT; the shell's lease keeps the worktree's workspace — and the
          // session reads idle, not settled: nothing here is a judgment about the work.
          yield* engine.stop(session.id);
          const afterStop = world.sessions.get(session.id);
          expect(afterStop?.status).toBe("idle");
          expect(afterStop?.settledAt).toBeNull();
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-pty",
          );
          expect(agent?.status).toBe("stopped");
          expect(agent?.harness).toBe("codex");
          const agentRunId = agent?.sealantRunId ?? null;
          expect(agentRunId === null ? null : world.sessionRuns.get(agentRunId)?.status).toBe(
            "stopped",
          );
          // Let the forked tail (harvest, fold) run; the workspace must survive it.
          yield* Effect.sleep(Duration.millis(100));
          expect(stopped).toEqual([]);

          // The last lease ends: the fold settles the session from the last agent outcome.
          yield* engine.stopShell(shell.id);
          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("stopped");
          expect(settled?.settledAt).not.toBeNull();
          expect(stopped).toEqual(["workspace-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("stop of a shell session closes its other shells too: its own shell is no agent to watch", async () => {
    // Box, next.786, 2026-10-11: a `mend shell` beside a shell session's own shell stayed
    // `running` after the session's Stop, and held it `idle` until its own stop.
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "shell",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(session.id, ["bash"]);
          const shell = yield* engine.openShell(session.id);
          // What the observer records for a `claude` typed into it: an agent Mend did not start.
          const sessionShell = [...world.processes.values()].find(
            (process) => process.kind === "agent-pty",
          );
          expect(sessionShell?.harness).toBe("shell");
          const observed = new SessionProcess({
            ...(sessionShell ?? shell),
            id: SessionProcessId.make("observed-claude"),
            kind: "agent-external",
            harness: "claude",
            label: "claude (observed)",
            sealantSessionId: null,
            sealantRunId: null,
            createdAt: now(),
            updatedAt: now(),
          });
          world.processes.set(observed.id, observed);

          yield* engine.stop(session.id);
          for (const id of [sessionShell?.id, shell.id, observed.id]) {
            const row = id === undefined ? undefined : world.processes.get(id);
            expect(row?.status, id).toBe("stopped");
            expect(row?.exitedAt, id).not.toBeNull();
          }
          const after = world.sessions.get(session.id);
          expect(after?.status).toBe("stopped");
          expect(after?.settledAt).not.toBeNull();
          yield* Effect.sleep(Duration.millis(100));
          expect(stopped).toEqual(["workspace-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("stop kills a session held open only by an orphan shell (the refuses-to-die case)", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.openShell(session.id);
          // The agent exits on its own (Ctrl+C out of codex): scaffold the
          // post-exit world directly — process ended, run settled, fold idle.
          for (const [id, process] of world.processes) {
            if (process.kind !== "agent-pty") continue;
            world.processes.set(
              id,
              new SessionProcess({
                ...process,
                status: "exited",
                exitCode: 0,
                exitedAt: now(),
                updatedAt: now(),
              }),
            );
            const runId = process.sealantRunId;
            const run = runId === null ? undefined : world.sessionRuns.get(runId);
            if (runId !== null && run !== undefined) {
              world.sessionRuns.set(
                runId,
                new SessionRun({
                  ...run,
                  status: "completed",
                  settledAt: now(),
                  updatedAt: now(),
                }),
              );
            }
          }
          const before = world.sessions.get(session.id);
          if (before !== undefined) {
            world.sessions.set(session.id, new Session({ ...before, status: "idle" }));
          }

          // A stop with NO live agent is aimed at the session itself: the
          // orphan shell closes and the session settles — a 200 that leaves
          // it idle is the refuses-to-die bug.
          yield* engine.stop(session.id);
          const after = world.sessions.get(session.id);
          expect(after?.status).toBe("stopped");
          expect(after?.settledAt).not.toBeNull();
          expect(
            [...world.processes.values()].filter((process) => process.exitedAt === null),
          ).toEqual([]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("folds an agent exit the watcher observes: idle while a shell holds on, completed after", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const ptyStates = new Map<string, InteractiveSessionStatus>();
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const shell = yield* engine.openShell(session.id);
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-pty",
          );
          if (agent === undefined || agent.sealantSessionId === null) {
            throw new Error("the launch recorded no agent PTY");
          }
          ptyStates.set(agent.sealantSessionId, {
            status: "exited",
            exitCode: 0,
            outputHighWater: 0n,
          });
          // The watcher records the end, then the tail harvests and snapshots; wait for the
          // snapshot — it is the last observable step before the fold.
          const snapshotted = () =>
            world.checkpoints.some((checkpoint) => checkpoint.trigger === "turn-boundary");
          for (let i = 0; i < 400 && !snapshotted(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          expect(world.processes.get(agent.id)?.exitedAt).not.toBeNull();
          expect(world.processes.get(agent.id)?.status).toBe("exited");
          expect(world.sessions.get(session.id)?.status).toBe("idle");
          expect(world.sessions.get(session.id)?.settledAt).toBeNull();
          expect(stopped).toEqual([]);
          // The end of an agent process is a turn boundary. Ordinal 0 is the
          // worktree-start snapshot (no session attached), then the session's own start.
          expect(world.checkpoints.map((checkpoint) => checkpoint.trigger)).toEqual([
            "session-start",
            "session-start",
            "turn-boundary",
          ]);
          expect(world.checkpoints[0]?.sessionId).toBeNull();

          yield* engine.stopShell(shell.id);
          expect(world.sessions.get(session.id)?.status).toBe("completed");
          expect(world.sessions.get(session.id)?.settledAt).not.toBeNull();
          expect(stopped).toEqual(["workspace-1"]);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          stopped,
          undefined,
          undefined,
          undefined,
          ptyStates,
        ),
      },
    );
  });

  it("a second agent process joins a session its shell keeps idle", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          yield* Effect.sleep(Duration.millis(100));
          expect(world.sessions.get(session.id)?.status).toBe("idle");

          // Resume as a shell: no saved state needed, and the retained workspace is reused.
          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          const agents = [...world.processes.values()]
            .filter((process) => process.kind === "agent-pty")
            .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          expect(agents.map((process) => [process.harness, process.status])).toEqual([
            ["codex", "stopped"],
            ["shell", "running"],
          ]);
          // The session keeps its identity; only the launch ran a shell.
          expect(world.sessions.get(session.id)?.harness).toBe("codex");
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("refuses a follow-up while any agent process is live", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.openShell(session.id);
          const failure = yield* engine
            .launchFollowUp(session.id, "Address the comments.", "follow-up:while-live", null)
            .pipe(Effect.flip);
          expect(failure).toBeInstanceOf(SealantPlatformError);
          expect(failure instanceof SealantPlatformError ? failure.code : null).toBe(
            "session_active",
          );
          expect(
            [...world.processes.values()].filter((process) => process.kind === "agent-pty"),
          ).toHaveLength(1);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("openShell records a live shell process in the session workspace", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);

          const first = yield* engine.openShell(session.id);
          const second = yield* engine.openShell(session.id);
          expect(first.kind).toBe("shell");
          expect(first.label).toBe("shell 1");
          expect(second.label).toBe("shell 2");
          expect(first.sealantWorkspaceId).toBe("workspace-1");

          const renamed = yield* engine.renameShell(first.id, "tests");
          expect(renamed.label).toBe("tests");
          const duplicate = yield* engine.renameShell(second.id, "tests").pipe(Effect.flip);
          expect(duplicate.message).toContain("already exists");

          const stopped = yield* engine.stopShell(first.id);
          expect(stopped.status).toBe("stopped");
          const stoppedAgain = yield* engine.stopShell(first.id);
          expect(stoppedAgain.status).toBe("stopped");
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          expect(live.map((process) => process.kind).toSorted()).toEqual(["agent-pty", "shell"]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("openShell refuses a session that has no workspace", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });

        const outcome = yield* engine.openShell(session.id).pipe(Effect.flip);
        expect(outcome).toBeInstanceOf(SessionNotLiveError);
      }),
    );
  });

  it("records the exact platform expiry when a new agent lease renews its workspace", async () => {
    const created: CreateOptions[] = [];
    const renewals: Array<{ readonly workspaceId: string; readonly ttlSeconds: number }> = [];
    const exactExpiry = new Date("2031-02-03T04:05:06.000Z");
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
            base: null,
          });

          const launched = yield* engine.launch(session.id, ["codex"]);

          expect(renewals).toEqual([{ workspaceId: "workspace-1", ttlSeconds: 43_200 }]);
          expect(launched.workspaceExpiresAt).toEqual(exactExpiry);
          expect(launched.workspaceTtlRenewedAt).not.toBeNull();
          expect(launched.workspaceTtlRenewalFailedAt).toBeNull();
          expect(launched.workspaceTtlRenewalError).toBeNull();
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          (workspaceId, ttlSeconds) =>
            Effect.sync(() => {
              renewals.push({ workspaceId, ttlSeconds });
              return exactExpiry;
            }),
        ),
      },
    );
  });

  it("preserves known expiry on renewal failure and clears the failure after recovery", async () => {
    const created: CreateOptions[] = [];
    const firstExpiry = new Date("2031-02-03T04:05:06.000Z");
    const recoveredExpiry = new Date("2031-02-03T16:05:06.000Z");
    let renewalAttempt = 0;
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const afterSuccess = world.sessions.get(session.id);
          const firstRenewedAt = afterSuccess?.workspaceTtlRenewedAt ?? null;
          expect(afterSuccess?.workspaceExpiresAt).toEqual(firstExpiry);

          yield* engine.openShell(session.id);
          const afterFailure = world.sessions.get(session.id);
          expect(afterFailure?.workspaceExpiresAt).toEqual(firstExpiry);
          expect(afterFailure?.workspaceTtlRenewedAt).toEqual(firstRenewedAt);
          expect(afterFailure?.workspaceTtlRenewalFailedAt).not.toBeNull();
          expect(afterFailure?.workspaceTtlRenewalError).toBe("renewal unavailable");

          yield* engine.openShell(session.id);
          const afterRecovery = world.sessions.get(session.id);
          expect(afterRecovery?.workspaceExpiresAt).toEqual(recoveredExpiry);
          expect(afterRecovery?.workspaceTtlRenewalFailedAt).toBeNull();
          expect(afterRecovery?.workspaceTtlRenewalError).toBeNull();
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          () => {
            renewalAttempt += 1;
            if (renewalAttempt === 2) {
              return Effect.fail(
                new SealantPlatformError({
                  code: "workspace_expiry_failed",
                  status: 503,
                  message: "renewal unavailable",
                  cause: null,
                }),
              );
            }
            return Effect.succeed(renewalAttempt === 1 ? firstExpiry : recoveredExpiry);
          },
        ),
      },
    );
  });

  it("renews a retained shell workspace during boot recovery", async () => {
    const created: CreateOptions[] = [];
    const renewals: string[] = [];
    const sessionId = SessionId.make("session-retained-at-boot");
    const workspaceId = SealantWorkspaceId.make("workspace-1");
    const exactExpiry = new Date("2032-01-01T00:00:00.000Z");
    await withEngine(
      (world) =>
        Effect.gen(function* () {
          yield* Effect.suspend(() => {
            const session = world.sessions.get(sessionId);
            return session?.workspaceExpiresAt?.getTime() === exactExpiry.getTime()
              ? Effect.void
              : Effect.fail(new Error("retained workspace has not renewed yet"));
          }).pipe(Effect.retry({ times: 20, schedule: Schedule.spaced(Duration.millis(10)) }));
          expect(renewals).toContain(workspaceId);
          const renewed = world.sessions.get(sessionId);
          expect(renewed?.workspaceTtlRenewedAt).not.toBeNull();
          expect(renewed?.workspaceTtlRenewalError).toBeNull();
        }),
      {
        prepareWorld: (world) => {
          const timestamp = now();
          world.sessions.set(
            sessionId,
            new Session({
              id: sessionId,
              projectId: ProjectId.make("project-retained-at-boot"),
              worktreeId: WorktreeId.make("wt-retained-at-boot"),
              harness: "codex",
              providerSessionId: null,
              label: null,
              worktree: "session-retained-at-boot",
              branch: "mend/session-retained-at-boot",
              baseSha: Sha.make("base-sha"),
              baseRef: "main",
              contextSnapshotId: null,
              referenceMounts: [],
              extraMounts: [],
              sealantRunId: null,
              sealantWorkspaceId: workspaceId,
              sealantSessionId: null,
              workspaceExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
              workspaceTtlRenewedAt: new Date("2029-12-31T12:00:00.000Z"),
              workspaceTtlRenewalFailedAt: null,
              workspaceTtlRenewalError: null,
              workspaceImage: null,
              dotfiles: null,
              ownerUserId: "user-fixture",
              hasTranscript: null,
              status: "completed",
              summary: null,
              lastSeenSequence: 0n,
              recordHistoryComplete: true,
              startedAt: timestamp,
              settledAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          );
          world.processes.set(
            "shell-retained-at-boot",
            new SessionProcess({
              id: SessionProcessId.make("shell-retained-at-boot"),
              sessionId,
              sealantWorkspaceId: workspaceId,
              sealantSessionId: "pty-1",
              sealantRunId: SealantRunId.make("run-shell-retained-at-boot"),
              launchCorrelationId: null,
              serviceId: null,
              attemptOrdinal: null,
              kind: "shell",
              harness: null,
              providerSessionId: null,
              protocolOptions: null,
              label: "shell 1",
              argv: ["sh"],
              status: "running",
              exitCode: null,
              workspacePort: null,
              protocol: "tcp",
              hostPort: null,
              createdAt: timestamp,
              exitedAt: null,
              updatedAt: timestamp,
            }),
          );
        },
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          (candidateWorkspaceId) =>
            Effect.sync(() => {
              renewals.push(candidateWorkspaceId);
              return exactExpiry;
            }),
        ),
      },
    );
  });

  it("addService adopts a port; its lease outlives the agent until stopService", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);

          const service = yield* engine.addService(session.id, 5432, "db");
          expect(service.service.name).toBe("db");
          expect(service.service.workspacePort).toBe(5432);
          expect(service.attempts).toHaveLength(0);
          expect(service.currentForward?.hostPort).toBe(43127);
          expect(service.latestObservation?.state).toBe("reachable");
          const adoptedRestart = yield* engine.restartService(service.service.id).pipe(Effect.flip);
          expect(adoptedRestart.message).toContain("no recorded command");

          // A live name is taken — a second "db" is refused, not duplicated.
          const duplicate = yield* engine.addService(session.id, 5433, "db").pipe(Effect.flip);
          expect(String(duplicate.message)).toContain('named "db" already exists');

          // The agent settles; the Service lease keeps the workspace up.
          yield* engine.stop(session.id);
          const agentExited = () =>
            [...world.processes.values()].some(
              (process) => process.kind === "agent-pty" && process.exitedAt !== null,
            );
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          expect(agentExited()).toBe(true);
          expect(stopped).toEqual([]);

          // A completed coding-agent run may open another supporting process
          // while the Service retains the reachable workspace.
          const shell = yield* engine.openShell(session.id);
          expect(shell.label).toBe("shell 1");

          const ended = yield* engine.stopService(service.service.id);
          expect(ended.service.currentAttemptId).toBeNull();
          expect(ended.service.currentForwardId).toBeNull();
          expect(stopped).toEqual([]);
          yield* engine.stopShell(shell.id);
          expect(stopped).toEqual(["workspace-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("stopServices stops every live Service a stopped agent left behind, then the workspace", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const web = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          const db = yield* engine.addService(session.id, 5432, "db");
          const ended = yield* engine.runService(session.id, ["pnpm", "worker"], 4000, "worker");
          yield* engine.stopService(ended.service.id);

          yield* engine.stop(session.id);
          const agentExited = () =>
            [...world.processes.values()].some(
              (process) => process.kind === "agent-pty" && process.exitedAt !== null,
            );
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          // The stop ended the agent; two Services still hold the workspace.
          expect(stopped).toEqual([]);

          expect(yield* engine.stopServices(session.id)).toBe(2);
          expect(world.services.get(web.service.id)?.currentAttemptId).toBeNull();
          expect(world.services.get(db.service.id)?.currentForwardId).toBeNull();
          expect(stopped).toEqual(["workspace-1"]);
          expect(world.sessions.get(session.id)?.status).toBe("stopped");
          // Nothing left: a second press stops nothing and says so.
          expect(yield* engine.stopServices(session.id)).toBe(0);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("reuses a workspace retained only by an adopted Service; fresh resume closes it", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const view = yield* engine.addService(session.id, 5432, "db");
          yield* engine.stop(session.id);

          const agentsSettled = () =>
            [...world.processes.values()]
              .filter((process) => process.kind === "agent-pty")
              .every((process) => process.exitedAt !== null);
          for (let i = 0; i < 200 && !agentsSettled(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          yield* engine.resumeSession(session.id, "shell");
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          expect(world.services.get(view.service.id)?.currentForwardId).not.toBeNull();

          yield* engine.stop(session.id);
          for (let i = 0; i < 200 && !agentsSettled(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          yield* engine.resumeSession(session.id, "shell", true);
          expect(created).toHaveLength(2);
          expect(stopped).toEqual(["workspace-1"]);
          expect(world.services.get(view.service.id)?.currentForwardId).toBeNull();
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("runService restart appends attempts and preserves prior run pointers", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);

          const service = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          expect(service.service.name).toBe("web");
          expect(service.attempts).toHaveLength(1);
          expect(service.attempts[0]?.sealantSessionId).not.toBeNull();
          expect(service.attempts[0]?.argv).toEqual(["pnpm", "dev"]);
          expect(service.attempts[0]?.status).toBe("running");
          expect(service.currentForward?.hostPort).toBe(43127);
          expect(service.latestObservation?.state).toBe("reachable");

          const firstAttemptId = service.attempts[0]?.id;
          const firstRunId = service.attempts[0]?.sealantRunId;
          const forwardId = service.currentForward?.id;
          const restarted = yield* engine.restartService(service.service.id);
          expect(restarted.service.id).toBe(service.service.id);
          expect(restarted.attempts).toHaveLength(2);
          expect(restarted.attempts[0]?.id).toBe(firstAttemptId);
          expect(restarted.attempts[0]?.sealantRunId).toBe(firstRunId);
          expect(restarted.attempts[0]?.status).toBe("stopped");
          expect(restarted.attempts[1]?.id).not.toBe(firstAttemptId);
          expect(restarted.attempts[1]?.sealantRunId).not.toBe(firstRunId);
          expect(restarted.attempts[1]?.status).toBe("running");
          expect(restarted.currentForward?.id).toBe(forwardId);

          const stopped = yield* engine.stopService(service.service.id);
          expect(stopped.service.currentAttemptId).toBeNull();
          expect(stopped.service.currentForwardId).toBeNull();
          expect(stopped.attempts.at(-1)?.status).toBe("stopped");

          const rerun = yield* engine.runService(
            session.id,
            stopped.attempts.at(-1)?.argv ?? [],
            stopped.service.workspacePort,
            stopped.service.name,
            stopped.service.transport,
          );
          expect(rerun.service.id).toBe(service.service.id);
          expect(rerun.attempts).toHaveLength(3);
          expect(rerun.service.currentAttemptId).toBe(rerun.attempts.at(-1)?.id);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("stamps a start's id on the attempt it began, and refuses the id a second time", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const startId = "5b3f0c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f";

          const service = yield* engine.runService(
            session.id,
            ["pnpm", "dev"],
            3000,
            "web",
            "tcp",
            null,
            undefined,
            startId,
          );
          expect(service.attempts.at(-1)?.launchCorrelationId).toBe(
            serviceStartCorrelation(service.service.id, startId),
          );
          yield* engine.stopService(service.service.id);

          const again = yield* engine
            .runService(session.id, ["pnpm", "dev"], 3000, "web", "tcp", null, undefined, startId)
            .pipe(Effect.flip);
          expect(again._tag).toBe("ServiceStartError");
          expect(again.message).toContain(
            "This start id was used by an earlier start of this Service",
          );

          // Another Service of the session takes the same id: the key is the Service and the id.
          const api = yield* engine.runService(
            session.id,
            ["pnpm", "api"],
            4000,
            "api",
            "tcp",
            null,
            undefined,
            startId,
          );
          expect(api.attempts.at(-1)?.launchCorrelationId).toBe(
            serviceStartCorrelation(api.service.id, startId),
          );

          // A start that names no id carries none: an older client's starts are as before.
          const unnamed = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          expect(unnamed.attempts.at(-1)?.launchCorrelationId).toBeNull();
          expect(unnamed.attempts).toHaveLength(2);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  // Review 2 of mend#651: an id another person used on their own private work, in the same
  // organization or another, neither refuses this person's start nor says it was used.
  it.each([
    { who: "carol", organization: "org-test" },
    { who: "bob", organization: "org-bob" },
  ])(
    "a start id another person used on hidden work is invisible to $who's own start ($organization)",
    async ({ who, organization }) => {
      const created: CreateOptions[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const fixture = yield* setup(tmp, world);
            const alicesProject = new Project({
              ...fixture,
              visibility: "private",
              createdByUserId: "user-fixture",
            });
            world.projects.set(alicesProject.id, alicesProject);
            const sibling = yield* setupSibling(tmp, world, who, fixture.originUrl ?? "");
            const theirProject = new Project({
              ...sibling,
              organizationId: OrganizationId.make(organization),
              visibility: "private",
              createdByUserId: `user-${who}`,
            });
            world.projects.set(theirProject.id, theirProject);
            const engine = yield* SessionEngine;
            const startId = "5b3f0c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f";

            const alice = yield* engine.provision({
              projectId: alicesProject.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(alice.id, ["codex"]);
            const hers = yield* engine.runService(
              alice.id,
              ["pnpm", "dev"],
              3000,
              "web",
              "tcp",
              null,
              "user-fixture",
              startId,
            );
            yield* engine.stopService(hers.service.id);

            const theirs = yield* engine.provision({
              projectId: theirProject.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: `user-${who}`,
              base: null,
            });
            yield* engine.launch(theirs.id, ["codex"]);
            // The same name too: nothing of Alice's Service decides theirs.
            const started = yield* engine.runService(
              theirs.id,
              ["pnpm", "dev"],
              3001,
              "web",
              "tcp",
              null,
              `user-${who}`,
              startId,
            );
            expect(started.service.sessionId).toBe(theirs.id);
            expect(started.attempts).toHaveLength(1);
            expect(started.attempts[0]?.status).toBe("running");
            expect(started.attempts[0]?.launchCorrelationId).toBe(
              serviceStartCorrelation(started.service.id, startId),
            );
            expect(started.attempts[0]?.launchCorrelationId).not.toBe(
              hers.attempts[0]?.launchCorrelationId,
            );
          }),
        { sealantLayer: sealantLaunchLayer(created) },
      );
    },
  );

  it("stamps a recipe start's id on its attempt", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const worktree = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
          fs.writeFileSync(
            path.join(worktree, "mend.toml"),
            '[service.web]\ncommand = "pnpm dev"\nport = 3000\n',
          );
          const startId = "0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a0b";
          const service = yield* engine.runServiceRecipe(session.id, "web", undefined, startId);
          expect(service.attempts.at(-1)?.launchCorrelationId).toBe(
            serviceStartCorrelation(service.service.id, startId),
          );
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("stamps server-resolved file recipe provenance", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const worktree = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
          fs.writeFileSync(
            path.join(worktree, "mend.toml"),
            '[service.web]\ncommand = "pnpm dev"\nport = 3000\n',
          );

          const service = yield* engine.runServiceRecipe(session.id, "web");
          expect(service.service.name).toBe("web");
          expect(service.service.declarationSource).toBe("recipe-file");
          expect(service.attempts[0]?.argv).toEqual(["sh", "-c", "pnpm dev"]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("keeps a Service live across a transient watcher lookup failure", async () => {
    const created: CreateOptions[] = [];
    let workspaceLookups = 0;
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const service = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          yield* Effect.sleep(Duration.millis(1_200));

          const attempt = world.processes.get(service.service.currentAttemptId ?? "");
          expect(attempt?.exitedAt).toBeNull();
          expect(world.services.get(service.service.id)?.currentForwardId).not.toBeNull();
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, undefined, () => {
          workspaceLookups += 1;
          return workspaceLookups === 2;
        }),
      },
    );
  });

  it("does not append a restart attempt when the workspace lookup fails", async () => {
    const created: CreateOptions[] = [];
    let rejectWorkspaceLookup = false;
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const before = yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          rejectWorkspaceLookup = true;
          const failure = yield* engine.restartService(before.service.id).pipe(Effect.flip);
          expect(failure).toBeInstanceOf(SealantPlatformError);
          const attempts = [...world.processes.values()].filter(
            (process) => process.serviceId === before.service.id,
          );
          expect(attempts).toHaveLength(1);
          expect(world.services.get(before.service.id)?.currentAttemptId).toBe(attempts[0]?.id);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          () => rejectWorkspaceLookup,
        ),
      },
    );
  });

  it("resumes a provisioned-but-never-launched session as a workbench shell", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          // The editor's workbench flow: create only — no launch — then shell-resume.
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          expect(session.status).toBe("starting");

          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          // The default image's login shell (zsh), not the `bash` request sentinel.
          expect(live.map((process) => process.argv)).toEqual([["zsh"]]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("resumes a settled session with shell — no saved state required", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.stop(session.id);
          const agentExited = () =>
            [...world.processes.values()].every((process) => process.exitedAt !== null);
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          // The session keeps its harness identity — only this launch is a shell.
          expect(resumed.harness).toBe("codex");
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          // The default image's login shell (zsh), not the `bash` request sentinel.
          expect(live.map((process) => process.argv)).toEqual([["zsh"]]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("passes the project env store to createWorkspace ONCE and stamps only names on the run", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);

          // Configuration rides `env`, secrets are unsealed into `secretEnv` — exactly once. The
          // project's own PAGER wins over Mend's.
          expect(created).toHaveLength(1);
          expect(created[0]?.env).toEqual({
            ...HARNESS_UPDATES_OFF_ENV,
            APP_MODE: "review",
            PAGER: "less -R",
            PORT: "3000",
          });
          expect(created[0]?.secretEnv).toEqual({
            DATABASE_URL: "postgres://u:hunter2@h/db",
            STRIPE_API_KEY: "sk_live_x",
          });
          // The run's manifest carries revisions + NAMES; no value or sealed value anywhere.
          const [run] = [...world.sessionRuns.values()];
          expect(run?.environmentRevision).toBe(4);
          expect(run?.environmentVariableNames).toEqual(["APP_MODE", "PAGER", "PORT"]);
          expect(run?.secretRevision).toBe(2);
          expect(run?.secretNames).toEqual(["DATABASE_URL", "STRIPE_API_KEY"]);
          expect(JSON.stringify([...world.sessionRuns.values()], bigintSafe)).not.toContain(
            "hunter2",
          );
          expect(JSON.stringify([...world.sessions.values()], bigintSafe)).not.toContain("hunter2");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        environment: () => ({
          revision: 4,
          variables: { PORT: "3000", APP_MODE: "review", PAGER: "less -R" },
        }),
        secrets: () => ({
          revision: 2,
          secrets: { STRIPE_API_KEY: "sk_live_x", DATABASE_URL: "postgres://u:hunter2@h/db" },
        }),
      },
    );
  });

  it("passes cluster bindings + service account to createWorkspace and stamps NAMES on the run", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);

          // Bindings ride `envFrom`, the trust grant rides `kubernetes` — exactly once, no
          // Mend-side capability pre-check (the platform's create-time refusal is the check).
          expect(created).toHaveLength(1);
          expect(created[0]?.envFrom).toEqual([
            { kind: "configmap", name: "app-config" },
            { kind: "secret", name: "app-env" },
          ]);
          expect(created[0]?.kubernetes).toEqual({ serviceAccountName: "mend-agent" });
          // The run's manifest carries the revision + `kind/objectName` strings + the SA name.
          const [run] = [...world.sessionRuns.values()];
          expect(run?.clusterBindingRevision).toBe(5);
          expect(run?.clusterBindingNames).toEqual(["configmap/app-config", "secret/app-env"]);
          expect(run?.clusterServiceAccount).toBe("mend-agent");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        clusterBindings: () => ({
          revision: 5,
          bindings: [
            { kind: "configmap", objectName: "app-config" },
            { kind: "secret", objectName: "app-env" },
          ],
          serviceAccount: "mend-agent",
        }),
      },
    );
  });

  it("restates the platform's cluster-reference refusal naming every binding", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          const failure = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(failure).toBeInstanceOf(SealantPlatformError);
          const platformFailure = failure instanceof SealantPlatformError ? failure : null;
          // The typed code survives the restatement — it IS the SDK capability probe.
          expect(platformFailure?.code).toBe("runtime-env-references-unsupported");
          expect(platformFailure?.message).toContain("secret/app-env");
          expect(platformFailure?.message).toContain("service account mend-agent");
          expect(platformFailure?.message).toContain("remove them in project setup");
          // No retry loop: the refusal is synchronous and deterministic.
          expect(created).toHaveLength(1);
          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("failed");
          expect(settled?.summary).toContain("launch refused");
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          () => false,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Effect.fail(
              new SealantPlatformError({
                code: "runtime-env-references-unsupported",
                status: 422,
                message: "the workspace runtime does not support environment references",
                cause: null,
              }),
            ),
        ),
        clusterBindings: () => ({
          revision: 3,
          bindings: [{ kind: "secret", objectName: "app-env" }],
          serviceAccount: "mend-agent",
        }),
      },
    );
  });

  it("passes only the harnesses' update switches and no pager as env when the project store is empty", async () => {
    const created: CreateOptions[] = [];
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          // The harnesses' self-updaters are off in every workspace, whatever the project sets, and
          // nothing pages: the images carry no `less`.
          expect(created[0]?.env).toEqual({ ...HARNESS_UPDATES_OFF_ENV, PAGER: "cat" });
          expect(created[0]?.secretEnv).toBeUndefined();
          expect(created[0]?.envFrom).toBeUndefined();
          expect(created[0]?.kubernetes).toBeUndefined();
          const [run] = [...world.sessionRuns.values()];
          // An empty store is still a REAL manifest (revision 0, no names) — not legacy/unknown.
          expect(run?.environmentRevision).toBe(0);
          expect(run?.environmentVariableNames).toEqual([]);
          expect(run?.secretRevision).toBe(0);
          expect(run?.secretNames).toEqual([]);
          expect(run?.clusterBindingRevision).toBe(0);
          expect(run?.clusterBindingNames).toEqual([]);
          expect(run?.clusterServiceAccount).toBeNull();
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it.effect("a live edit never touches the running workspace; resume reads the current store", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const store: { revision: number; variables: Record<string, string> } = {
        revision: 1,
        variables: { APP_MODE: "review" },
      };
      const secrets: { revision: number; secrets: Record<string, string> } = {
        revision: 1,
        secrets: { API_KEY: "old" },
      };
      const ended = yield* Deferred.make<void>();
      const hooks: Layer.Layer<WorkspaceGitHooks> = Layer.effect(
        WorkspaceGitHooks,
        Effect.map(WorkspaceGitHooks, (inner) => ({
          ...inner,
          agentEnded: (event) =>
            inner.agentEnded(event).pipe(Effect.andThen(Deferred.succeed(ended, undefined))),
        })),
      ).pipe(Layer.provide(WorkspaceGitHooksLive));
      yield* withEngineEffect(
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
              base: null,
            });
            yield* engine.launch(session.id, ["codex"]);
            expect(created).toHaveLength(1);
            expect(created[0]?.env).toEqual({
              ...HARNESS_UPDATES_OFF_ENV,
              ...NO_PAGER_ENV,
              APP_MODE: "review",
            });
            expect(created[0]?.secretEnv).toEqual({ API_KEY: "old" });

            // Edit while live: a shell in the running workspace triggers no create and no re-read.
            store.revision = 2;
            store.variables = { APP_MODE: "prod", NEW_VAR: "1" };
            secrets.revision = 2;
            secrets.secrets = { API_KEY: "new" };
            yield* engine.openShell(session.id);
            expect(created).toHaveLength(1);

            // Settle, then resume: a FRESH workspace with the CURRENT store, distinct manifest.
            yield* engine.stop(session.id);
            // Stop ends the agent, while the shell opened above intentionally remains live.
            // Waiting for every process used to exhaust a two-second poll on every run.
            yield* Deferred.await(ended);
            expect(
              [...world.processes.values()]
                .filter((process) => process.kind === "agent-pty")
                .every((process) => process.exitedAt !== null),
            ).toBe(true);
            yield* engine.resumeSession(session.id, "shell", true);
            expect(created).toHaveLength(2);
            expect(created[1]?.env).toEqual({
              ...HARNESS_UPDATES_OFF_ENV,
              ...NO_PAGER_ENV,
              APP_MODE: "prod",
              NEW_VAR: "1",
            });
            expect(created[1]?.secretEnv).toEqual({ API_KEY: "new" });
            // The fake PTY reuses one run id, so the world holds the LATEST run only — enough to
            // prove the resumed launch stamped the current store's manifest, not the original.
            const latest = [...world.sessionRuns.values()].at(-1);
            expect(latest?.environmentRevision).toBe(2);
            expect(latest?.environmentVariableNames).toEqual(["APP_MODE", "NEW_VAR"]);
            expect(latest?.secretRevision).toBe(2);
            expect(latest?.secretNames).toEqual(["API_KEY"]);
          }),
        {
          sealantLayer: sealantLaunchLayer(created),
          gitHooksLayer: hooks,
          environment: () => store,
          secrets: () => secrets,
        },
      );
    }),
  );

  it("attachRun records the explicit legacy/unknown manifest — never an inferred one", async () => {
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "codex",
            label: null,
            base: null,
          });
          const runId = SealantRunId.make("sealant-run-attached");
          yield* engine.attachRun(session.id, runId, SealantWorkspaceId.make("workspace-x"));
          const run = world.sessionRuns.get(runId);
          expect(run?.environmentRevision).toBeNull();
          expect(run?.environmentVariableNames).toBeNull();
          expect(run?.secretRevision).toBeNull();
          expect(run?.secretNames).toBeNull();
          expect(run?.clusterBindingRevision).toBeNull();
          expect(run?.clusterBindingNames).toBeNull();
          expect(run?.clusterServiceAccount).toBeNull();
        }),
      // The store is NOT empty here — attach must still not read it.
      {
        environment: () => ({ revision: 9, variables: { SHOULD_NOT_BE_READ: "x" } }),
        secrets: () => ({ revision: 9, secrets: { SHOULD_NOT_BE_READ_EITHER: "y" } }),
        clusterBindings: () => ({
          revision: 9,
          bindings: [{ kind: "secret", objectName: "should-not-be-read" }],
          serviceAccount: "should-not-be-read",
        }),
      },
    );
  });

  it("provisions: worktree, session row, checkpoint 0, change row", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;

        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: "fix the answer",
          base: null,
        });

        expect(session.branch).toBe(`mend/wt/${session.worktreeId}`);
        expect(session.worktree).toBe(`wt-${session.worktreeId}`);
        expect(session.baseRef).toBe("main");
        expect(session.status).toBe("starting");
        expect(session.recordHistoryComplete).toBe(true);
        const worktreeRow = world.worktrees.get(session.worktreeId);
        expect(worktreeRow?.directory).toBe(session.worktree);
        const worktree = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
        expect(fs.existsSync(path.join(worktree, "app.ts"))).toBe(true);

        // Ordinal 0 belongs to the place (no session); the conversation adds its own start.
        const chain = world.checkpoints.filter((c) => c.worktreeId === session.worktreeId);
        expect(chain.map((c) => [c.ordinal, c.trigger, c.sessionId])).toEqual([
          [0, "session-start", null],
          [1, "session-start", session.id],
        ]);
        expect(chain[0]?.sealantRunId).toBeNull();
        expect(chain[0]?.seq).toBe(0n);

        const change = world.changes.get(session.worktreeId);
        expect(change?.baseSha).toBe(session.baseSha);
        expect(change?.worktreeId).toBe(session.worktreeId);
      }),
    );
  });

  it("joins an existing worktree by name: one worktree, one change, two conversations", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;

        const first = yield* engine.provision({
          name: "fix-auth",
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });
        expect(first.branch).toBe("mend/fix-auth");
        expect(first.worktree).toBe("fix-auth");

        const second = yield* engine.provision({
          name: "fix-auth",
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "claude",
          label: "second opinion",
          base: null,
        });
        expect(second.id).not.toBe(first.id);
        expect(second.worktreeId).toBe(first.worktreeId);
        expect(second.worktree).toBe(first.worktree);
        expect(world.worktrees.size).toBe(1);
        // One change per worktree — both conversations contribute to it.
        expect(world.changes.size).toBe(1);
        expect(world.changes.get(first.worktreeId)).toBeDefined();
        // The chain interleaves: worktree-start, then each session's start.
        const chain = world.checkpoints.filter((c) => c.worktreeId === first.worktreeId);
        expect(chain.map((c) => [c.ordinal, c.sessionId])).toEqual([
          [0, null],
          [1, first.id],
          [2, second.id],
        ]);

        // A conflicting base refuses loudly — never a silent re-base.
        const conflict = yield* engine
          .provision({
            name: "fix-auth",
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "codex",
            label: null,
            base: "some-other-branch",
          })
          .pipe(Effect.result);
        expect(conflict._tag).toBe("Failure");
        if (conflict._tag === "Failure") {
          expect(conflict.failure._tag).toBe("WorktreeBaseConflictError");
        }
      }),
    );
  });

  it("provisionSessionIn opens a conversation inside a worktree by id", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const worktree = yield* engine.ensureWorktree(
          project.id,
          { name: "durable-place", base: null },
          null,
        );
        // A worktree with zero sessions is a legal durable place.
        expect(worktree.name).toBe("durable-place");
        expect(world.sessions.size).toBe(0);
        expect(world.changes.get(worktree.id)).toBeDefined();

        const session = yield* engine.provisionSessionIn(worktree.id, {
          harness: "codex",
          label: null,
          ownerUserId: "user-fixture",
        });
        expect(session.worktreeId).toBe(worktree.id);
        expect(session.branch).toBe("mend/durable-place");

        // ensureWorktree on the same name joins, never duplicates.
        const again = yield* engine.ensureWorktree(
          project.id,
          { name: "durable-place", base: null },
          null,
        );
        expect(again.id).toBe(worktree.id);
        expect(world.worktrees.size).toBe(1);
      }),
    );
  });

  it("indexes every attached run with an independent sequence cursor", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });
        const firstRunId = SealantRunId.make("sealant-run-1");
        const secondRunId = SealantRunId.make("sealant-run-2");

        yield* engine.attachRun(session.id, firstRunId, SealantWorkspaceId.make("workspace-1"));
        const first = world.sessionRuns.get(firstRunId);
        expect(first?.ordinal).toBe(0);
        expect(first?.lastSeenSequence).toBe(0n);

        if (first !== undefined) {
          world.sessionRuns.set(
            firstRunId,
            new SessionRun({
              ...first,
              lastSeenSequence: 47n,
              status: "completed",
              settledAt: now(),
              updatedAt: now(),
            }),
          );
        }
        const afterFirst = world.sessions.get(session.id);
        if (afterFirst !== undefined) {
          world.sessions.set(
            session.id,
            new Session({
              ...afterFirst,
              status: "completed",
              settledAt: now(),
              lastSeenSequence: 47n,
              updatedAt: now(),
            }),
          );
        }

        yield* engine.attachRun(session.id, secondRunId, SealantWorkspaceId.make("workspace-2"));

        const runs = [...world.sessionRuns.values()].toSorted(
          (left, right) => left.ordinal - right.ordinal,
        );
        expect(runs).toHaveLength(2);
        expect(runs.map((run) => run.sealantRunId)).toEqual([firstRunId, secondRunId]);
        expect(runs.map((run) => run.lastSeenSequence)).toEqual([47n, 0n]);
        expect(world.sessions.get(session.id)?.lastSeenSequence).toBe(0n);

        const checkpoint = yield* engine.checkpointNow(session.id, "user-mark");
        expect(checkpoint.sealantRunId).toBe(secondRunId);
        expect(checkpoint.seq).toBe(0n);
      }),
    );
  });

  it("checkpointNow snapshots edits and refreshes the change head", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });

        const worktree = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
        fs.writeFileSync(path.join(worktree, "app.ts"), "export const answer = 42\n");

        const checkpoint = yield* engine.checkpointNow(session.id, "user-mark");
        expect(checkpoint.trigger).toBe("user-mark");
        // Beside Mend there is nothing to flush: the worktree is the head.
        expect(yield* engine.flushCaptures(session.id, "automatic landing")).toBe("none");
        expect(checkpoint.ref).toContain(`refs/mend/checkpoints/${session.worktreeId}/2`);
        // The change stamps this session as its last contributor on refresh.
        const change = world.changes.get(session.worktreeId);
        expect(change?.headSha).toBe(checkpoint.sha);
        expect(change?.sessionId).toBe(session.id);

        // The slice cp0..cp2 carries exactly the edit.
        const store = yield* Store;
        const cp0 = world.checkpoints.find(
          (c) => c.worktreeId === session.worktreeId && c.ordinal === 0,
        );
        const diff = yield* store.diffRange(worktree, String(cp0?.sha), String(checkpoint.sha));
        expect(diff).toContain("+export const answer = 42");
      }),
    );
  });

  it("stop settles the session and leaves a final mark", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "custom",
          label: null,
          base: null,
        });

        yield* engine.stop(session.id);

        const settled = world.sessions.get(session.id);
        expect(settled?.status).toBe("stopped");
        expect(settled?.settledAt).not.toBeNull();
        const marks = world.checkpoints.filter(
          (c) => c.sessionId === session.id && c.trigger === "user-mark",
        );
        expect(marks).toHaveLength(1);
      }),
    );
  });

  it("refuses to resume a settled session without saved harness state", async () => {
    await withEngine((world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          name: null,
          ownerUserId: "user-fixture",
          projectId: project.id,
          harness: "codex",
          label: null,
          base: null,
        });
        world.sessions.set(
          session.id,
          new Session({
            ...session,
            status: "completed",
            settledAt: now(),
            updatedAt: now(),
          }),
        );

        const error = yield* engine.resumeSession(session.id, null).pipe(Effect.flip, Effect.orDie);

        expect(error).toBeInstanceOf(HarnessStateNotFoundError);
        expect(error.message).toContain(String(session.id));
      }),
    );
  });

  it("resumes a crashed session natively from its live harness home", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "codex",
            label: null,
            base: null,
          });
          // A crashed agent process: it ran, its workspace died, no capture was harvested.
          const processId = SessionProcessId.make(crypto.randomUUID());
          world.processes.set(
            processId,
            new SessionProcess({
              id: processId,
              sessionId: session.id,
              sealantWorkspaceId: SealantWorkspaceId.make("ws-crashed"),
              sealantSessionId: "pty-crashed",
              sealantRunId: SealantRunId.make("run-crashed"),
              launchCorrelationId: null,
              serviceId: null,
              attemptOrdinal: null,
              kind: "agent-pty",
              harness: "codex",
              providerSessionId: null,
              protocolOptions: null,
              label: "codex",
              argv: ["codex"],
              status: "exited",
              exitCode: 137,
              workspacePort: null,
              protocol: "tcp",
              hostPort: null,
              createdAt: now(),
              exitedAt: now(),
              updatedAt: now(),
            }),
          );
          // What the durable harness-home mount kept: the rollout, live on the store.
          const rolloutId = crypto.randomUUID();
          const rolloutDir = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".codex",
            "sessions",
            "2026",
            "08",
            "28",
          );
          fs.mkdirSync(rolloutDir, { recursive: true });
          fs.writeFileSync(
            path.join(rolloutDir, `rollout-2026-08-28T10-00-00-${rolloutId}.jsonl`),
            `${JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "text", text: "keep going" }],
              },
            })}\n`,
          );
          world.sessions.set(
            session.id,
            new Session({ ...session, status: "failed", settledAt: now(), updatedAt: now() }),
          );

          const resumed = yield* engine.resumeSession(session.id, null);
          expect(resumed.status).toBe("running");
          // The relaunch is a NATIVE resume addressed at the live rollout's own session id.
          const liveAgent = [...world.processes.values()].find(
            (process) => process.exitedAt === null,
          );
          expect(liveAgent?.argv.slice(0, 3)).toEqual(["codex", "resume", rolloutId]);
          expect(liveAgent?.providerSessionId).toBe(rolloutId);
          // The live state became a committed capture for the crashed process.
          const manifest = JSON.parse(
            fs.readFileSync(
              path.join(
                processStatePathOf(project.storePath, session.id, processId),
                "manifest.json",
              ),
              "utf8",
            ),
          ) as { readonly providerSessionId: string | null };
          expect(manifest.providerSessionId).toBe(rolloutId);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("observes an external agent through the harness home and ends it when writes go quiet", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "claude",
            label: null,
            base: null,
          });
          // The open workbench: a shell holds the workspace; no engine agent runs.
          yield* engine.launch(session.id, ["bash"]);

          // Quiet harness home: nothing to observe.
          yield* engine.observeExternalAgents();
          const externalRows = () =>
            [...world.processes.values()].filter((process) => process.kind === "agent-external");
          expect(externalRows()).toHaveLength(0);

          // A claude run by hand inside the shell writes through the mounted harness home.
          const providerId = crypto.randomUUID();
          const projectDir = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "projects",
            "-workspace-repo",
          );
          fs.mkdirSync(projectDir, { recursive: true });
          const transcript = path.join(projectDir, `${providerId}.jsonl`);
          fs.writeFileSync(transcript, "{}\n");

          yield* engine.observeExternalAgents();
          expect(externalRows()).toHaveLength(1);
          const observed = externalRows()[0];
          expect(observed?.harness).toBe("claude");
          expect(observed?.providerSessionId).toBe(providerId);
          expect(observed?.exitedAt).toBeNull();
          expect(observed?.sealantSessionId).toBeNull();
          expect(world.sessions.get(session.id)?.status).toBe("running");

          // A second pass while writes stay fresh observes nothing new.
          yield* engine.observeExternalAgents();
          expect(externalRows()).toHaveLength(1);

          // Writes go quiet: the observed agent's end is recorded. The workspace is NOT
          // swept — quiet is an inference, and the agent may just sit between turns.
          const past = new Date(Date.now() - 10 * 60_000);
          fs.utimesSync(transcript, past, past);
          yield* engine.observeExternalAgents();
          expect(externalRows()[0]?.exitedAt).not.toBeNull();
          expect(stopped).toHaveLength(0);

          // The user was only thinking: a new message writes again, and the next pass
          // observes a fresh row — same conversation, session running again.
          fs.utimesSync(transcript, new Date(), new Date());
          yield* engine.observeExternalAgents();
          const revived = externalRows().filter((process) => process.exitedAt === null);
          expect(revived).toHaveLength(1);
          expect(revived[0]?.providerSessionId).toBe(providerId);
          expect(world.sessions.get(session.id)?.status).toBe("running");
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped) },
    );
  });

  it("late-observes a quiet external conversation mend never saw — captured, then ended", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "claude",
            label: null,
            base: null,
          });
          yield* engine.launch(session.id, ["bash"]);

          // A codex conversation ran and went quiet before any observer tick saw it (an
          // unreadable window, a mend restart) — the transcript is 10 minutes old.
          const rolloutId = crypto.randomUUID();
          const rolloutDir = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".codex",
            "sessions",
            "2026",
            "08",
            "29",
          );
          fs.mkdirSync(rolloutDir, { recursive: true });
          const rollout = path.join(rolloutDir, `rollout-2026-08-29T18-00-00-${rolloutId}.jsonl`);
          fs.writeFileSync(
            rollout,
            `${JSON.stringify({
              type: "response_item",
              payload: { type: "message", role: "user", content: [{ type: "text", text: "hi" }] },
            })}\n`,
          );
          const past = new Date(Date.now() - 10 * 60_000);
          fs.utimesSync(rollout, past, past);

          yield* engine.observeExternalAgents();
          const observed = [...world.processes.values()].filter(
            (process) => process.kind === "agent-external",
          );
          expect(observed).toHaveLength(1);
          expect(observed[0]?.harness).toBe("codex");
          expect(observed[0]?.providerSessionId).toBe(rolloutId);
          // Late observation: the row records that it happened — already ended.
          expect(observed[0]?.exitedAt).not.toBeNull();

          // A second pass does not re-observe history.
          yield* engine.observeExternalAgents();
          expect(
            [...world.processes.values()].filter((process) => process.kind === "agent-external"),
          ).toHaveLength(1);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("presumes transcript writes belong to a live engine agent — nothing observed", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            name: null,
            ownerUserId: "user-fixture",
            projectId: project.id,
            harness: "claude",
            label: null,
            base: null,
          });
          yield* engine.launch(session.id, ["claude"]);

          const projectDir = path.join(
            harnessHomePathOf(project.storePath, session.id),
            ".claude",
            "projects",
            "-workspace-repo",
          );
          fs.mkdirSync(projectDir, { recursive: true });
          fs.writeFileSync(path.join(projectDir, `${crypto.randomUUID()}.jsonl`), "{}\n");

          yield* engine.observeExternalAgents();
          expect(
            [...world.processes.values()].filter((process) => process.kind === "agent-external"),
          ).toHaveLength(0);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("resume fails sessions that died before the harness started", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-engine-resume-"));
    const world = makeWorld();
    // An unsettled session with no Sealant run — the crash-before-start case.
    const orphan = new Session({
      id: SessionId.make(crypto.randomUUID()),
      projectId: ProjectId.make("proj-1"),
      worktreeId: WorktreeId.make("wt-orphan"),
      harness: "codex",
      providerSessionId: null,
      label: null,
      worktree: "session-x",
      branch: "mend/session/x",
      baseSha: Sha.make("0000000000000000000000000000000000000000"),
      baseRef: "main",
      contextSnapshotId: null,
      referenceMounts: [],
      extraMounts: [],
      sealantRunId: null,
      sealantWorkspaceId: null,
      sealantSessionId: null,
      workspaceExpiresAt: null,
      workspaceTtlRenewedAt: null,
      workspaceTtlRenewalFailedAt: null,
      workspaceTtlRenewalError: null,
      workspaceImage: null,
      dotfiles: null,
      ownerUserId: "user-fixture",
      hasTranscript: null,
      status: "running",
      summary: null,
      lastSeenSequence: 0n,
      recordHistoryComplete: false,
      startedAt: now(),
      settledAt: null,
      createdAt: now(),
      updatedAt: now(),
    });
    world.sessions.set(orphan.id, orphan);

    const storeLayer = Store.layer.pipe(
      Layer.provide(StoreConfig.layerFor(path.join(tmp, "store"))),
    );
    const engineLayer = SessionEngineLive.pipe(
      Layer.provide(testDrainPolicy()),
      Layer.provide(
        SessionRepositoryLocalLive.pipe(
          Layer.provide(storeLayer),
          Layer.provide(projectsLayer(world)),
        ),
      ),
      Layer.provide(storeLayer),
      Layer.provide(byWorkspaceCreatorIn(world, sealantDeadLayer)),
      Layer.provide(projectsLayer(world)),
      Layer.provide(sessionsLayer(world)),
      Layer.provide(sessionRunsLayer(world)),
      Layer.provide(sessionProcessesLayer(world)),
      Layer.provide(
        Layer.mergeAll(agentConversationStubLayer, protocolHostStubLayer, serviceStateLayer(world)),
      ),
      Layer.provide(serviceHostStubLayer),
      Layer.provide(sessionSocketStubLayer),
      Layer.provide(SessionChannelTokensRepoMemory),
      Layer.provide(DeploymentConfigColocated),
      Layer.provide(CaptureRuntimeOff),
      Layer.provide(mendKeysStubLayer),
      Layer.provide(
        // One merged provide: `pipe` is typed to 20 operators and this list outgrew it.
        Layer.mergeAll(
          agentBridgeStubLayer,
          gitOpsStubLayer,
          changesLayer(world),
          worktreesLayer(world),
          checkpointsLayer(world),
          referencesEmptyLayer,
          projectMountsEmptyLayer,
          projectLinksEmptyLayer,
          SessionRepositoriesRepoMemory,
          organizationsLayer(world),
          auditLayer(world),
          sourcePolicyLayer,
          Layer.mock(InstanceRolesRepo, { isOperator: () => Effect.succeed(true) }),
          foldersEmptyLayer,
          projectRecipesEmptyLayer,
          hotWorkspacesEmptyLayer,
          WorkspaceHostUserNamespacesUnobserved,
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          projectEnvironmentLayer(emptyEnvironment),
          projectSecretsLayer(emptySecrets),
          projectClusterBindingsLayer(emptyClusterBindings),
          secretCipherStubLayer,
          settingsLayer(),
          userDotfilesStubLayer,
          gitAuthorStubLayer,
          WorkspaceGitHooksLive,
          dotfilesStoreStubLayer,
          dotfilesClonerLayer(),
          skillsStubLayer,
          piProfilesLayerOf(),
          agentMemoryLayerOf(),
          secretFilesLayerOf(),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          harnessLayoutsRepoMemory(),
          PersonLayoutPlatformNone,
          HarnessLayoutConfigShared,
        ),
      ),
    );
    // Constructing the engine runs resume().
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* SessionEngine;
      }).pipe(
        Effect.provide(engineLayer),
        Effect.ensuring(Effect.sync(() => fs.rmSync(tmp, { recursive: true, force: true }))),
        Effect.orDie,
      ),
    );
    const settled = world.sessions.get(orphan.id);
    expect(settled?.status).toBe("failed");
    expect(settled?.summary).toContain("restarted before the harness started");
  });
});

describe("SessionEngine workspace git hooks", () => {
  it("reports an ended agent while its workspace is still up, before the sweep stops it", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const heard: Array<{ readonly sessionId: string; readonly stoppedYet: number }> = [];
    const hooks = Layer.succeed(WorkspaceGitHooks, {
      branchesPushed: () => Effect.void,
      agentEnded: (event) =>
        Effect.sync(
          () => void heard.push({ sessionId: event.sessionId, stoppedYet: stopped.length }),
        ),
      pullRequestOpened: () => Effect.void,
      register: () => Effect.void,
      landRequested: () => Effect.succeed({ landed: false, lines: [] }),
      registerLanding: () => Effect.void,
    });
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          yield* engine.stop(session.id);
          for (let i = 0; i < 300 && stopped.length === 0; i++) {
            yield* Effect.sleep(Duration.millis(10));
          }
          expect(heard).toEqual([{ sessionId: session.id, stoppedYet: 0 }]);
          expect(stopped).toEqual(["workspace-1"]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, stopped), gitHooksLayer: hooks },
    );
  });
});

describe("SessionEngine workspace git hooks: pushes", () => {
  it("reports a push through the transport that moved a branch, and nothing else", async () => {
    const created: CreateOptions[] = [];
    const pushed: Array<string> = [];
    const hooks = Layer.succeed(WorkspaceGitHooks, {
      branchesPushed: (event) => Effect.sync(() => void pushed.push(event.worktreeId)),
      agentEnded: () => Effect.void,
      pullRequestOpened: () => Effect.void,
      register: () => Effect.void,
      landRequested: () => Effect.succeed({ landed: false, lines: [] }),
      registerLanding: () => Effect.void,
    });
    const zero = "0".repeat(40);
    const next = "a".repeat(40);
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const api = servedSocketApis.get(session.id);
          if (api === undefined) return yield* Effect.die("no socket api served");
          yield* api.gitTransportDone("op-tag", 0, [`${zero} ${next} refs/tags/v1`]);
          yield* api.gitTransportDone("op-failed", 1, [`${zero} ${next} refs/heads/wip`]);
          yield* api.gitTransportDone("op-fetch", 0, null);
          expect(pushed).toEqual([]);
          yield* api.gitTransportDone("op-push", 0, [`${zero} ${next} refs/heads/chore/bump`]);
          expect(pushed).toEqual([session.worktreeId]);
        }),
      { sealantLayer: sealantLaunchLayer(created), gitHooksLayer: hooks },
    );
  });
});

describe("SessionEngine git author", () => {
  const savedAuthor = Layer.succeed(UserGitAuthorRepo, {
    resolve: (userId) =>
      Effect.succeed(
        userId === "user-fixture"
          ? new ResolvedGitAuthor({
              name: "Anna Example",
              email: "anna@example.com",
              source: "setting",
            })
          : null,
      ),
    set: () => Effect.void,
    clear: () => Effect.void,
  });

  /** Launch one codex session; report what ran in the workspace before the harness opened. */
  const launchAndWatch = async (captured: MemoryCaptureStore | undefined) => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const beforeHarness: Array<ReadonlyArray<string>> = [];
    let opened = false;
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
        }),
      {
        ...(captured === undefined ? {} : { captured }),
        gitAuthorLayer: savedAuthor,
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
          undefined,
          {
            beforeOpen: () => {
              if (opened) return;
              opened = true;
              beforeHarness.push(...execCalls);
            },
          },
        ),
      },
    );
    return { created, execCalls, beforeHarness };
  };

  it("writes the owner's author as system git config before the harness starts", async () => {
    const { created, execCalls, beforeHarness } = await launchAndWatch(undefined);
    expect(execCalls.filter(isGitAuthorExec)).toEqual([
      [
        "sh",
        "-c",
        'git config --system user.name "$1" && git config --system user.email "$2"',
        "mend-git-author",
        "Anna Example",
        "anna@example.com",
      ],
    ]);
    expect(beforeHarness.some(isGitAuthorExec)).toBe(true);
    // Never as env: GIT_AUTHOR_* would override the owner's dotfiles and the repository's config.
    const env = created[0]?.env ?? {};
    expect(Object.keys(env).filter((name) => name.startsWith("GIT_"))).toEqual([]);
  });

  it("writes it in a captured workspace too, where nothing is mounted", async () => {
    const { created, execCalls, beforeHarness } = await launchAndWatch(makeMemoryCaptureStore());
    expect(created[0]?.source?.kind).toBe("capture");
    expect(execCalls.filter(isGitAuthorExec).map((argv) => argv.slice(4))).toEqual([
      ["Anna Example", "anna@example.com"],
    ]);
    expect(beforeHarness.some(isGitAuthorExec)).toBe(true);
  });
});

/** A default shell profile file as shipped (`packages/sessions/src/shell-profile/`). */
const shellProfileAsset = (name: string) =>
  fs.readFileSync(new URL(`../src/shell-profile/${name}`, import.meta.url), "utf8");

describe("SessionEngine default shell profile", () => {
  const ZSHRC = shellProfileAsset("zshrc");
  const STARSHIP = shellProfileAsset("starship.toml");
  const DOTFILES_ZSHRC = "# from the owner's dotfiles\n";
  const DOTFILES_STARSHIP = "add_newline = true\n";

  /**
   * Launch one codex session into `image`, with the workspace's `$HOME` a real directory: the
   * profile exec runs its own script there, as the workspace would, and every other exec answers
   * exit 0. `dotfiles` puts what the owner's dotfiles left in `$HOME` before the launch; the
   * result reads both profile paths back after it.
   */
  const launchWithHome = async (options: {
    readonly captured?: MemoryCaptureStore;
    readonly image?: LaunchImage;
    readonly defaultShellProfile?: boolean;
    readonly dotfiles?: { readonly zshrc?: boolean; readonly starship?: boolean };
  }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-shell-profile-home-"));
    if (options.dotfiles?.zshrc === true) {
      fs.writeFileSync(path.join(home, ".zshrc"), DOTFILES_ZSHRC);
    }
    if (options.dotfiles?.starship === true) {
      fs.mkdirSync(path.join(home, ".config"));
      fs.writeFileSync(path.join(home, ".config", "starship.toml"), DOTFILES_STARSHIP);
    }
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const beforeHarness: Array<ReadonlyArray<string>> = [];
    let opened = false;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          if (options.defaultShellProfile !== undefined) {
            world.projects.set(
              project.id,
              new Project({ ...project, defaultShellProfile: options.defaultShellProfile }),
            );
          }
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
        }),
      {
        ...(options.captured === undefined ? {} : { captured: options.captured }),
        workspaceImage: options.image ?? ZSH_FAMILY,
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
          undefined,
          {
            beforeOpen: () => {
              if (opened) return;
              opened = true;
              beforeHarness.push(...execCalls);
            },
            exec: (argv) => {
              if (!isShellProfileExec(argv)) return undefined;
              const result = spawnSync("sh", argv.slice(1), {
                env: { ...process.env, HOME: home },
                encoding: "utf8",
              });
              return {
                exitCode: result.status ?? 1,
                stdout: result.stdout,
                stderr: result.stderr,
              };
            },
          },
        ),
      },
    );
    const read = (relative: string) => {
      const file = path.join(home, relative);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    };
    const zshrc = read(".zshrc");
    const starship = read(".config/starship.toml");
    fs.rmSync(home, { recursive: true, force: true });
    return {
      created,
      profileExecs: execCalls.filter(isShellProfileExec),
      beforeHarness,
      zshrc,
      starship,
    };
  };

  it("writes ~/.zshrc and ~/.config/starship.toml into a zsh workspace with neither, before the harness starts", async () => {
    const launched = await launchWithHome({});
    expect(launched.profileExecs).toHaveLength(1);
    expect(launched.beforeHarness.some(isShellProfileExec)).toBe(true);
    expect(launched.zshrc).toBe(ZSHRC);
    expect(launched.starship).toBe(STARSHIP);
  });

  it("leaves each file the owner's dotfiles put there and writes only the other", async () => {
    const keptZshrc = await launchWithHome({ dotfiles: { zshrc: true } });
    expect(keptZshrc.zshrc).toBe(DOTFILES_ZSHRC);
    expect(keptZshrc.starship).toBe(STARSHIP);

    const keptStarship = await launchWithHome({ dotfiles: { starship: true } });
    expect(keptStarship.zshrc).toBe(ZSHRC);
    expect(keptStarship.starship).toBe(DOTFILES_STARSHIP);
  });

  it("does the same in a captured workspace, where nothing is mounted", async () => {
    const fresh = await launchWithHome({ captured: makeMemoryCaptureStore() });
    expect(fresh.created[0]?.source?.kind).toBe("capture");
    expect(fresh.beforeHarness.some(isShellProfileExec)).toBe(true);
    expect(fresh.zshrc).toBe(ZSHRC);
    expect(fresh.starship).toBe(STARSHIP);

    const kept = await launchWithHome({
      captured: makeMemoryCaptureStore(),
      dotfiles: { zshrc: true, starship: true },
    });
    expect(kept.profileExecs).toHaveLength(1);
    expect(kept.zshrc).toBe(DOTFILES_ZSHRC);
    expect(kept.starship).toBe(DOTFILES_STARSHIP);
  });

  it("writes nothing when the project turns it off", async () => {
    for (const captured of [undefined, makeMemoryCaptureStore()]) {
      const launched = await launchWithHome({
        ...(captured === undefined ? {} : { captured }),
        defaultShellProfile: false,
      });
      expect(launched.profileExecs).toEqual([]);
      expect(launched.zshrc).toBeNull();
      expect(launched.starship).toBeNull();
    }
  });

  it("writes nothing into a bash family image or a custom base", async () => {
    for (const image of [{ ...ZSH_FAMILY, shell: "bash" as const }, CUSTOM_BASE]) {
      const launched = await launchWithHome({ image });
      expect(launched.profileExecs).toEqual([]);
      expect(launched.zshrc).toBeNull();
    }
  });
});

const gunzipped = (text: string) => gunzipSync(Buffer.from(text, "base64"));

/**
 * What the batched write execs put where: absolute workspace path → contents. Reads the writer's
 * operations (`workspace-files.ts`): `w` writes, `s`/`a` stage, `f` writes what was staged.
 */
const writtenFiles = (execCalls: ReadonlyArray<ReadonlyArray<string>>): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  const staged = new Map<string, string>();
  for (const argv of execCalls) {
    if (argv[3] !== "mend-write") continue;
    const picked = pickedUpWrites.get(argv);
    if (picked !== undefined) {
      for (const file of picked) files.set(file.path, Buffer.from(file.base64, "base64"));
      continue;
    }
    const ops = argv.slice(4);
    let index = 0;
    const list = () => {
      const count = Number(ops[index++]);
      const out = ops.slice(index, index + count);
      index += count;
      return out;
    };
    while (index < ops.length) {
      const op = ops[index++];
      if (op === "w") {
        const paths = list();
        const bytes = gunzipped(list().join(""));
        for (const target of paths) files.set(target, bytes);
      } else if (op === "s" || op === "a") {
        const staging = ops[index++] ?? "";
        const text = list().join("");
        staged.set(staging, (op === "a" ? (staged.get(staging) ?? "") : "") + text);
      } else if (op === "f") {
        const staging = ops[index++] ?? "";
        const paths = list();
        const bytes = gunzipped(staged.get(staging) ?? "");
        for (const target of paths) files.set(target, bytes);
      } else {
        throw new Error(`unknown write operation ${op ?? ""}`);
      }
    }
  }
  return files;
};

describe("SessionEngine files into a captured workspace", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const captureLayer = (created: CreateOptions[], execCalls: ReadonlyArray<string>[]) =>
    sealantLaunchLayer(
      created,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      execCalls,
    );

  it("places a pasted image in the live workspace's harness home, not on this machine", async () => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
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
            base: null,
          });
          // No workspace yet: nowhere a harness would read the file, so nothing is stored.
          const early = yield* engine
            .storePastedImage(session.id, PNG, "user-fixture")
            .pipe(Effect.flip);
          expect(early._tag).toBe("SessionNotLiveError");

          yield* engine.launch(session.id, ["codex"]);
          const placed = yield* engine.storePastedImage(session.id, PNG, "user-fixture");
          expect(placed.path).toMatch(/^\/workspace\/harness-home\/paste\/\d{8}-\d{6}-\w{4}\.png$/);
          expect(placed.mediaType).toBe("image/png");
          expect(new Uint8Array(writtenFiles(execCalls).get(placed.path) ?? [])).toEqual(PNG);
          expect(
            fs.existsSync(path.join(harnessHomePathOf(project.storePath, session.id), "paste")),
          ).toBe(false);

          const refused = yield* engine
            .storePastedImage(session.id, new TextEncoder().encode("not an image"), "user-fixture")
            .pipe(Effect.flip);
          expect(refused._tag).toBe("PastedImageError");
        }),
      { captured: makeMemoryCaptureStore(), sealantLayer: captureLayer(created, execCalls) },
    );
  });

  it("keeps writing a co-located paste beside the store, launched or not", async () => {
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
          base: null,
        });
        const placed = yield* engine.storePastedImage(session.id, PNG, "user-fixture");
        const hostPath = path.join(
          harnessHomePathOf(project.storePath, session.id),
          "paste",
          path.posix.basename(placed.path),
        );
        expect(new Uint8Array(fs.readFileSync(hostPath))).toEqual(PNG);
      }),
    );
  });

  it("delivers the owner's skills into a captured workspace's harness home", async () => {
    const created: CreateOptions[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const skillsLayer = skillsForLaunchLayer((ownerUserId, projectId) =>
      Effect.succeed({
        user: [
          launchSkill("global", "owner global", {
            scope: "user",
            userId: ownerUserId ?? "missing-owner",
          }),
        ],
        project: [launchSkill("local", "project local", { scope: "project", projectId })],
      }),
    );
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
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);
          const written = writtenFiles(execCalls);
          const text = (file: string) => written.get(file)?.toString("utf8");
          for (const target of [".claude/skills", ".codex/skills", ".pi/agent/skills"]) {
            expect(text(`/workspace/harness-home/${target}/global/SKILL.md`)).toBe("owner global");
            expect(text(`/workspace/harness-home/${target}/local/SKILL.md`)).toBe("project local");
          }
          expect(
            JSON.parse(text("/workspace/harness-home/.mend-managed-skills.json") ?? "{}"),
          ).toEqual({
            ".claude/skills": ["global", "local"],
            ".codex/skills": ["global", "local"],
            ".pi/agent/skills": ["global", "local"],
          });
          expect(
            JSON.parse(text("/workspace/harness-home/.mend-managed-skills-digests.json") ?? "{}"),
          ).toMatchObject({ ".claude/skills": { global: expect.any(String) } });
          // The bundles are rewritten whole: their old directories are cleared first, each one
          // only if it is exactly what Mend delivered, else kept aside.
          const prepared = execCalls.find((argv) => argv[3] === "mend-skills");
          expect(prepared?.[4]).toBe("/workspace/harness-home");
          expect(prepared?.[5]).toMatch(/^\.mend\/skills-kept\//);
          const vacate: ReadonlyArray<{ dir: string; accept: ReadonlyArray<string> }> = JSON.parse(
            prepared?.[6] ?? "[]",
          );
          expect(vacate.map((entry) => entry.dir)).toContain(".claude/skills/global");
          expect(prepared?.[2]).not.toContain("rm -rf");
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: captureLayer(created, execCalls),
        skillsLayer,
      },
    );
  });
});

describe("SessionEngine hot sessions", () => {
  /**
   * An in-memory pool with one skeleton. `claim` ignores the fingerprint — the test simulates a
   * project whose inputs still match — and `create` dies so the post-claim rewarm stops before
   * touching the platform (its worktree creation is real and harmless in the tmp store).
   */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const hotPoolLayer = (pool: { entries: Array<HotWorkspace>; removed: Array<string> }) =>
    Layer.succeed(HotWorkspacesRepo, {
      create: () => Effect.die("not in test"),
      byId: (id) => Effect.sync(() => pool.entries.find((entry) => entry.id === id) ?? null),
      listForProject: (projectId) =>
        Effect.sync(() => pool.entries.filter((entry) => entry.projectId === projectId)),
      listAll: () => Effect.sync(() => [...pool.entries]),
      setReady: () => Effect.void,
      setBaseSha: () => Effect.void,
      setFailed: () => Effect.void,
      claim: (projectId) =>
        Effect.sync(() => {
          const index = pool.entries.findIndex(
            (entry) => entry.projectId === projectId && entry.status === "ready",
          );
          const entry = pool.entries[index];
          if (entry === undefined) return null;
          const claimed = new HotWorkspace({ ...entry, status: "claimed", updatedAt: now() });
          pool.entries[index] = claimed;
          return claimed;
        }),
      remove: (id) =>
        Effect.sync(() => {
          pool.removed.push(id);
          pool.entries = pool.entries.filter((entry) => entry.id !== id);
        }),
    });

  it("claims a ready skeleton: provision adopts its id and launch skips the create", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          // A standby skeleton (ADR-0001): a live workspace over the project's worktrees root,
          // no worktree of its own — the claiming session brings one and the launch binds it.
          pool.entries.push(
            new HotWorkspace({
              id: skeletonId,
              projectId: project.id,
              worktreeId: null,
              ownerUserId: "user-fixture",
              status: "ready",
              error: null,
              fingerprint: "match-simulated-by-the-fake-claim",
              remoteSsh: "not-taken",
              harnessLayout: "shared",
              worktree: null,
              branch: null,
              baseSha: null,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              workspaceImage: defaultSettings.workspaceImage,
              // What the prewarm applied, a source it left out included, is what the claiming
              // session records.
              dotfiles: {
                repository: { url: "https://example.test/dots.git", ref: null },
                snapshotSha: null,
                notApplied: [{ source: "repository", reason: "dotfiles clone failed" }],
              },
              environment: {
                environmentRevision: 0,
                environmentVariableNames: [],
                secretRevision: 0,
                secretNames: [],
              },
              referenceMounts: [],
              extraMounts: [],
              createdAt: now(),
              updatedAt: now(),
            }),
          );

          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          // The session adopted the skeleton's id, and brought a worktree of its own.
          expect(session.id).toBe(skeletonId);
          expect(session.worktree).toMatch(/^wt-/);
          expect(session.branch).toBe(`mend/wt/${session.worktreeId}`);
          const worktreesRepo = yield* WorktreesRepo;
          expect((yield* worktreesRepo.byId(session.worktreeId))?.directory).toBe(session.worktree);

          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(0);
          expect(spawned.length).toBeGreaterThan(0);
          // The claimed standby receives the owner's git author at claim, as a cold one does.
          expect(execCalls.filter(isGitAuthorExec).map((argv) => argv.slice(4))).toEqual([
            ["Account user-fixture", "user-fixture@accounts.example"],
          ]);
          // …and the default shell profile: the standby's image is the zsh default.
          expect(execCalls.filter(isShellProfileExec)).toHaveLength(1);
          expect(pool.removed).toContain(skeletonId);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.sealantWorkspaceId).toBe("workspace-1");
          expect(launched?.dotfiles).toEqual({
            repository: { url: "https://example.test/dots.git", ref: null },
            snapshotSha: null,
            notApplied: [{ source: "repository", reason: "dotfiles clone failed" }],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          () => false,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
        ),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });

  it("claims a ready skeleton for a new conversation inside an existing worktree too", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          // A standby skeleton (ADR-0001): a live workspace over the project's worktrees root,
          // no worktree of its own — the claiming session brings one and the launch binds it.
          pool.entries.push(
            new HotWorkspace({
              id: skeletonId,
              projectId: project.id,
              worktreeId: null,
              ownerUserId: "user-fixture",
              status: "ready",
              error: null,
              fingerprint: "match-simulated-by-the-fake-claim",
              remoteSsh: "not-taken",
              harnessLayout: "shared",
              worktree: null,
              branch: null,
              baseSha: null,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              workspaceImage: defaultSettings.workspaceImage,
              dotfiles: { repository: null, snapshotSha: null, notApplied: [] },
              environment: {
                environmentRevision: 0,
                environmentVariableNames: [],
                secretRevision: 0,
                secretNames: [],
              },
              referenceMounts: [],
              extraMounts: [],
              createdAt: now(),
              updatedAt: now(),
            }),
          );

          const engine = yield* SessionEngine;
          // The worktree already exists (a durable place, or one holding other sessions): the
          // worktree-scoped verb — "s session here", the web's new conversation — claims too.
          const place = yield* engine.ensureWorktree(
            project.id,
            { name: "shared-place", base: null },
            "user-fixture",
          );
          const session = yield* engine.provisionSessionIn(place.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(session.id).toBe(skeletonId);
          expect(session.worktreeId).toBe(place.id);
          expect(session.worktree).toBe(place.directory);
          const worktreesRepo = yield* WorktreesRepo;
          expect((yield* worktreesRepo.byId(session.worktreeId))?.directory).toBe(session.worktree);

          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(0);
          expect(spawned.length).toBeGreaterThan(0);
          expect(pool.removed).toContain(skeletonId);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.sealantWorkspaceId).toBe("workspace-1");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });

  /** A ready co-located standby over `project`'s worktrees root, as the hot pool keeps one. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const readyStandby = (projectId: ProjectId, id: SessionId) =>
    new HotWorkspace({
      id,
      projectId,
      worktreeId: null,
      ownerUserId: "user-fixture",
      status: "ready",
      error: null,
      fingerprint: "match-simulated-by-the-fake-claim",
      remoteSsh: "not-taken",
      harnessLayout: "shared",
      worktree: null,
      branch: null,
      baseSha: null,
      sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
      workspaceImage: defaultSettings.workspaceImage,
      dotfiles: { repository: null, snapshotSha: null, notApplied: [] },
      environment: {
        environmentRevision: 0,
        environmentVariableNames: [],
        secretRevision: 0,
        secretNames: [],
      },
      referenceMounts: [],
      extraMounts: [],
      createdAt: now(),
      updatedAt: now(),
    });

  const LEGACY_URL = "http://user:R6-FIXTURE-TOKEN@127.0.0.1:9/repo";

  it("leaves a standby over a store with a login or token unclaimed, and refuses the launch as a cold one", async () => {
    // Review 6 of mend#640, R6-1: claiming a surviving co-located standby skipped the gate a
    // cold launch passes, and the claimed workspace ran a new conversation over that store.
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          pool.entries.push(readyStandby(project.id, skeletonId));
          const engine = yield* SessionEngine;
          const place = yield* engine.ensureWorktree(
            project.id,
            { name: "legacy-place", base: null },
            "user-fixture",
          );
          execFileSync("git", ["-C", project.storePath, "config", "remote.origin.url", LEGACY_URL]);
          const session = yield* engine.provisionSessionIn(place.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          // Not claimed: the standby is left as it was, and the session is a cold one.
          expect(session.id).not.toBe(skeletonId);
          expect(pool.entries.map((entry) => [entry.id, entry.status])).toEqual([
            [skeletonId, "ready"],
          ]);
          const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(
            refused._tag === "DotfilesResolveError" ? refused.message : refused._tag,
          ).toContain("remote.origin.url (a login or token");
          expect(JSON.stringify(refused)).not.toContain("R6-FIXTURE-TOKEN");
          expect(created).toHaveLength(0);
          expect(spawned).toHaveLength(0);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });

  it("refuses to launch into a standby claimed before its store held a token, and lets it go", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const skeletonId = SessionId.make(crypto.randomUUID());
          pool.entries.push(readyStandby(project.id, skeletonId));
          const engine = yield* SessionEngine;
          const place = yield* engine.ensureWorktree(
            project.id,
            { name: "claimed-place", base: null },
            "user-fixture",
          );
          // Claimed while the store was clean (before an upgrade, say)…
          const session = yield* engine.provisionSessionIn(place.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(session.id).toBe(skeletonId);
          // …and launched once it is not.
          execFileSync("git", ["-C", project.storePath, "config", "remote.origin.url", LEGACY_URL]);
          const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(
            refused._tag === "DotfilesResolveError" ? refused.message : refused._tag,
          ).toContain("remote.origin.url (a login or token");
          expect(spawned).toHaveLength(0);
          expect(created).toHaveLength(0);
          expect(pool.removed).toContain(skeletonId);
          expect(world.sessions.get(session.id)?.status).toBe("failed");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
      },
    );
  });

  it("leaves a standby unclaimed when a selected reference's clone holds a login or token", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const pool = { entries: [] as Array<HotWorkspace>, removed: [] as Array<string> };
    const selected: Array<Reference> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const clone = path.join(tmp, "legacy-reference");
          execFileSync("git", ["clone", "-q", path.join(tmp, "origin"), clone]);
          execFileSync("git", ["-C", clone, "config", "remote.origin.url", LEGACY_URL]);
          selected.push(
            new Reference({
              id: ReferenceId.make("legacy-reference"),
              name: "legacy-reference",
              organizationId: project.organizationId,
              createdByUserId: "user-fixture",
              originUrl: "https://host.invalid/repo",
              path: clone,
              pinnedRef: null,
              headSha: null,
              refreshedAt: null,
              createdAt: now(),
              updatedAt: now(),
            }),
          );
          const skeletonId = SessionId.make(crypto.randomUUID());
          pool.entries.push(readyStandby(project.id, skeletonId));
          const engine = yield* SessionEngine;
          const place = yield* engine.ensureWorktree(
            project.id,
            { name: "reference-place", base: null },
            "user-fixture",
          );
          const session = yield* engine.provisionSessionIn(place.id, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          expect(session.id).not.toBe(skeletonId);
          const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(
            refused._tag === "DotfilesResolveError" ? refused.message : refused._tag,
          ).toContain("a login or token");
          expect(JSON.stringify(refused)).not.toContain("R6-FIXTURE-TOKEN");
          expect(created).toHaveLength(0);
          expect(spawned).toHaveLength(0);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, () => false, undefined, spawned),
        hotWorkspacesLayer: hotPoolLayer(pool),
        referencesLayer: Layer.succeed(ReferencesRepo, {
          create: () => Effect.die("not in test"),
          byId: (id) => Effect.fail(new ReferenceNotFoundError({ referenceId: id })),
          byName: () => Effect.succeed(null),
          listAll: () => Effect.succeed(selected),
          listForOrganization: () => Effect.succeed(selected),
          byIdsInOrganization: () => Effect.succeed(selected),
          remove: () => Effect.void,
          setHead: () => Effect.void,
          listForProject: () => Effect.succeed(selected),
          setForProject: () => Effect.void,
        }),
      },
    );
  });
});

/** A path on the fixture's git daemon, beside the adopted origin. */
const servedUrl = (project: Project, name: string): string => {
  if (project.originUrl === null) throw new Error("the fixture project has no origin");
  return project.originUrl.replace(/\/origin$/, `/${name}`);
};

/** A dotfiles repo beside the fixture origin, served by the same git daemon. */
const dotfilesOrigin = (tmp: string, project: Project): string => {
  const dots = path.join(tmp, "dots");
  fs.mkdirSync(dots, { recursive: true });
  const run = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [...args], {
      cwd: dots,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "dots",
        GIT_AUTHOR_EMAIL: "dots@localhost",
        GIT_COMMITTER_NAME: "dots",
        GIT_COMMITTER_EMAIL: "dots@localhost",
      },
    });
  run("init", "-b", "main");
  fs.writeFileSync(path.join(dots, ".vimrc"), "set nocompatible\n");
  run("add", "-A");
  run("commit", "-m", "dots");
  return servedUrl(project, "dots");
};

/** The owner's repository knob, read from a cell the test fills once the daemon is up. */
const userDotfilesLayer = (
  cell: { repository: DotfilesRepository | null },
  reads: Array<string> = [],
): Layer.Layer<UserDotfilesRepo> =>
  Layer.succeed(UserDotfilesRepo, {
    repository: (userId) =>
      Effect.sync(() => {
        reads.push(userId);
        return cell.repository;
      }),
    setRepository: (_userId, value) => Effect.succeed(value),
    startAgentsAfterInstall: () => Effect.succeed(false),
    setStartAgentsAfterInstall: (_userId, value) => Effect.succeed(value),
  });

const repositoryOf = (url: string): DotfilesRepository => ({
  url,
  ref: null,
  subdirectory: null,
  manager: "stow",
  bootstrap: false,
});

describe("SessionEngine dotfiles", () => {
  it.each([false, true])(
    "saved loopback dotfiles require the owner's current operator role: %s",
    async (isOperator) => {
      const created: CreateOptions[] = [];
      const requests: string[] = [];
      const roles: string[] = [];
      const recorder = http.createServer((request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve));
      const address = recorder.address();
      if (address === null || typeof address === "string") throw new Error("No recorder.");
      const url = `http://127.0.0.1:${address.port}/saved-dots.git`;
      try {
        await withEngine(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              yield* engine.launch(session.id, ["codex"]);
              expect(created).toHaveLength(1);
              expect(world.sessions.get(session.id)?.status).toBe("running");
              expect(requests).toEqual(
                isOperator ? ["/saved-dots.git/info/refs?service=git-upload-pack"] : [],
              );
              const omitted = world.sessions.get(session.id)?.dotfiles?.notApplied;
              expect(omitted).toHaveLength(1);
              expect(omitted?.[0]?.reason).toContain(isOperator ? "failed" : "only the operator");
            }),
          {
            sealantLayer: sealantLaunchLayer(created),
            userDotfilesLayer: ownedRepositoriesLayer(
              new Map([["user-fixture", repositoryOf(url)]]),
            ),
            dotfilesClonerLayer: dotfilesClonerLayer({ ownerIsOperator: isOperator }),
            instanceRolesLayer: Layer.mock(InstanceRolesRepo, {
              isOperator: (userId) =>
                Effect.sync(() => {
                  roles.push(userId);
                  return isOperator;
                }),
            }),
          },
        );
        expect(roles).toEqual(["user-fixture", "user-fixture"]);
        expect(requests).toEqual(
          isOperator ? ["/saved-dots.git/info/refs?service=git-upload-pack"] : [],
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          recorder.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    },
  );

  it("ships the repository before the snapshot and stamps both as applied", async () => {
    const created: CreateOptions[] = [];
    const cell: { repository: DotfilesRepository | null } = { repository: null };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session } = yield* launchOnce(world, tmp);
          const url = dotfilesOrigin(tmp, project);
          cell.repository = repositoryOf(url);
          yield* engine.launch(session.id, ["codex"]);

          // Apply order: the repository with its own manager, then the snapshot as a copy.
          expect(
            created[0]?.dotfiles?.archives?.map(({ manager, bootstrap }) => ({
              manager,
              bootstrap,
            })),
          ).toEqual([
            { manager: "stow", bootstrap: false },
            { manager: "copy", bootstrap: false },
          ]);
          expect(created[0]?.dotfiles?.archives?.[1]?.data).toBe(SNAPSHOT.data);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: { url, ref: null },
            snapshotSha: SNAPSHOT.sha,
            notApplied: [],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(cell),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
      },
    );
  });

  it("launches without a repository that cannot be cloned, still ships the snapshot, and records why", async () => {
    const created: CreateOptions[] = [];
    const cell: { repository: DotfilesRepository | null } = { repository: null };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session } = yield* launchOnce(world, tmp);
          // The daemon serves nothing at this path: the clone fails the way a wrong URL does.
          const url = servedUrl(project, "no-such-dots");
          cell.repository = repositoryOf(url);
          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles?.archives).toEqual([
            { data: SNAPSHOT.data, manager: "copy", bootstrap: false },
          ]);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: { url, ref: null },
            snapshotSha: SNAPSHOT.sha,
            notApplied: [
              {
                source: "repository",
                reason: expect.stringMatching(
                  /^dotfiles clone of \S+\/no-such-dots failed: fatal: remote error: /,
                ),
              },
            ],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(cell),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
      },
    );
  });

  it("launches with no dotfiles when the only source fails, and records why", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles).toBeUndefined();
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: null,
            snapshotSha: null,
            notApplied: [
              { source: "snapshot", reason: "dotfiles snapshot could not be packed: git failed" },
            ],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        dotfilesStoreLayer: dotfilesStoreLayer(() =>
          Effect.fail(
            new DotfilesStoreError({
              message: "dotfiles snapshot could not be packed: git failed",
            }),
          ),
        ),
      },
    );
  });

  it("launches without a repository the source policy refuses at launch, and records the refusal", async () => {
    const created: CreateOptions[] = [];
    // Saved under a policy that let it through; this launch's policy refuses the host.
    const url = "https://metadata.google.internal/dots.git";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles?.archives).toEqual([
            { data: SNAPSHOT.data, manager: "copy", bootstrap: false },
          ]);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles).toEqual({
            repository: { url, ref: null },
            snapshotSha: SNAPSHOT.sha,
            notApplied: [
              {
                source: "repository",
                reason:
                  "dotfiles repository refused: metadata.google.internal is not a repository host.",
              },
            ],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer({ repository: repositoryOf(url) }),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
      },
    );
  });

  it("clones as the session's owner, with their git access, and never lends the host's", async () => {
    const created: CreateOptions[] = [];
    const asked: Array<string> = [];
    // An ssh remote on a multi-tenant instance, for an owner whose git access is the bridge and
    // who shares no signer: the clone has no signer of theirs, and no other identity to use.
    const url = "ssh://git@127.0.0.1:1/owner/dots.git";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);

          expect(asked).toEqual(["git access of user-fixture"]);
          expect(created).toHaveLength(1);
          expect(created[0]?.dotfiles?.archives).toEqual([
            { data: SNAPSHOT.data, manager: "copy", bootstrap: false },
          ]);
          const launched = world.sessions.get(session.id);
          expect(launched?.status).toBe("running");
          expect(launched?.dotfiles?.notApplied).toEqual([
            {
              source: "repository",
              reason:
                "the dotfiles repository signs with your connected signer: no signer connected — run `mend keys share` on the machine that holds your key",
            },
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer({ repository: repositoryOf(url) }),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
        dotfilesClonerLayer: dotfilesClonerLayer({
          tenancy: "multi",
          gitAccess: "bridge",
          asked,
        }),
      },
    );
  });

  it("clones a public repository on a multi-tenant instance with none of the host's setup", async () => {
    const created: CreateOptions[] = [];
    const cell: { repository: DotfilesRepository | null } = { repository: null };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session } = yield* launchOnce(world, tmp);
          const url = dotfilesOrigin(tmp, project);
          cell.repository = repositoryOf(url);
          yield* engine.launch(session.id, ["codex"]);

          expect(created[0]?.dotfiles?.archives?.map(({ manager }) => manager)).toEqual([
            "stow",
            "copy",
          ]);
          expect(world.sessions.get(session.id)?.dotfiles?.notApplied).toEqual([]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(cell),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.succeed(SNAPSHOT)),
        dotfilesClonerLayer: dotfilesClonerLayer({ tenancy: "multi", ownerIsOperator: false }),
      },
    );
  });

  it("never resolves dotfiles for a project that turned them off", async () => {
    const created: CreateOptions[] = [];
    const reads: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, applyDotfiles: false }));
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(session.id, ["codex"]);

          expect(reads).toEqual([]);
          expect(created[0]?.dotfiles).toBeUndefined();
          expect(world.sessions.get(session.id)?.dotfiles).toEqual({
            repository: null,
            snapshotSha: null,
            notApplied: [],
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: userDotfilesLayer(
          { repository: repositoryOf("git://127.0.0.1:1/dots") },
          reads,
        ),
        dotfilesStoreLayer: dotfilesStoreLayer(() => Effect.die("dotfiles are off here")),
      },
    );
  });
});

const ZSH_FAMILY: LaunchImage = {
  mode: "family",
  os: "arch",
  packages: [],
  shell: "zsh",
  services: { docker: false },
};

/** A store whose snapshot per owner is whatever `snapshots` says right now; every read lands in `reads`. */
const ownedSnapshotsLayer = (
  snapshots: Map<string, { readonly sha: string; readonly data: string }>,
  reads: Array<string> = [],
): Layer.Layer<DotfilesStore> =>
  Layer.succeed(DotfilesStore, {
    snapshot: () => Effect.die("not in test"),
    current: (userId) =>
      Effect.sync(() => {
        const snapshot = snapshots.get(userId);
        return snapshot === undefined
          ? null
          : { sha: snapshot.sha, source: "laptop", committedAt: new Date(0), files: [] };
      }),
    archive: (userId) =>
      Effect.sync(() => {
        reads.push(`snapshot of ${userId}`);
        return snapshots.get(userId) ?? null;
      }),
    clear: () => Effect.void,
  });

/** The owner's repository knob per account; every read lands in `reads`. */
const ownedRepositoriesLayer = (
  repositories: Map<string, DotfilesRepository>,
  reads: Array<string> = [],
): Layer.Layer<UserDotfilesRepo> =>
  Layer.succeed(UserDotfilesRepo, {
    repository: (userId) =>
      Effect.sync(() => {
        reads.push(`repository of ${userId}`);
        return repositories.get(userId) ?? null;
      }),
    setRepository: (_userId, value) => Effect.succeed(value),
    startAgentsAfterInstall: () => Effect.succeed(false),
    setStartAgentsAfterInstall: (_userId, value) => Effect.succeed(value),
  });

describe("SessionEngine dotfiles gate", () => {
  /**
   * Dotfiles reach a workspace only when the project applies them, the image is a family image
   * (a custom base promises only a POSIX sh) and the session has an owner whose dotfiles they
   * are. Every other combination reads nothing of anyone's and sends no archive.
   */
  it.each([
    { applyDotfiles: true, image: "family", owner: "user-fixture", sent: true },
    { applyDotfiles: false, image: "family", owner: "user-fixture", sent: false },
    { applyDotfiles: true, image: "custom", owner: "user-fixture", sent: false },
    { applyDotfiles: false, image: "custom", owner: "user-fixture", sent: false },
    { applyDotfiles: true, image: "family", owner: null, sent: false },
    { applyDotfiles: false, image: "family", owner: null, sent: false },
    { applyDotfiles: true, image: "custom", owner: null, sent: false },
    { applyDotfiles: false, image: "custom", owner: null, sent: false },
  ] as const)(
    "applyDotfiles $applyDotfiles · $image image · owner $owner → dotfiles sent: $sent",
    async ({ applyDotfiles, image, owner, sent }) => {
      const created: CreateOptions[] = [];
      const reads: Array<string> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            world.projects.set(project.id, new Project({ ...project, applyDotfiles }));
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: owner,
              base: null,
            });
            const launched = yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);

            if (owner === null) {
              // Nobody to run as: the launch settles before anything of anyone's is read.
              expect(Exit.isFailure(launched)).toBe(true);
              expect(reads).toEqual([]);
              expect(created).toHaveLength(0);
              return;
            }
            expect(Exit.isSuccess(launched)).toBe(true);
            expect(created).toHaveLength(1);
            const options = created[0];
            if (image === "family") {
              expect(options?.os).toBe("arch");
              expect(options?.shell).toBe("zsh");
              expect(options?.baseImage).toBeUndefined();
            } else {
              expect(options?.baseImage).toBe("ghcr.io/acme/base:1");
              expect(options?.shell).toBeUndefined();
            }
            if (sent) {
              expect(reads).toEqual(["repository of user-fixture", "snapshot of user-fixture"]);
              expect(options?.dotfiles).toEqual({
                archives: [{ data: SNAPSHOT.data, manager: "copy", bootstrap: false }],
              });
              expect(world.sessions.get(session.id)?.dotfiles).toEqual({
                repository: null,
                snapshotSha: SNAPSHOT.sha,
                notApplied: [],
              });
            } else {
              expect(reads).toEqual([]);
              expect(options?.dotfiles).toBeUndefined();
              expect(world.sessions.get(session.id)?.dotfiles).toEqual({
                repository: null,
                snapshotSha: null,
                notApplied: [],
              });
            }
          }),
        {
          sealantLayer: sealantLaunchLayer(created),
          workspaceImage: image === "family" ? ZSH_FAMILY : CUSTOM_BASE,
          userDotfilesLayer: ownedRepositoriesLayer(new Map(), reads),
          dotfilesStoreLayer: ownedSnapshotsLayer(new Map([["user-fixture", SNAPSHOT]]), reads),
        },
      );
    },
  );

  it("a relaunch into a fresh workspace resolves the owner's dotfiles again", async () => {
    const created: CreateOptions[] = [];
    const snapshots = new Map([["user-fixture", SNAPSHOT]]);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { engine, session } = yield* launchOnce(world, tmp);
          yield* engine.launch(session.id, ["codex"]);
          expect(world.sessions.get(session.id)?.dotfiles?.snapshotSha).toBe(SNAPSHOT.sha);
          yield* engine.stop(session.id);
          const agentExited = () =>
            [...world.processes.values()].every((process) => process.exitedAt !== null);
          for (let i = 0; i < 200 && !agentExited(); i++) {
            yield* Effect.sleep(Duration.millis(10));
          }

          // The owner synced again while the session was stopped.
          snapshots.set("user-fixture", NEWER_SNAPSHOT);
          const resumed = yield* engine.resumeSession(session.id, "shell");
          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          expect(created[1]?.shell).toBe("zsh");
          expect(created[1]?.dotfiles).toEqual({
            archives: [{ data: NEWER_SNAPSHOT.data, manager: "copy", bootstrap: false }],
          });
          expect(world.sessions.get(session.id)?.dotfiles).toEqual({
            repository: null,
            snapshotSha: NEWER_SNAPSHOT.sha,
            notApplied: [],
          });
          // The shell is the image's login shell, the one those dotfiles configure.
          const live = [...world.processes.values()].filter((process) => process.exitedAt === null);
          expect(live.map((process) => process.argv)).toEqual([["zsh"]]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        workspaceImage: ZSH_FAMILY,
        dotfilesStoreLayer: ownedSnapshotsLayer(snapshots),
      },
    );
  });

  it("each owner's session launches with that owner's dotfiles and nobody else's", async () => {
    const created: CreateOptions[] = [];
    const reads: Array<string> = [];
    const otherSnapshot = { sha: "07e407e407e407e407e407e407e407e407e407e4", data: "b3RoZXI=" };
    // user-fixture keeps a repository this launch's policy refuses (no clone, no network); the
    // other owner has none, and a snapshot of their own.
    const refusedUrl = "https://metadata.google.internal/fixture-dots.git";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.members.set("user-other", "member");
          const engine = yield* SessionEngine;
          const launchAs = (ownerUserId: string) =>
            Effect.gen(function* () {
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId,
                base: null,
              });
              yield* engine.launch(session.id, ["codex"]);
              return session;
            });

          const other = yield* launchAs("user-other");
          expect(reads).toEqual(["repository of user-other", "snapshot of user-other"]);
          expect(created[0]?.dotfiles).toEqual({
            archives: [{ data: otherSnapshot.data, manager: "copy", bootstrap: false }],
          });
          expect(world.sessions.get(other.id)?.dotfiles).toEqual({
            repository: null,
            snapshotSha: otherSnapshot.sha,
            notApplied: [],
          });

          reads.length = 0;
          const fixture = yield* launchAs("user-fixture");
          expect(reads).toEqual(["repository of user-fixture", "snapshot of user-fixture"]);
          expect(created[1]?.dotfiles).toEqual({
            archives: [{ data: SNAPSHOT.data, manager: "copy", bootstrap: false }],
          });
          expect(world.sessions.get(fixture.id)?.dotfiles?.repository).toEqual({
            url: refusedUrl,
            ref: null,
          });
          expect(world.sessions.get(fixture.id)?.dotfiles?.snapshotSha).toBe(SNAPSHOT.sha);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        userDotfilesLayer: ownedRepositoriesLayer(
          new Map([["user-fixture", repositoryOf(refusedUrl)]]),
          reads,
        ),
        dotfilesStoreLayer: ownedSnapshotsLayer(
          new Map([
            ["user-fixture", SNAPSHOT],
            ["user-other", otherSnapshot],
          ]),
          reads,
        ),
      },
    );
  });
});
