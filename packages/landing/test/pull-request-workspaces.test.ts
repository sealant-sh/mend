import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ProofArtifactsRepo, PullRequestProofUploadsRepo, SessionProcessesRepo } from "@mend/db";
import {
  ChangeId,
  CheckpointId,
  ProjectId,
  ProofArtifactId,
  ScreenId,
  Sha,
  WorktreeId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
} from "@mend/domain";
import { ProofArtifact, SessionProcess, describePullRequest } from "@mend/domain/workbench";
import {
  SealantClient,
  SealantClients,
  type SealantClientShape,
  SealantPlatformError,
} from "@mend/sealant";
import { BlobStore, StoreConfig } from "@mend/store";
import type { CreateOptions, Run, Workspace, WorkspaceExecResult } from "@sealant/sdk";
import { Deferred, Effect, Exit, Fiber, Layer, Result } from "effect";
import { afterEach, beforeEach } from "vitest";

import { gh } from "../src/gh.ts";
import { PullRequestWorkspacesLive, shortLivedMountRoot } from "../src/pull-request-workspaces.ts";
import {
  PullRequests,
  PullRequestsLive,
  type ExecOutput,
  PullRequestStepError,
  PullRequestWorkspaces,
} from "../src/pull-requests.ts";

const ok = (stdout = ""): ExecOutput => ({ exitCode: 0, stdout, stderr: "" });

const SESSION = SessionId.make("11111111-1111-1111-1111-111111111111");

const notInTest = async (): Promise<never> => new Promise(() => undefined);

/** The run an exec was recorded as; the pull request step never reads it. */
const execRun: Run = {
  id: "run-exec",
  result: { status: "completed", outcome: "completed", exitCode: 0 },
  changes: { files: [], diff: async () => "" },
  artifacts: { list: async () => [], get: async () => new Uint8Array() },
  record: {
    runId: "run-exec",
    replay: notInTest,
    commands: async () => [],
    transcript: async () => "",
    stream: async function* () {},
    timeline: async function* () {},
    scrollback: async function* () {},
    loss: notInTest,
    summary: notInTest,
    fileTreeAt: notInTest,
    processTreeAt: notInTest,
  },
  wait: async function () {
    return this;
  },
};

const fakeWorkspace = (id: string): Workspace => ({
  id,
  name: id,
  status: async () => "ready",
  runtimeDeadline: async () => null,
  runtime: async () => null,
  processUser: async () => "supported",
  sshAsRoot: async () => {},
  phase: async () => null,
  launch: undefined,
  recover: async () => new Promise(() => undefined),
  captureDrain: async () => null,
  ready: async function () {
    return this;
  },
  harness: {
    run: async () => new Promise(() => undefined),
    start: async () => new Promise(() => undefined),
    session: async () => new Promise(() => undefined),
  },
  exec: async () => new Promise(() => undefined),
  bind: async () => [],
  capture: {
    flush: async () => new Promise(() => undefined),
    status: async () => new Promise(() => undefined),
    replan: async () => new Promise(() => undefined),
  },
  sessions: {
    open: async () => new Promise(() => undefined),
    get: async () => new Promise(() => undefined),
    list: async () => [],
  },
  events: async function* () {},
  forward: async () => new Promise(() => undefined),
  stop: async () => ({ state: "stopped" }),
  restart: async function () {
    return this;
  },
  expire: async () => undefined,
  image: async () => null,
  dotfiles: { apply: async () => new Promise(() => {}) },
  credentials: {
    put: async () => new Promise(() => {}),
    release: async () => new Promise(() => {}),
    list: async () => [],
    prune: async () => new Promise(() => {}),
  },
});

const process = (overrides: Partial<SessionProcess>): SessionProcess =>
  new SessionProcess({
    id: SessionProcessId.make(crypto.randomUUID()),
    sessionId: SESSION,
    sealantWorkspaceId: SealantWorkspaceId.make("ws-old"),
    sealantSessionId: null,
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind: "agent-pty",
    harness: "claude",
    providerSessionId: null,
    protocolOptions: null,
    label: null,
    argv: [],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: new Date("2026-09-24T10:00:00Z"),
    exitedAt: null,
    updatedAt: new Date("2026-09-24T10:00:00Z"),
    ...overrides,
  });

