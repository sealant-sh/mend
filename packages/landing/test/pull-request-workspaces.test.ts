import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { SessionProcessesRepo } from "@mend/db";
import { SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import { SessionProcess } from "@mend/domain/workbench";
import {
  SealantClient,
  SealantClients,
  type SealantClientShape,
  SealantPlatformError,
} from "@mend/sealant";
import { StoreConfig } from "@mend/store";
import type { CreateOptions, Run, Workspace, WorkspaceExecResult } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach } from "vitest";

import { PullRequestWorkspacesLive, shortLivedMountRoot } from "../src/pull-request-workspaces.ts";
import { PullRequestStepError, PullRequestWorkspaces } from "../src/pull-requests.ts";

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
    replan: async () => new Promise(() => undefined),
  },
  sessions: {
    open: async () => new Promise(() => undefined),
    get: async () => new Promise(() => undefined),
    list: async () => [],
  },
  events: async function* () {},
  forward: async () => new Promise(() => undefined),
  stop: async () => undefined,
  restart: async function () {
    return this;
  },
  expire: async () => undefined,
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
}) => {
  const created: Array<CreateOptions> = [];
  const stopped: Array<string> = [];
  const execs: Array<{ readonly workspace: string; readonly argv: ReadonlyArray<string> }> = [];
  const owners: Array<string> = [];
  const known = new Set(options.workspaces ?? []);
  const client = Effect.runSync(
    Effect.gen(function* () {
      return yield* SealantClient;
    }).pipe(
      Effect.provide(
        Layer.mock(SealantClient, {
          getWorkspace: (id) =>
            known.has(id)
              ? Effect.succeed(fakeWorkspace(id))
              : Effect.fail(
                  new SealantPlatformError({
                    code: "WorkspaceNotFoundError",
                    status: 404,
                    message: `workspace ${id} not found`,
                    cause: null,
                  }),
                ),
          createWorkspace: (createOptions) =>
            Effect.suspend(() => {
              created.push(createOptions);
              if (options.createFails !== undefined) return Effect.fail(options.createFails);
              return Effect.succeed(fakeWorkspace("ws-short"));
            }),
          stopWorkspace: (workspace) => Effect.sync(() => void stopped.push(workspace.id)),
          exec: (workspace, argv) =>
            Effect.sync(() => {
              execs.push({ workspace: workspace.id, argv });
              const result: WorkspaceExecResult = {
                exitCode: 0,
                stdout: `ran in ${workspace.id}`,
                stderr: "",
                run: execRun,
              };
              return result;
            }),
        }),
      ),
    ),
  );
  const clientFor = (userId: string): Effect.Effect<SealantClientShape> =>
    Effect.sync(() => {
      owners.push(userId);
      return client;
    });
  return { created, stopped, execs, owners, clientFor };
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
            }),
          }),
          Layer.mock(SessionProcessesRepo, {
            listForSession: () => Effect.succeed(processes),
          }),
          StoreConfig.layerFor(storeRoot),
        ),
      ),
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
        expect(platform.execs).toEqual([{ workspace: "ws-short", argv: ["gh", "--version"] }]);
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
});
