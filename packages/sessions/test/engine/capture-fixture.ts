import * as fs from "node:fs";
import * as path from "node:path";

import { CaptureStoreRepo, HotWorkspacesRepo } from "@mend/db";
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
} from "@mend/domain";
import {
  HotWorkspace,
  Project,
  RepositoryCloneUrl,
  Session,
  SessionProcess,
  SessionRun,
} from "@mend/domain/workbench";
import { type CaptureCompletionSeal, CaptureSeals, SessionEngine } from "@mend/sessions";
import {
  BlobStoreFsLive,
  type CaptureKind,
  captureKeys,
  DotfilesStore,
  type GitSection,
  decodeManifest,
} from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import type { CreateOptions, WorkspaceCaptureStatus } from "@sealant/sdk";
import { Cause, Duration, Effect, Exit, Layer, Schedule } from "effect";

import { type MemoryCaptureStore } from ".././capture-store-memory.ts";
import { captureAnswer, now, sealantLaunchLayer, setup, type World } from "./fixture.ts";

/** The exec that writes Mend's default shell profile where no file exists (`shell-profile.ts`). */
export const isShellProfileExec = (argv: ReadonlyArray<string>): boolean =>
  argv[3] === "mend-write-absent";

/** Shared shipHarnessCapture fixture for engine scenarios. */
export const shipHarnessCapture = (
  tmp: string,
  memory: MemoryCaptureStore,
  worktreeId: WorktreeId,
  epoch: number,
  rolloutId: string,
  kind: CaptureKind = "turn",
) =>
  shipCaptureFiles(
    tmp,
    memory,
    worktreeId,
    epoch,
    {
      [`harness/.codex/sessions/2026/09/12/rollout-2026-09-12T10-00-00-${rolloutId}.jsonl`]: `${JSON.stringify(
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "text", text: "go on" }] },
        },
      )}\n`,
    },
    kind,
  );

export const shipCaptureFiles = (
  tmp: string,
  memory: MemoryCaptureStore,
  worktreeId: WorktreeId,
  epoch: number,
  files: Readonly<Record<string, string>>,
  kind: CaptureKind = "turn",
) =>
  Effect.gen(function* () {
    const chain = memory.chains.get(worktreeId);
    const head = chain?.headCapture === null || chain === undefined ? null : chain.headCapture;
    const parent = head === null ? null : (memory.captures.get(head) ?? null);
    const tree = path.join(tmp, `ship-${epoch}`);
    for (const [at, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tree, at)), { recursive: true });
      fs.writeFileSync(path.join(tree, at), content);
    }
    const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, epoch), { chunkSize: 64 });
    const built = buildManifest({
      worktreeId,
      n: (parent?.n ?? -1) + 1,
      parent: parent?.id ?? null,
      epoch,
      seq: 100,
      kind,
      git: {
        packs: parent === null ? [] : (parent.sections as { git: { packs: string[] } }).git.packs,
        refs: {},
        head: "refs/heads/main",
        fsck: "verified",
      },
      workspace: { root: snapshot.root, packs: snapshot.packs },
      // A final flush snapshots the bulk class too (empty here): its section is never pending.
      ...(kind === "final" ? { bulk: { root: "", packs: [], platform: "linux-x86_64" } } : {}),
    });
    yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
      Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
    );
    const repo = yield* CaptureStoreRepo;
    yield* repo.register({
      worktreeId,
      id: built.id,
      n: built.manifest.n,
      parent: built.manifest.parent,
      epoch,
      seq: 100n,
      kind,
      manifestKey: built.key,
      sections: built.manifest.sections,
      gitFsck: "verified",
    });
    return built;
  }).pipe(Effect.provide(memory.layer));

/** Map the public executor path selected on the capture source into this test executor's root. */
export const configuredHarnessHomePath = (options: CreateOptions, executorRoot: string): string => {
  const source = options.source;
  if (source?.kind !== "capture" || source.harnessHome === undefined) {
    throw new Error("capture source did not select a harness root");
  }
  if (!path.isAbsolute(source.harnessHome)) {
    throw new Error("capture source selected a relative harness root");
  }
  return path.join(executorRoot, source.harnessHome.slice(1));
};