/**
 * The platform as one owner sees it: the workspaces it holds, what was created and stopped, and
 * every exec with the workspace it ran in. Members the step never calls die if it does.
 */
const fakePlatform = (options: {
  readonly workspaces?: ReadonlyArray<string>;
  readonly createFails?: SealantPlatformError;
  readonly ownerFails?: SealantPlatformError;
  readonly lookupFails?: SealantPlatformError;
  readonly stopFails?: SealantPlatformError;
  readonly beforeCreated?: Effect.Effect<void>;
  readonly exec?: (workspace: string, argv: ReadonlyArray<string>) => ExecOutput;
}) => {
  const created: Array<CreateOptions> = [];
  const stopped: Array<string> = [];
  const execs: Array<{ readonly workspace: string; readonly argv: ReadonlyArray<string> }> = [];
  const owners: Array<string> = [];
  const lookups: Array<string> = [];
  const known = new Set(options.workspaces ?? []);
  const client = Effect.runSync(
    Effect.gen(function* () {
      return yield* SealantClient;
    }).pipe(
      Effect.provide(
        Layer.mock(SealantClient, {
          getWorkspace: (id) =>
            Effect.suspend(() => {
              lookups.push(id);
              if (options.lookupFails !== undefined) return Effect.fail(options.lookupFails);
              return known.has(id)
                ? Effect.succeed(fakeWorkspace(id))
                : Effect.fail(
                    new SealantPlatformError({
                      code: "WorkspaceNotFoundError",
                      status: 404,
                      message: `workspace ${id} not found`,
                      cause: null,
                    }),
                  );
            }),
          createWorkspace: (createOptions) =>
            Effect.suspend(() => {
              created.push(createOptions);
              if (options.createFails !== undefined) return Effect.fail(options.createFails);
              return (options.beforeCreated ?? Effect.void).pipe(
                Effect.as(fakeWorkspace("ws-short")),
              );
            }),
          stopWorkspace: (workspace) =>
            Effect.suspend(() => {
              stopped.push(workspace.id);
              return options.stopFails === undefined
                ? Effect.succeed({ state: "stopped" as const, retained: null, completion: null })
                : Effect.fail(options.stopFails);
            }),
          exec: (workspace, argv) =>
            Effect.sync(() => {
              execs.push({ workspace: workspace.id, argv });
              const result: WorkspaceExecResult = {
                exitCode: 0,
                stdout: argv.includes("--help") ? "--attach file" : `ran in ${workspace.id}`,
                stderr: "",
                run: execRun,
              };
              return { ...result, ...options.exec?.(workspace.id, argv) };
            }),
        }),
      ),
    ),
  );
  const clientFor = (userId: string): Effect.Effect<SealantClientShape, SealantPlatformError> =>
    Effect.suspend(() => {
      owners.push(userId);
      return options.ownerFails === undefined
        ? Effect.succeed(client)
        : Effect.fail(options.ownerFails);
    });
  return { created, stopped, execs, owners, lookups, clientFor };
};

