import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import {
  ProjectLinksRepo,
  ProjectLinkNotFoundError,
  ReferenceNotFoundError,
  ReferencesRepo,
  AgentMemoryRepo,
  InstanceRolesRepo,
  piProfileDigest,
  agentMemoryDigest,
} from "@mend/db";
import { SealantWorkspaceId, SessionId, SessionProcessId, ReferenceId } from "@mend/domain";
import {
  PiProfile,
  presetDefinition,
  PresetVersion,
  Project,
  Reference,
  ResourceName,
  SessionProcess,
} from "@mend/domain/workbench";
import { LAUNCH_BOOTING, LAUNCH_PREPARING } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  type PrepareInput,
  ProtocolHost,
  ResourceRuntime,
  SessionEngine,
  startFromBase,
} from "@mend/sessions";
import { harnessHomePathOf, processStatePathOf } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type {
  CreateOptions,
  SessionOptions,
  WorkspacePhase,
  WorkspaceRuntimeInfo,
} from "@sealant/sdk";
import { Clock, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect";
import { describe, expect } from "vitest";

import { OPENCODE_SEED } from "../src/harness-seeds.ts";
import { mendMcpFlags } from "../src/mend-mcp/launch.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { lifecycleLayer } from "./engine/capture-fixture.ts";
import { signalledFixture } from "./engine/clock-fixture.ts";
import {
  agentMemoryLayerOf,
  launchSkill,
  now,
  piProfilesLayerOf,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  skillsForLaunchLayer,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

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
                start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
          });

          yield* engine.launch(session.id, ["codex"]);

          expect(created).toHaveLength(1);
          expect(created[0]?.os).toBe("nix");
          // Mend adds its Doppler CLI to the person's configured image packages.
          expect(created[0]?.packages).toEqual([
            "bat",
            "lazygit",
            "doppler",
            "postgresql-client",
            "redis-cli",
          ]);
          expect(created[0]?.services).toEqual({ docker: true });
          // The owner's own Claude login rides along, so the agent can run `claude` on it.
          expect(created[0]?.credentials).toEqual({ codex: true, claude: true, github: true });
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        workspaceImage: {
          mode: "family",
          os: "nix",
          packages: ["bat", "lazygit"],
          shell: "bash",
          services: { docker: true },
          screen: false,
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
            start: startFromBase(null),
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
              start: { kind: "base", base: null },
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
                  listAllForProject: () => broken,
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
            start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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
          screen: false,
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
            start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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
              start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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

  it.effect(
    "a pi follow-up in a retained workspace runs on its owner's profile, and on the one there beside a live pi",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const { world, tmp, untilChanged } = yield* signalledFixture("mend-launch-test-");
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const provision = (ownerUserId: string) =>
                engine.provision({
                  projectId: project.id,
                  harness: "pi",
                  label: null,
                  name: null,
                  ownerUserId,
                  start: { kind: "base", base: null },
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
                yield* untilChanged(() => !agentLive(), "the agent's end after the stop");
                expect(agentLive()).toBe(false);
              });
              const home = harnessHomePathOf(project.storePath, session.id);
              const profile = path.join(home, ".pi/agent/mend/profile");

              // No pi runs there: the profile the harness home holds is moved aside, as at a launch.
              yield* stopAgent;
              plantForeignPiProfile(home);
              yield* engine.launchFollowUp(session.id, "Carry on.", "follow-up:pi-1", "owner-a");
              expect(fs.existsSync(profile)).toBe(false);
              expect(
                fs.readdirSync(path.join(home, ".mend/pi-profile-kept")).length,
              ).toBeGreaterThan(0);

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
          { fixture: { world, tmp }, sealantLayer: sealantLaunchLayer(created) },
        );
      }),
  );

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
              start: { kind: "base", base: null },
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

  it.effect(
    "delivers the owner's agent memory at launch and reads back what the agent learned when it stops",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const root = ".claude/projects/-workspace-repo/memory";
        const index = { path: `${root}/MEMORY.md`, encoding: "utf8", contents: "- one\n" } as const;
        const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
        /** The stop's tail read the harness home back. */
        const readBackDone = yield* Deferred.make<void>();
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
            }).pipe(Effect.tap(() => Deferred.succeed(readBackDone, undefined))),
        });
        yield* withPreparedEngineEffect(
          (world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: null,
                ownerUserId: "owner-memory",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["claude"]);
              const home = harnessHomePathOf(project.storePath, session.id);
              expect(fs.readFileSync(path.join(home, index.path), "utf8")).toBe("- one\n");

              // The agent learned something, then the session stopped.
              fs.writeFileSync(path.join(home, root, "learned.md"), "the API listens on 3101\n");
              yield* engine.stop(session.id);
              yield* Deferred.await(readBackDone);
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
      }),
  );

  // Live clock: the carry ages the harvested conversations against the engine's now and stamps
  // the stub's mtime with the summary's time, which the filesystem keeps as a real instant (Node
  // clamps one before 1970 to now), so the engine's clock has to be the wall clock here.
  it.live(
    "carries the owner's earlier Codex conversations into a Codex launch, minus what Codex summarised (docs/adr/0009, Codex)",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const summarisedId = "11111111-1111-4111-8111-111111111111";
        const pendingId = "22222222-2222-4222-8222-222222222222";
        // The stored summary database lists one of the two conversations as summarised.
        const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-codex-db-"));
        const dbFile = path.join(dbDir, "memories_1.sqlite");
        const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
        const db = new DatabaseSync(dbFile);
        db.exec(
          "create table stage1_outputs (thread_id text primary key, source_updated_at integer not null)",
        );
        const summarisedAt = Math.floor(
          ((yield* Clock.currentTimeMillis) - 8 * 60 * 60 * 1000) / 1000,
        );
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
        yield* withPreparedEngineEffect(
          (world, dir) => setup(dir, world),
          (world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const provision = () =>
                engine.provision({
                  projectId: project.id,
                  harness: "codex",
                  label: null,
                  name: null,
                  ownerUserId: "owner-codex",
                  start: { kind: "base", base: null },
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
              // The launch carries the conversations in before it answers.
              expect(fs.existsSync(carried)).toBe(true);
              expect(
                fs
                  .readFileSync(path.join(home, ".mend/carried-transcripts"), "utf8")
                  .trim()
                  .split("\n")
                  .toSorted(),
              ).toEqual([summarisedId, pendingId].toSorted());
              // The summarised one is there as a stub: its first line, at the summary's time, so
              // Codex keeps its summary without making it again.
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
      }),
  );

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
            start: { kind: "base", base: null },
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

          expect(openedOptions).toEqual([
            { mode: "pipe", env: { MEND_AGENT_PROCESS_ID: attached[0]?.process.id } },
          ]);
          // Codex's memory is on in every Codex session Mend starts (docs/adr/0009, "Codex").
          // Its shell snapshot is off: it writes exported values into the harness home. Its
          // background server is off: it copies Codex's release into the harness home.
          expect(spawned[0]?.slice(4)).toEqual([
            "codex",
            "-c",
            "features.shell_snapshot=false",
            "-c",
            "features.daemon_auto_start=false",
            "-c",
            "features.memories=true",
            ...mendMcpFlags("codex"),
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

  it("gives the agent and a shell their worktree's resources' env, and says what the agent starts without", async () => {
    const spawned: ReadonlyArray<string>[] = [];
    const openedOptions: SessionOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const prepared: Array<PrepareInput> = [];
    const resources = {
      MEND_DB_URL: "postgres://postgres@db:5432/own_0123456789ab",
      MEND_DB_HOST: "db",
    };
    const db = presetDefinition({
      name: ResourceName.make("db"),
      preset: "postgres",
      version: PresetVersion.make("17"),
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
            start: { kind: "base", base: null },
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", prompt: "migrate", permissionMode: "ask" },
            "user-1",
          );
          expect(openedOptions[0]).toEqual({
            mode: "pipe",
            env: { ...resources, MEND_AGENT_PROCESS_ID: attached[0]?.process.id },
          });
          expect(world.sessions.get(session.id)?.summary).toContain(
            "@db · stopped by Maria · this session starts without it",
          );
          yield* engine.openShell(session.id);
          expect(openedOptions.at(-1)?.env).toMatchObject(resources);
          expect(prepared.map((input) => input.worktreeId)).toEqual([
            session.worktreeId,
            session.worktreeId,
          ]);
          expect(prepared[0]?.launcher).toBe("user-fixture");
          expect(prepared[0]?.workspaceId).not.toBe("");
        }),
      {
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          openedOptions,
        ),
        protocolHostLayer: recordingProtocolHostLayer(attached, [], []),
        resourceRuntime: Layer.succeed(ResourceRuntime, {
          ensureOwnDatabase: () => Effect.succeed(null),
          baseDatabase: () => Effect.succeed(null),
          relink: () => Effect.succeed([]),
          stoppedDependency: () => Effect.succeed(null),
          prepare: (input) =>
            Effect.sync(() => {
              prepared.push(input);
              return {
                env: resources,
                views: [
                  {
                    kind: "launched-without" as const,
                    definition: db,
                    instance: {
                      kind: "stopped" as const,
                      reason: { kind: "person" as const, by: "Maria" },
                    },
                  },
                ],
              };
            }),
          envOf: () => Effect.die("not in this test"),
          start: () => Effect.die("not in this test"),
          stop: () => Effect.die("not in this test"),
          observe: () => Effect.die("not in this test"),
          archive: () => Effect.die("not in this test"),
          reset: () => Effect.die("not in this test"),
        }),
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
            start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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

  it.effect("restores harvested state into the fresh workspace a protocol resume provisions", () =>
    Effect.gen(function* () {
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
      const { world, tmp, untilChanged, changed } = yield* signalledFixture("mend-launch-test-");
      // Every exec the engine ran wakes `untilChanged`: the settle-path harvest runs forked.
      const signallingExecs = Layer.effect(
        SealantClient,
        Effect.map(SealantClient, (client) => ({
          ...client,
          exec: (workspace, argv, options) =>
            client.exec(workspace, argv, options).pipe(Effect.ensuring(Effect.sync(changed))),
        })),
      ).pipe(
        Layer.provide(
          sealantLaunchLayer(
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
        ),
      );
      yield* withPreparedEngineEffect(
        (_world, dir) => setup(dir, world),
        (_world, _dir, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
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
            yield* untilChanged(packRan, "the harvest's pack attempt");
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
          fixture: { world, tmp },
          sealantLayer: signallingExecs,
          protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
        },
      );
    }),
  );

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
            start: { kind: "base", base: null },
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

  it.effect(
    "a caller that goes away mid-launch leaves the launch running: the agent starts and the session reads running",
    () =>
      Effect.gen(function* () {
        // Alpha 2026-09-30 (cc05cb8a, 48763b65): a client that gave up on the launch request
        // interrupted the launch wherever it stood — a running agent whose session read `starting`
        // with `started_at` null for good. The caller's interruption now ends only its own wait.
        const created: CreateOptions[] = [];
        const createAsked = yield* Deferred.make<void>();
        const createAnswered = yield* Deferred.make<void>();
        const { world, tmp, untilChanged } = yield* signalledFixture("mend-launch-test-");
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              const caller = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
              yield* Deferred.await(createAsked);
              yield* Fiber.interrupt(caller);
              expect(world.sessions.get(session.id)?.status).toBe("starting");

              yield* Deferred.succeed(createAnswered, undefined);
              yield* untilChanged(
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
            fixture: { world, tmp },
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
      }),
  );

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
            start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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

  it.effect(
    "the same in capture mode: the stop drains the executor and the agent the launch started ends with it",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const spawned: ReadonlyArray<string>[] = [];
        const openAsked = yield* Deferred.make<void>();
        const openAnswered = yield* Deferred.make<void>();
        const { world, tmp, untilChanged } = yield* signalledFixture("mend-launch-test-");
        const clock = yield* Clock.Clock;
        // The store's clock follows the engine's: a lease and its reading share one time.
        const memory = makeMemoryCaptureStore();
        memory.clock.now = () => clock.currentTimeMillisUnsafe();
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
              yield* Deferred.await(openAsked);

              yield* engine.stop(session.id);
              yield* Deferred.succeed(openAnswered, undefined);
              yield* Fiber.await(launching);
              yield* untilChanged(
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
            fixture: { world, tmp },
            captured: memory,
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
      }),
  );

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
              start: { kind: "base", base: null },
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
            start: { kind: "base", base: null },
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

  it.effect(
    "a cold launch says where it stands while the platform builds the image and boots the executor, and answers once it runs",
    () =>
      Effect.gen(function* () {
        // Alpha 2026-09-30: the first launch after an image recipe change waited ~8 min for the
        // MicroVM image build and the session line said nothing but `starting`.
        const created: CreateOptions[] = [];
        const answered = yield* Deferred.make<void>();
        let executorUp = false;
        const executor: WorkspaceRuntimeInfo = {
          kind: "microvm",
          resourceId: "microvm-1",
          reference: "microvm-1",
          status: "pending",
          deadline: null,
        };
        const { world, tmp, untilChanged } = yield* signalledFixture("mend-launch-test-");
        // The watch's pace and the window after which no executor means an image build
        // (`testDrainPolicy`), driven here one look at a time.
        const createPhaseInterval = Duration.millis(10);
        const imageBuildAfter = Duration.millis(40);
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
                        watch({
                          ...workspace,
                          runtime: async () => (executorUp ? executor : null),
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
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              const launching = yield* engine
                .launch(session.id, ["codex"])
                .pipe(Effect.forkChild({ startImmediately: true }));
              const summary = () => world.sessions.get(session.id)?.summary;
              yield* untilChanged(
                () => summary() === LAUNCH_BOOTING,
                "booting, as the create is accepted",
              );
              // No executor on the platform past `imageBuildAfter`: the image is being built. One
              // look short of the window the line still reads booting.
              const looks =
                Duration.toMillis(imageBuildAfter) / Duration.toMillis(createPhaseInterval);
              for (let look = 1; look < looks; look++) yield* TestClock.adjust(createPhaseInterval);
              expect(summary()).toBe(LAUNCH_BOOTING);
              yield* TestClock.adjust(createPhaseInterval);
              yield* untilChanged(() => summary() === LAUNCH_PREPARING, "the image build line");
              expect(world.sessions.get(session.id)?.status).toBe("starting");
              executorUp = true;
              yield* TestClock.adjust(createPhaseInterval);
              yield* untilChanged(
                () => summary() === LAUNCH_BOOTING,
                "booting, once the executor exists",
              );
              yield* Deferred.succeed(answered, undefined);
              const launched = yield* Fiber.join(launching);
              expect(launched.status).toBe("running");
              expect(summary() ?? null).toBe("codex is starting on the new machine");
            }),
          {
            fixture: { world, tmp },
            sealantLayer: watchedCreates,
            drainPolicy: { createPhaseInterval, imageBuildAfter },
          },
        );
      }),
  );

  it.effect(
    "a cold launch says Core's own launch phase: queued, building the image step by step, booting (sealant#342)",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const answered = yield* Deferred.make<void>();
        let phase: WorkspacePhase | null = { name: "queued" };
        let runtimeReads = 0;
        const { world, tmp, untilChanged } = yield* signalledFixture("mend-launch-test-");
        /** The watch's pace (`testDrainPolicy`): each look is one adjust. */
        const createPhaseInterval = Duration.millis(10);
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
        yield* withPreparedEngineEffect(
          (_world, dir) => setup(dir, world),
          (_world, _dir, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              const launching = yield* engine
                .launch(session.id, ["codex"])
                .pipe(Effect.forkChild({ startImmediately: true }));
              const summary = () => world.sessions.get(session.id)?.summary;
              // The watch is up once the create is accepted.
              yield* untilChanged(
                () => summary() === LAUNCH_BOOTING,
                "booting, as the create is accepted",
              );
              const nextLook = (expected: string, label: string) =>
                Effect.gen(function* () {
                  yield* TestClock.adjust(createPhaseInterval);
                  yield* untilChanged(() => summary() === expected, label);
                });
              yield* nextLook("queued · waiting for a worker", "queued");
              phase = {
                name: "image-build",
                imageBuild: { step: 3, steps: 12, progressAt: new Date(0).toISOString() },
              };
              yield* nextLook("building the workspace image · step 3/12", "the build's step");
              phase = {
                name: "image-build",
                imageBuild: { progressAt: new Date(0).toISOString() },
              };
              yield* nextLook("building the workspace image", "a build with no step");
              phase = { name: "boot" };
              yield* nextLook(LAUNCH_BOOTING, "booting");
              // Core said where the launch stands: the executor was never read to guess it.
              expect(runtimeReads).toBe(0);
              yield* Deferred.succeed(answered, undefined);
              const launched = yield* Fiber.join(launching);
              expect(launched.status).toBe("running");
            }),
          {
            fixture: { world, tmp },
            sealantLayer: watchedCreates,
            drainPolicy: { createPhaseInterval },
          },
        );
      }),
  );

  it("launches Claude stream-json with one provider session id", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
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
            start: { kind: "base", base: null },
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
          expect(spawned.flat().join(" ")).not.toContain("mend hook");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
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
      sendMessage: () => Effect.die("message send not in this test"),
      steerTurn: () => Effect.die("not in test"),
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
            start: { kind: "base", base: null },
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
});