/** Snapshot only the actual daemon-selected root, including daemon credential exclusions. */
export const shipCapturedHarnessHome = (
  tmp: string,
  memory: MemoryCaptureStore,
  worktreeId: WorktreeId,
  epoch: number,
  options: CreateOptions,
  executorRoot: string,
) =>
  Effect.gen(function* () {
    const chain = memory.chains.get(worktreeId);
    const head = chain?.headCapture === null || chain === undefined ? null : chain.headCapture;
    const parent = head === null ? null : (memory.captures.get(head) ?? null);
    const tree = path.join(tmp, `ship-harness-home-${epoch}`);
    fs.rmSync(tree, { recursive: true, force: true });
    fs.mkdirSync(tree, { recursive: true });
    // Real mtimes, as sealantd records them: the external-agent observer reads them.
    fs.cpSync(configuredHarnessHomePath(options, executorRoot), path.join(tree, "harness"), {
      recursive: true,
      preserveTimestamps: true,
    });
    fs.rmSync(path.join(tree, "harness", ".codex", "auth.json"), { force: true });
    fs.rmSync(path.join(tree, "harness", ".claude", ".credentials.json"), { force: true });
    const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, epoch), { chunkSize: 64 });
    const previousGit: GitSection =
      parent === null
        ? { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" }
        : (yield* decodeManifest(
            parent.manifestKey,
            new Uint8Array(fs.readFileSync(path.join(tmp, "blobs", parent.manifestKey))),
          ).pipe(Effect.orDie)).sections.git;
    const built = buildManifest({
      worktreeId,
      n: (parent?.n ?? -1) + 1,
      parent: parent?.id ?? null,
      epoch,
      seq: 100,
      kind: "final",
      git: previousGit,
      workspace: { root: snapshot.root, packs: snapshot.packs },
    });
    yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
      Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
    );
    const repo = yield* CaptureStoreRepo;
    yield* repo.register({
      worktreeId,
      id: built.id,
      n: built.manifest.n,
      parent: built.manifest.parent,
      epoch,
      seq: 100n,
      kind: "final",
      manifestKey: built.key,
      sections: built.manifest.sections,
      gitFsck: "verified",
    });
    return built;
  }).pipe(Effect.provide(memory.layer));

/** Poll a forked side effect (a warm, a replacement) into view; the pool fakes are in memory. */
/**
 * Where the worktree's head stands, as an executor's caught-up flush reports it: its lease's epoch
 * and the head's chain position. A memory hand-over settles only on such an answer.
 */
export const headReport = (memory: MemoryCaptureStore): Partial<WorkspaceCaptureStatus> => {
  const [worktreeId, chain] = [...memory.chains.entries()][0] ?? [];
  const head =
    chain?.headCapture === null || chain?.headCapture === undefined
      ? undefined
      : memory.captures.get(chain.headCapture);
  return {
    epoch: worktreeId === undefined ? 0 : (memory.leases.get(worktreeId)?.epoch ?? 0),
    ...(head === undefined ? {} : { headN: head.n }),
  };
};

/** A flush that answers caught up at the worktree's head (`headReport`). */
export const headFlush = (memory: MemoryCaptureStore) => () =>
  Effect.sync(() => captureAnswer(headReport(memory)));

/** Shared until fixture for engine scenarios. */
export const until = (condition: () => boolean, label: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500 && !condition(); i++) yield* Effect.sleep(Duration.millis(10));
    if (!condition()) throw new Error(`timed out waiting for ${label}`);
  });

/** What a failed exit says, for assertions about refusal messages. */
export const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";

/**
 * An in-memory pool with a working `create`: the reconcile warms real standbys here (their
 * capture source lands in `created`), and a claim pops a ready entry whose fingerprint the
 * engine computed from the same inputs.
 */
export const memoryHotPool = () => {
  const entries: Array<HotWorkspace> = [];
  const update = (id: string, patch: Partial<HotWorkspace>) =>
    Effect.sync(() => {
      const index = entries.findIndex((entry) => entry.id === id);
      const current = entries[index];
      if (current !== undefined) {
        entries[index] = new HotWorkspace({ ...current, ...patch, updatedAt: now() });
      }
    });
  const layer = Layer.succeed(HotWorkspacesRepo, {
    create: (input) =>
      Effect.sync(() => {
        const entry = new HotWorkspace({
          ...input,
          status: "warming",
          remoteSsh: "not-taken",
          error: null,
          sealantWorkspaceId: null,
          workspaceImage: null,
          dotfiles: null,
          environment: null,
          referenceMounts: [],
          extraMounts: [],
          createdAt: now(),
          updatedAt: now(),
        });
        entries.push(entry);
        return entry;
      }),
    byId: (id) => Effect.sync(() => entries.find((entry) => entry.id === id) ?? null),
    listForProject: (projectId) =>
      Effect.sync(() => entries.filter((entry) => entry.projectId === projectId)),
    listAll: () => Effect.sync(() => [...entries]),
    setReady: (id, stamps) => update(id, { ...stamps, status: "ready", error: null }),
    setBaseSha: (id, baseSha) => update(id, { baseSha }),
    setFailed: (id, error) => update(id, { status: "failed", error }),
    claim: (projectId, fingerprint, ownerUserId) =>
      Effect.sync(() => {
        const index = entries.findIndex(
          (entry) =>
            entry.projectId === projectId &&
            entry.status === "ready" &&
            entry.fingerprint === fingerprint &&
            entry.ownerUserId === ownerUserId,
        );
        const entry = entries[index];
        if (entry === undefined) return null;
        const claimed = new HotWorkspace({ ...entry, status: "claimed", updatedAt: now() });
        entries[index] = claimed;
        return claimed;
      }),
    remove: (id) =>
      Effect.sync(() => {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index >= 0) entries.splice(index, 1);
      }),
  });
  return { entries, layer };
};