describe("PullRequestWorkspacesLive", () => {
  let storeRoot: string;
  beforeEach(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mend-pr-workspaces-"));
  });
  afterEach(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  const layerFor = (
    platform: ReturnType<typeof fakePlatform>,
    processes: ReadonlyArray<SessionProcess>,
  ) =>
    PullRequestWorkspacesLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(SealantClients, {
            forUser: platform.clientFor,
            connectedAccounts: () => ({
              list: () => Effect.die("not in this test"),
              connect: () => Effect.die("not in this test"),
              disconnect: () => Effect.die("not in this test"),
            }),
            sshKeys: () => ({
              ensure: () => Effect.die("not in this test"),
              list: () => Effect.die("not in this test"),
              remove: () => Effect.die("not in this test"),
            }),
          }),
          Layer.mock(SessionProcessesRepo, {
            listForSession: () => Effect.succeed(processes),
          }),
          StoreConfig.layerFor(storeRoot),
        ),
      ),
    );

  for (const scenario of ["no login", "no attach", "authenticated", "stopped", "plain"] as const) {
    for (const previous of [null, 42]) {
      it.effect(
        `${scenario}: ${previous === null ? "opens" : "updates"} and delivers proof in one selected workspace`,
        () => {
          const bytes = Buffer.from("screenshot bytes");
          const hash = createHash("sha256").update(bytes).digest("hex");
          const files = new Map<string, Buffer>();
          let body = "Person's introduction";
          const platform = fakePlatform({
            workspaces: ["ws-old"],
            exec: (workspace, argv) => {
              if (argv.includes("auth"))
                return workspace === "ws-old" && (scenario === "no login" || scenario === "plain")
                  ? { exitCode: 1, stdout: "", stderr: "gh auth login" }
                  : ok("authenticated");
              if (argv.includes("--help"))
                return ok(
                  workspace === "ws-old" && scenario === "no attach" ? "old help" : "--attach file",
                );
              if (workspace === "ws-old" && (scenario === "no login" || scenario === "plain"))
                return {
                  exitCode: 1,
                  stdout: "",
                  stderr: "To get started with GitHub CLI, please run: gh auth login",
                };
              if (argv[0] === "mkdir" || argv[0] === "rm") return ok();
              if (argv[0] === "sh") {
                files.set(argv[4] ?? "", Buffer.from(argv.slice(5).join(""), "base64"));
                return ok();
              }
              if (argv[0] === "sha256sum") return ok(`${hash} file`);
              if (argv.includes("list")) return ok("[]");
              if (argv.includes("view"))
                return ok(
                  JSON.stringify({
                    number: 42,
                    url: "https://github.com/acme/api/pull/42",
                    state: "OPEN",
                    title: "Board",
                    body,
                  }),
                );
              if (argv.includes("edit") || argv.includes("create")) {
                const file =
                  argv
                    .find((word) => word.startsWith("--body-file="))
                    ?.slice("--body-file=".length) ?? "";
                body = files.get(file)?.toString("utf8") ?? "";
                for (const word of argv.filter((argument) => argument.startsWith("--attach="))) {
                  const attached = word.slice("--attach=".length);
                  expect(files.get(attached)).toEqual(bytes);
                  body = body.replaceAll(
                    attached,
                    "https://github.com/user-attachments/assets/capture",
                  );
                }
                return ok("https://github.com/acme/api/pull/42");
              }
              throw new Error(`unexpected command ${argv.join(" ")}`);
            },
          });
          const changeId = ChangeId.make("change");
          const artifact = new ProofArtifact({
            id: ProofArtifactId.make("capture"),
            changeId,
            worktreeId: WorktreeId.make("worktree"),
            projectId: ProjectId.make("project"),
            sessionId: SESSION,
            turnId: null,
            title: "Board",
            caption: "Board observed",
            source: {
              _tag: "Checkpoint",
              checkpointId: CheckpointId.make("checkpoint"),
              ordinal: 2,
              commit: Sha.make("a".repeat(40)),
            },
            capture: {
              _tag: "Screenshot",
              moment: { screenId: ScreenId.make("screen"), seq: 1 },
              media: {
                blobKey: "capture",
                bytes: bytes.length,
                sha256: hash,
                mimeType: "image/png",
              },
            },
            launch: null,
            differences: null,
            observedFrom: new Date(0),
            observedTo: new Date(0),
            createdAt: new Date(0),
          });
          const layer = PullRequestsLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                layerFor(platform, scenario === "stopped" ? [] : [process({})]),
                Layer.mock(ProofArtifactsRepo, {
                  listForChange: () => Effect.succeed(scenario === "plain" ? [] : [artifact]),
                }),
                Layer.mock(PullRequestProofUploadsRepo, {
                  listForChange: () => Effect.succeed([]),
                  record: () => Effect.void,
                }),
                Layer.mock(BlobStore, { identity: "proof", get: () => Effect.succeed(bytes) }),
              ),
            ),
          );
          return Effect.gen(function* () {
            const result = yield* (yield* PullRequests).publish({
              target: { ownerUserId: "ada", sessionId: SESSION },
              repository: { owner: "acme", name: "api", slug: "acme/api" },
              head: "mend/board",
              base: "main",
              title: "Board",
              titleGiven: false,
              body: null,
              previous,
              section: describePullRequest({
                tour: null,
                files: [],
                checks: [],
                checkpoint: null,
                links: { session: null, review: null, checkpoint: null },
              }),
              ...(scenario === "plain" ? {} : { proof: { changeId, checkpointOrdinal: 2 } }),
            });
            const chosen = scenario === "authenticated" ? "ws-old" : "ws-short";
            expect(result.workspace).toBe(scenario === "authenticated" ? "session" : "short-lived");
            expect(result.action).toBe(previous === null ? "opened" : "updated");
            expect(result.media).toEqual({
              delivered: scenario === "plain" ? 0 : 1,
              reused: 0,
              failed: [],
            });
            if (scenario !== "plain")
              expect(body).toContain("https://github.com/user-attachments/assets/capture");
            const operations = platform.execs.filter(
              ({ argv }) => !argv.includes("auth") && !argv.includes("--help"),
            );
            expect(operations.length).toBeGreaterThan(0);
            expect(operations.every(({ workspace }) => workspace === chosen)).toBe(true);
            for (const workspace of new Set(platform.execs.map((entry) => entry.workspace))) {
              expect(
                platform.execs.filter(
                  (entry) => entry.workspace === workspace && entry.argv.includes("auth"),
                ),
              ).toHaveLength(1);
              expect(
                platform.execs.filter(
                  (entry) => entry.workspace === workspace && entry.argv.includes("--help"),
                ).length,
              ).toBeLessThanOrEqual(1);
            }
            expect(platform.created).toHaveLength(scenario === "authenticated" ? 0 : 1);
            expect(platform.stopped).toEqual(scenario === "authenticated" ? [] : ["ws-short"]);
          }).pipe(Effect.provide(layer));
        },
      );
    }
  }

  it.effect(
    "reports the owner's missing GitHub login when the fallback cannot authenticate",
    () => {
      const platform = fakePlatform({
        workspaces: ["ws-old"],
        exec: (_workspace, argv) =>
          argv.includes("auth")
            ? { exitCode: 1, stdout: "private auth output", stderr: "private auth error" }
            : { exitCode: 0, stdout: "--attach file", stderr: "" },
      });
      return Effect.gen(function* () {
        let used = false;
        const error = yield* (yield* PullRequestWorkspaces)
          .within({ ownerUserId: "ada", sessionId: SESSION }, () =>
            Effect.sync(() => {
              used = true;
            }),
          )
          .pipe(Effect.flip);
        expect(error.message).toBe("no GitHub account connected for the owner · gh auth login");
        expect(used).toBe(false);
        expect(platform.created).toHaveLength(1);
        expect(platform.stopped).toEqual(["ws-short"]);
        expect(platform.execs.every(({ argv }) => argv.includes("auth"))).toBe(true);
      }).pipe(Effect.provide(layerFor(platform, [process({})])));
    },
  );

  it.effect("runs in the session's live workspace, the newest live process's", () => {
    const platform = fakePlatform({ workspaces: ["ws-old", "ws-live"] });
    const processes = [
      process({ sealantWorkspaceId: SealantWorkspaceId.make("ws-old") }),
      process({
        sealantWorkspaceId: SealantWorkspaceId.make("ws-live"),
        kind: "shell",
        createdAt: new Date("2026-09-24T11:00:00Z"),
      }),
      process({
        sealantWorkspaceId: SealantWorkspaceId.make("ws-ended"),
        createdAt: new Date("2026-09-24T12:00:00Z"),
        status: "exited",
        exitedAt: new Date("2026-09-24T12:05:00Z"),
      }),
    ];
    return Effect.gen(function* () {
      const output = yield* (yield* PullRequestWorkspaces).within(
        { ownerUserId: "ada", sessionId: SESSION },
        (workspace) =>
          workspace
            .exec(["gh", "--version"])
            .pipe(Effect.map((result) => ({ kind: workspace.kind, stdout: result.stdout }))),
      );
      expect(output).toEqual({ kind: "session", stdout: "ran in ws-live" });
      expect(platform.created).toEqual([]);
      expect(platform.stopped).toEqual([]);
      expect(platform.owners).toEqual(["ada"]);
    }).pipe(Effect.provide(layerFor(platform, processes)));
  });

  it.effect(
    "otherwise makes a short-lived workspace with the GitHub account and nothing else, and stops it",
    () => {
      const platform = fakePlatform({});
      return Effect.gen(function* () {
        const kind = yield* (yield* PullRequestWorkspaces).within(
          { ownerUserId: "ada", sessionId: SESSION },
          (workspace) => workspace.exec(["gh", "--version"]).pipe(Effect.as(workspace.kind)),
        );
        expect(kind).toBe("short-lived");
        expect(platform.created).toHaveLength(1);
        const [options] = platform.created;
        expect(options?.credentials).toEqual({ github: true });
        expect(options?.source?.kind).toBe("mount");
        expect(options?.dotfiles).toBeUndefined();
        expect(options?.env).toBeUndefined();
        expect(options?.secretEnv).toBeUndefined();
        expect(options?.mounts).toBeUndefined();
        expect(options?.packages).toEqual(["github-cli"]);
        expect(options?.ttl).toBe("10m");
        const mount = options?.source?.kind === "mount" ? options.source.path : "";
        expect(path.dirname(mount)).toBe(shortLivedMountRoot(storeRoot));
        expect(platform.execs).toEqual([
          {
            workspace: "ws-short",
            argv: [
              "sh",
              "-c",
              'exec "$@" >/dev/null 2>&1',
              "sh",
              ...gh(["auth", "status", "--hostname", "github.com"]),
            ],
          },
          { workspace: "ws-short", argv: gh(["pr", "edit", "--help"]) },
          { workspace: "ws-short", argv: ["gh", "--version"] },
        ]);
        expect(platform.stopped).toEqual(["ws-short"]);
        // The empty directory it mounted is gone too.
        expect(fs.existsSync(mount)).toBe(false);
      }).pipe(Effect.provide(layerFor(platform, [])));
    },
  );

  it.effect("falls back to a short-lived workspace when the live one is gone", () => {
    const platform = fakePlatform({});
    return Effect.gen(function* () {
      const kind = yield* (yield* PullRequestWorkspaces).within(
        { ownerUserId: "ada", sessionId: SESSION },
        (workspace) => Effect.succeed(workspace.kind),
      );
      expect(kind).toBe("short-lived");
      expect(platform.stopped).toEqual(["ws-short"]);
    }).pipe(Effect.provide(layerFor(platform, [process({})])));
  });

  it.effect("stops the short-lived workspace when the work in it fails", () => {
    const platform = fakePlatform({});
    return Effect.gen(function* () {
      const error = yield* (yield* PullRequestWorkspaces)
        .within({ ownerUserId: "ada", sessionId: null }, () =>
          Effect.fail(new PullRequestStepError({ message: "gh pr create · refused" })),
        )
        .pipe(Effect.flip);
      expect(error.message).toBe("gh pr create · refused");
      expect(platform.stopped).toEqual(["ws-short"]);
      expect(fs.readdirSync(shortLivedMountRoot(storeRoot))).toEqual([]);
    }).pipe(Effect.provide(layerFor(platform, [])));
  });

  it.effect("says so when the owner has no GitHub account connected", () => {
    const platform = fakePlatform({
      createFails: new SealantPlatformError({
        code: "connected-account-not-found",
        status: 400,
        message: "connected account was not found",
        cause: null,
      }),
    });
    return Effect.gen(function* () {
      const error = yield* (yield* PullRequestWorkspaces)
        .within({ ownerUserId: "ada", sessionId: null }, () => Effect.void)
        .pipe(Effect.flip);
      expect(error.message).toBe(
        "no GitHub account connected for the owner · connected account was not found",
      );
      expect(platform.stopped).toEqual([]);
      expect(fs.readdirSync(shortLivedMountRoot(storeRoot))).toEqual([]);
    }).pipe(Effect.provide(layerFor(platform, [])));
  });

  for (const scenario of ["no session", "no live process", "stale workspace"] as const) {
    it.effect(`liveOnly refuses ${scenario} without allocating a workspace`, () => {
      const platform = fakePlatform({});
      return Effect.gen(function* () {
        let used = false;
        const failure = yield* (yield* PullRequestWorkspaces)
          .within(
            {
              ownerUserId: "ada",
              sessionId: scenario === "no session" ? null : SESSION,
              liveOnly: true,
            },
            () =>
              Effect.sync(() => {
                used = true;
              }),
          )
          .pipe(Effect.flip);
        expect(failure).toEqual(
          new PullRequestStepError({ message: "the session has no live workspace to ask gh in" }),
        );
        expect(used).toBe(false);
        expect(platform.owners).toEqual(["ada"]);
        expect(platform.lookups).toEqual(scenario === "stale workspace" ? ["ws-old"] : []);
        expect(platform.created).toEqual([]);
        expect(platform.stopped).toEqual([]);
        expect(fs.existsSync(shortLivedMountRoot(storeRoot))).toBe(false);
      }).pipe(
        Effect.provide(layerFor(platform, scenario === "stale workspace" ? [process({})] : [])),
      );
    });
  }

  it.effect("refuses an unavailable owner account before lookup, allocation or use", () => {
    const platform = fakePlatform({
      ownerFails: new SealantPlatformError({
        code: "AccountUnavailable",
        status: 403,
        message: "owner account unavailable",
        cause: null,
      }),
    });
    return Effect.gen(function* () {
      let used = false;
      const failure = yield* (yield* PullRequestWorkspaces)
        .within({ ownerUserId: "ada", sessionId: SESSION }, () =>
          Effect.sync(() => {
            used = true;
          }),
        )
        .pipe(Effect.flip);
      expect(failure.message).toBe("the owner's platform account · owner account unavailable");
      expect(used).toBe(false);
      expect(platform.owners).toEqual(["ada"]);
      expect(platform.lookups).toEqual([]);
      expect(platform.created).toEqual([]);
      expect(platform.stopped).toEqual([]);
      expect(fs.existsSync(shortLivedMountRoot(storeRoot))).toBe(false);
    }).pipe(Effect.provide(layerFor(platform, [process({})])));
  });

  for (const liveOnly of [false, true]) {
    it.effect(
      `a transient workspace lookup failure ${liveOnly ? "refuses liveOnly" : "uses the owner's short-lived fallback"}`,
      () => {
        const platform = fakePlatform({
          lookupFails: new SealantPlatformError({
            code: "Unavailable",
            status: 503,
            message: "workspace lookup unavailable",
            cause: null,
          }),
        });
        return Effect.gen(function* () {
          const outcome = yield* (yield* PullRequestWorkspaces)
            .within({ ownerUserId: "ada", sessionId: SESSION, liveOnly }, (workspace) =>
              workspace.exec(["gh", "--version"]),
            )
            .pipe(Effect.result);
          if (liveOnly) {
            expect(outcome).toEqual(
              Result.fail(
                new PullRequestStepError({
                  message: "the session has no live workspace to ask gh in",
                }),
              ),
            );
            expect(platform.created).toEqual([]);
            expect(platform.stopped).toEqual([]);
            expect(platform.execs).toEqual([]);
            expect(fs.existsSync(shortLivedMountRoot(storeRoot))).toBe(false);
          } else {
            expect(outcome).toEqual(
              Result.succeed({ exitCode: 0, stdout: "ran in ws-short", stderr: "" }),
            );
            expect(platform.created).toHaveLength(1);
            expect(platform.stopped).toEqual(["ws-short"]);
            expect(platform.execs).toEqual([
              {
                workspace: "ws-short",
                argv: [
                  "sh",
                  "-c",
                  'exec "$@" >/dev/null 2>&1',
                  "sh",
                  ...gh(["auth", "status", "--hostname", "github.com"]),
                ],
              },
              { workspace: "ws-short", argv: gh(["pr", "edit", "--help"]) },
              { workspace: "ws-short", argv: ["gh", "--version"] },
            ]);
            expect(fs.readdirSync(shortLivedMountRoot(storeRoot))).toEqual([]);
          }
          expect(platform.owners).toEqual(["ada"]);
          expect(platform.lookups).toEqual(["ws-old"]);
        }).pipe(Effect.provide(layerFor(platform, [process({})])));
      },
    );
  }

  for (const outcome of ["success", "failure", "interrupt"] as const) {
    it.effect(`a failed Stop preserves ${outcome} and removes the acquired mount`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const platform = fakePlatform({
          stopFails: new SealantPlatformError({
            code: "Unavailable",
            status: 503,
            message: "stop unavailable",
            cause: null,
          }),
        });
        const original = new PullRequestStepError({ message: "original work failure" });
        const fiber = yield* Effect.gen(function* () {
          return yield* (yield* PullRequestWorkspaces).within(
            { ownerUserId: "ada", sessionId: null },
            () =>
              Effect.gen(function* () {
                const source = platform.created[0]?.source;
                if (source?.kind !== "mount") throw new Error("missing acquired mount");
                expect(fs.statSync(source.path).isDirectory()).toBe(true);
                yield* Deferred.succeed(entered, undefined);
                if (outcome === "failure") return yield* original;
                if (outcome === "interrupt") return yield* Effect.never;
                return "completed work";
              }),
          );
        }).pipe(Effect.provide(layerFor(platform, [])), Effect.forkChild);
        yield* Deferred.await(entered);
        if (outcome === "interrupt") yield* Fiber.interrupt(fiber);
        const result = yield* Fiber.await(fiber);
        if (outcome === "interrupt") expect(Exit.hasInterrupts(result)).toBe(true);
        else
          expect(result).toEqual(
            outcome === "success" ? Exit.succeed("completed work") : Exit.fail(original),
          );
        expect(platform.created).toHaveLength(1);
        expect(platform.stopped).toEqual(["ws-short"]);
        expect(fs.readdirSync(shortLivedMountRoot(storeRoot))).toEqual([]);
      }),
    );
  }

  it.effect("interruption during use stops the acquired workspace and removes its mount", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const platform = fakePlatform({});
      const fiber = yield* Effect.gen(function* () {
        return yield* (yield* PullRequestWorkspaces).within(
          { ownerUserId: "ada", sessionId: null },
          () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        );
      }).pipe(Effect.provide(layerFor(platform, [])), Effect.forkChild);
      yield* Deferred.await(entered);
      const source = platform.created[0]?.source;
      if (source?.kind !== "mount") throw new Error("missing acquired mount");
      expect(fs.statSync(source.path).isDirectory()).toBe(true);
      expect(platform.stopped).toEqual([]);
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(platform.stopped).toEqual(["ws-short"]);
      expect(fs.existsSync(source.path)).toBe(false);
      expect(fs.readdirSync(shortLivedMountRoot(storeRoot))).toEqual([]);
    }),
  );

  it.effect(
    "interruption waits for acquisition acknowledgement before stopping and removing its mount",
    () =>
      Effect.gen(function* () {
        const creating = yield* Deferred.make<void>();
        const acknowledge = yield* Deferred.make<void>();
        const platform = fakePlatform({
          beforeCreated: Deferred.succeed(creating, undefined).pipe(
            Effect.andThen(Deferred.await(acknowledge)),
          ),
        });
        let used = false;
        const fiber = yield* Effect.gen(function* () {
          return yield* (yield* PullRequestWorkspaces).within(
            { ownerUserId: "ada", sessionId: null },
            () =>
              Effect.sync(() => {
                used = true;
              }),
          );
        }).pipe(Effect.provide(layerFor(platform, [])), Effect.forkChild);
        yield* Deferred.await(creating);
        const cancelling = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Effect.gen(function* () {
          yield* Effect.yieldNow;
          const source = platform.created[0]?.source;
          if (source?.kind !== "mount") throw new Error("missing requested mount");
          expect(fs.statSync(source.path).isDirectory()).toBe(true);
          expect(platform.stopped).toEqual([]);
          expect(used).toBe(false);
        }).pipe(Effect.ensuring(Deferred.succeed(acknowledge, undefined)));
        yield* Fiber.join(cancelling);
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        expect(used).toBe(false);
        expect(platform.stopped).toEqual(["ws-short"]);
        expect(fs.readdirSync(shortLivedMountRoot(storeRoot))).toEqual([]);
      }),
  );
});
