import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import {
  ProjectLinksRepo,
  ProjectLinkNotFoundError,
  ReferenceNotFoundError,
  ReferencesRepo,
  InstanceRolesRepo,
} from "@mend/db";
import { ReferenceId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  Project,
  Reference,
  ResourceName,
  SessionProcess,
  validateProjectEnvironmentName,
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
import { harnessHomePathOf } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type {
  CreateOptions,
  SessionOptions,
  WorkspacePhase,
  WorkspaceRuntimeInfo,
} from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { describe, expect } from "vitest";

import { OPENCODE_SEED } from "../src/harness-seeds.ts";
import { mendMcpFlags } from "../src/mend-mcp/launch.ts";
import { lifecycleLayer } from "./engine/capture-fixture.ts";
import { signalledFixture } from "./engine/clock-fixture.ts";
import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

describe("SessionEngine", () => {
  it.each(["claude", "codex"] as const)(
    "records the accepted workspace and launch identity for a colocated %s conversation",
    async (harness) => {
      const created: CreateOptions[] = [];
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
              start: startFromBase(null),
            });
            yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
            const live = world.sessions.get(session.id);
            expect(live?.sealantWorkspaceId).toBe("workspace-1");
            expect(live?.executorStartedAt).toBeInstanceOf(Date);
            expect(world.executorLaunches.get(session.id)).toEqual({
              workspaceId: "workspace-1",
              launchId: expect.stringContaining(`launch:${session.id}:`),
            });
          }),
        {
          sealantLayer: sealantLaunchLayer(created),
          protocolHostLayer: recordingProtocolHostLayer([], []),
        },
      );
    },
  );

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

  it.each([undefined, "0", "1"])(
    "preserves the project's Claude checklist opt-in %s through a protocol launch",
    async (optIn) => {
      const created: CreateOptions[] = [];
      const spawned: ReadonlyArray<string>[] = [];
      const opened: SessionOptions[] = [];
      const variable = "CLAUDE_CODE_ENABLE_TODO_TOOLS";
      const variables: Record<string, string> = optIn === undefined ? {} : { [variable]: optIn };
      expect(validateProjectEnvironmentName(variable)).toBeNull();
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
              { mode: "protocol", permissionMode: "ask" },
              "user-fixture",
            );
            expect(created[0]?.env?.[variable]).toBe(optIn);
            const argv = spawned[0];
            if (argv === undefined || argv[0] === undefined)
              throw new Error("Claude was not launched");
            expect(argv).toContain("claude");
            expect(argv).toContain("--print");

            // Execute the engine's complete launch command with the public SDK's workspace env
            // and process overlay. The inert Claude executable reports what reaches that process.
            const bin = path.join(tmp, "checklist-bin");
            const home = path.join(tmp, "checklist-home");
            fs.mkdirSync(bin);
            fs.mkdirSync(home);
            fs.writeFileSync(
              path.join(bin, "claude"),
              "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS ?? null));\n",
              { mode: 0o755 },
            );
            const [command, ...args] = argv;
            if (command === undefined) throw new Error("missing Claude command");
            const output = execFileSync(command, args, {
              encoding: "utf8",
              env: {
                ...created[0]?.env,
                ...opened[0]?.env,
                HOME: home,
                PATH: `${bin}:${process.env.PATH}`,
              },
            });
            expect(JSON.parse(output)).toBe(optIn ?? null);
          }),
        {
          environment: () => ({ revision: 1, variables }),
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            spawned,
            undefined,
            undefined,
            undefined,
            opened,
          ),
          protocolHostLayer: recordingProtocolHostLayer([], []),
        },
      );
    },
  );

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
          bindsAny: () => Effect.succeed(false),
          relink: () => Effect.succeed({ failed: [], atNextStart: [] }),
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

  it.each([
    ["opencode", ["opencode"], "OPENCODE_DISABLE_AUTOUPDATE=1"],
    [
      "pi",
      ["pi", "--extension", "/run/mend/bin/mend-pi-mcp.mjs", "--approve"],
      "PI_SKIP_VERSION_CHECK=1",
    ],
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
            if (harness === "opencode") {
              expect(argv).toContain('OPENCODE_PERMISSION={"*":"allow"}');
              expect(argv.some((arg) => arg.includes("OPENCODE_CONFIG_CONTENT"))).toBe(true);
              const bin = path.join(tmp, "bin");
              const home = path.join(tmp, "native-home");
              fs.mkdirSync(bin);
              fs.mkdirSync(home);
              fs.writeFileSync(
                path.join(bin, "opencode"),
                "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT), permission: JSON.parse(process.env.OPENCODE_PERMISSION) }));\n",
                { mode: 0o755 },
              );
              const [command, ...args] = argv;
              if (command === undefined) throw new Error("missing native OpenCode command");
              const output = execFileSync(command, args, {
                encoding: "utf8",
                env: { HOME: home, PATH: `${bin}:${process.env.PATH}` },
              });
              expect(JSON.parse(output)).toEqual({
                config: {
                  mcp: {
                    mend: {
                      type: "local",
                      command: ["/run/mend/bin/mend", "mcp"],
                      enabled: true,
                      timeout: 120_000,
                    },
                  },
                },
                permission: { "*": "allow" },
              });
            }
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
      requestPriority: () => "normal",
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