/** Shared dotfilesStoreLayer fixture for engine scenarios. */
export const dotfilesStoreLayer = (
  archive: DotfilesStore["Service"]["archive"],
): Layer.Layer<DotfilesStore> =>
  Layer.succeed(DotfilesStore, {
    snapshot: () => Effect.die("not in test"),
    current: () => Effect.succeed(null),
    archive,
    clear: () => Effect.void,
  });

/** Stored dotfiles snapshot used by engine delivery scenarios. */
export const SNAPSHOT = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };

/** Shared launchOnce fixture for engine scenarios. */
export const launchOnce = (world: World, tmp: string) =>
  Effect.gen(function* () {
    const project = yield* setup(tmp, world);
    return { project, ...(yield* provisionIn(project)) };
  });

/** `launchOnce` after its `setup`: the half that needs the engine (`withPreparedEngineEffect`). */
export const provisionIn = (project: Project) =>
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
    return { engine, session };
  });

/** A flush answer with `pending` left; the lifetime counters grow with every capture shipped. */
export const flushReport = (
  pending: number,
  shipped: number,
  extra: Partial<WorkspaceCaptureStatus> = {},
): WorkspaceCaptureStatus =>
  captureAnswer({
    epoch: 2,
    pending,
    uploadedObjects: shipped,
    uploadedBytes: shipped * 1000,
    registered: shipped,
    ...extra,
  });

/** Shared leaseHeld fixture for engine scenarios. */
export const leaseHeld = (memory: MemoryCaptureStore, worktreeId: string, sessionId: string) => {
  const lease = memory.leases.get(worktreeId);
  return (
    lease !== undefined &&
    lease.executorId === sessionId &&
    lease.expiresAt !== null &&
    lease.expiresAt > memory.clock.now()
  );
};

/** Shared LaunchImage fixture for engine scenarios. */
export type LaunchImage = typeof defaultSettings.workspaceImage;

/** Shared CUSTOM_BASE fixture for engine scenarios. */
export const CUSTOM_BASE = {
  mode: "custom",
  baseImage: "ghcr.io/acme/base:1",
  packages: [],
  setupCommands: [],
  services: { docker: false },
} satisfies LaunchImage;

/** Distinct later dotfiles snapshot used by invalidation scenarios. */
export const NEWER_SNAPSHOT = { sha: "0dd50dd50dd50dd50dd50dd50dd50dd50dd50dd5", data: "bmV3ZXI=" };

/** Shared lifecycleLayer fixture for engine scenarios. */
export const lifecycleLayer = (
  created: Array<CreateOptions>,
  knobs: {
    readonly events?: string[];
    readonly spawned?: ReadonlyArray<string>[];
    readonly dead?: () => boolean;
    readonly execCalls?: ReadonlyArray<string>[];
    readonly captureOps?: Parameters<typeof sealantLaunchLayer>[11];
  } = {},
) =>
  sealantLaunchLayer(
    created,
    undefined,
    knobs.events,
    knobs.spawned,
    knobs.dead,
    undefined,
    undefined,
    undefined,
    undefined,
    knobs.execCalls,
    undefined,
    knobs.captureOps,
  );

/** The store's sealed records, by `<worktree>:<epoch>` (`CaptureSeals`). */
export const memorySeals = (
  records: Map<string, CaptureCompletionSeal>,
): Layer.Layer<CaptureSeals> =>
  Layer.succeed(CaptureSeals, {
    sealedCompletion: (worktreeId, executorId, epoch) =>
      Effect.sync(() => {
        const seal = records.get(`${worktreeId}:${epoch}`) ?? null;
        return seal !== null && seal.executorId === executorId ? seal : null;
      }),
  });

/** A launch's harness warm-up (`harnessWarmupArgv`), told apart by its throwaway HOME. */
export const isWarmup = (argv: ReadonlyArray<string>) =>
  argv[0] === "sh" && argv[1] === "-c" && (argv[2] ?? "").includes('HOME="$d"');

/**
 * A capture-mode session as the owner's box had it on 2026-10-03 at 23:00: stopped and resumed
 * seconds before a deploy, so its row reads `running` and unsettled (`resumeSession` reopens it
 * before the relaunch), its agent process ended, its run settled, and its old executor still up
 * and waiting to be drained when Mend was killed.
 */
export const seedStoppedBeforeRestart = (
  world: World,
  tmp: string,
  input: {
    readonly sessionId: SessionId;
    readonly runId: SealantRunId;
    readonly workspaceId: SealantWorkspaceId;
    readonly processLive: boolean;
  },
) => {
  const { sessionId, runId, workspaceId } = input;
  const projectId = ProjectId.make("proj-boot");
  const timestamp = now();
  world.projects.set(
    projectId,
    new Project({
      id: projectId,
      name: "boot",
      organizationId: OrganizationId.make("org-test"),
      visibility: "shared",
      createdByUserId: null,
      originUrl: RepositoryCloneUrl.make("https://example.invalid/boot.git"),
      storePath: path.join(tmp, "store", "boot"),
      defaultBranch: "main",
      adoptedSha: Sha.make("0000000000000000000000000000000000000000"),
      autoTour: "inherit",
      autoName: "inherit",
      autoLand: "inherit",
      autoSuggest: "inherit",
      backgroundSessions: "inherit",
      gitAuthMode: "mend-key",
      workspaceImage: null,
      applyDotfiles: true,
      defaultShellProfile: true,
      inheritUserSkills: true,
      hotSessions: 0,
      installCommand: null,
      installEnabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  world.sessions.set(
    sessionId,
    new Session({
      id: sessionId,
      projectId,
      worktreeId: WorktreeId.make("wt-boot"),
      harness: "codex",
      providerSessionId: null,
      label: null,
      worktree: "session-boot",
      branch: "mend/session-boot",
      baseSha: Sha.make("0000000000000000000000000000000000000000"),
      baseRef: "main",
      contextSnapshotId: null,
      referenceMounts: [],
      extraMounts: [],
      sealantRunId: runId,
      sealantWorkspaceId: workspaceId,
      sealantSessionId: "pty-1",
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
      startedAt: timestamp,
      settledAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  world.processes.set(
    "agent-boot",
    new SessionProcess({
      id: SessionProcessId.make("agent-boot"),
      sessionId,
      sealantWorkspaceId: workspaceId,
      sealantSessionId: "pty-1",
      sealantRunId: runId,
      launchCorrelationId: null,
      serviceId: null,
      attemptOrdinal: null,
      kind: "agent-pty",
      harness: "codex",
      providerSessionId: null,
      protocolOptions: null,
      label: "codex",
      argv: ["codex"],
      status: input.processLive ? "running" : "stopped",
      exitCode: null,
      workspacePort: null,
      protocol: "tcp",
      hostPort: null,
      createdAt: timestamp,
      exitedAt: input.processLive ? null : timestamp,
      updatedAt: timestamp,
    }),
  );
  world.sessionRuns.set(
    runId,
    new SessionRun({
      sealantRunId: runId,
      sessionId,
      ordinal: 1,
      harness: "codex",
      sealantWorkspaceId: workspaceId,
      sealantSessionId: "pty-1",
      status: input.processLive ? "running" : "stopped",
      summary: null,
      lastSeenSequence: 0n,
      environmentRevision: null,
      environmentVariableNames: null,
      secretRevision: null,
      secretNames: null,
      clusterBindingRevision: null,
      clusterBindingNames: null,
      clusterServiceAccount: null,
      startedAt: timestamp,
      settledAt: input.processLive ? null : timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
};

/** `condition` holds within `within`, polled every 20 ms; else the test fails with `what`. */
export const eventually = (what: string, within: Duration.Duration, condition: () => boolean) =>
  Effect.suspend(() =>
    condition() ? Effect.void : Effect.fail(new Error(`not yet: ${what}`)),
  ).pipe(
    Effect.retry({
      times: Math.ceil(Duration.toMillis(within) / 20),
      schedule: Schedule.spaced(Duration.millis(20)),
    }),
  );
