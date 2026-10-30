// What a resume lays down again: setup commands only on a worktree laid down fresh, a saved
// dependency patch, skill and directory metadata through relocation, and a home's secret files.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionId } from "@mend/domain";
import { Project, Session, SkillWithFiles } from "@mend/domain/workbench";
import { SealantPlatformError, toPlatformError } from "@mend/sealant";
import { SessionEngine, secretFilesDeliveredExec } from "@mend/sessions";
import { BlobStore, BlobStoreError, BlobStoreFsLive, captureKeys } from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { it } from "@mend/test-ci/effect-vitest";
import {
  type CreateOptions,
  SealantApiError,
  type Workspace,
  type WorkspaceCaptureReplanned,
} from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { makeLaunchClock } from "./engine-launch-recovery-fixtures.ts";
import {
  CUSTOM_BASE,
  lifecycleLayer,
  memoryHotPool,
  provisionIn,
  until,
} from "./engine/capture-fixture.ts";
import { signallingPool } from "./engine/clock-fixture.ts";
import {
  captureAnswer,
  drawnLine,
  isPickupExec,
  launchSkill,
  now,
  redeemPickupExec,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  skillsForLaunchLayer,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

/** What the pickup writer does with what it redeemed: each file 0644, its directory 0755. */
const writePickedUp = (
  files: ReadonlyArray<{ readonly path: string; readonly base64: string }>,
  mapPath: (at: string) => string,
) => {
  for (const file of files) {
    const target = mapPath(file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, Buffer.from(file.base64, "base64"), { mode: 0o644 });
  }
};

/** A dependency the setup's `npm ci` installs from a local tarball: no registry, no scripts. */
const npmProject = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r15-setup-"));
  const seed = path.join(root, "seed");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(seed);
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "review15-dep", version: "1.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(packageRoot, "index.js"), 'module.exports = "published baseline";\n');
  execFileSync("npm", ["pack", "--pack-destination", seed, "--ignore-scripts"], {
    cwd: packageRoot,
    stdio: "pipe",
  });
  fs.writeFileSync(
    path.join(seed, "package.json"),
    JSON.stringify({
      name: "review15-app",
      version: "1.0.0",
      dependencies: { "review15-dep": "file:review15-dep-1.0.0.tgz" },
    }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
    cwd: seed,
    stdio: "pipe",
  });
  return { root, seed };
};

const NPM_CI = "npm ci --ignore-scripts --offline --no-audit --no-fund";

const DEP = "node_modules/review15-dep/index.js";

const PATCH = 'module.exports = "my debugging fix, not yet upstream";\n';

describe("custom-image setup commands run only on a worktree laid down fresh (review 2026-09-28 (15) #1)", () => {
  /** The executor registers a turn capture: the worktree's head moves past capture 0. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const registerTurnCapture = (
    memory: MemoryCaptureStore,
    tmp: string,
    session: Session,
    tree: string,
  ) =>
    Effect.gen(function* () {
      const api = servedSocketApis.get(session.id)?.capture;
      if (api === undefined) throw new Error("the session serves no capture api");
      const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
      const chain = memory.chains.get(session.worktreeId);
      const parent = chain?.headCapture ?? null;
      const n = (chain?.headN ?? 0) + 1;
      const snapshot = snapshotDirectory(tree, captureKeys(session.worktreeId, epoch), {
        chunkSize: 64,
      });
      const built = buildManifest({
        worktreeId: session.worktreeId,
        n,
        parent,
        epoch,
        seq: n * 10,
        kind: "turn",
        git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
        workspace: { root: snapshot.root, packs: snapshot.packs },
      });
      yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
        Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
      );
      const registered = yield* api.register({
        worktree_id: session.worktreeId,
        epoch,
        n,
        parent,
        capture_id: built.id,
        manifest_key: built.key,
        manifest: built.manifest,
      });
      expect(registered.head_n).toBe(n);
      return n;
    });

  // Live clock: the setup command is a real `npm ci` the fake runs with spawnSync and the saved
  // tree is copied on disk; no Effect timer is waited on.
  it.live(
    "a cold resume restored from a saved capture runs no setup command: npm ci never overwrites the restored node_modules patch, the helper still installs, and the session line says why",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const execCalls: ReadonlyArray<string>[] = [];
        const memory = makeMemoryCaptureStore();
        const { root, seed } = npmProject();
        const saved = path.join(root, "saved");
        let executorRoot = "";
        let setups = 0;
        const restoredReads: string[] = [];
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              // A worktree's first launch lays it down fresh (capture 0): its setup runs.
              expect(memory.chains.get(session.worktreeId)?.headN).toBe(0);
              expect(setups).toBe(1);
              expect(world.sessions.get(session.id)?.summary ?? "").not.toMatch(/setup skipped/);
              // The user patches a dependency; the executor captures it (n = 1).
              fs.writeFileSync(path.join(executorRoot, DEP), PATCH);
              const n = yield* registerTurnCapture(memory, tmp, session, executorRoot);
              fs.cpSync(executorRoot, saved, { recursive: true, preserveTimestamps: true });
              yield* engine.stop(session.id);
              yield* until(
                () =>
                  world.sessions.get(session.id)?.captureDrain === null &&
                  world.sessions.get(session.id)?.status === "stopped",
                "the saved stop",
              );
              const helperInstalls = execCalls.filter((argv) =>
                (argv[2] ?? "").includes("/usr/local/bin/mend"),
              ).length;

              const resumed = yield* engine.resumeSession(session.id, "shell");
              expect(created).toHaveLength(2);
              // The executor restored the patch; no setup command ran over it.
              expect(restoredReads.at(-1)).toBe(PATCH);
              expect(fs.readFileSync(path.join(executorRoot, DEP), "utf8")).toBe(PATCH);
              expect(setups).toBe(1);
              // The helper and the git transport still install: they never touch the worktree.
              expect(
                execCalls.filter((argv) => (argv[2] ?? "").includes("/usr/local/bin/mend")),
              ).toHaveLength(helperInstalls + 1);
              expect(resumed.status).toBe("running");
              expect(world.sessions.get(session.id)?.summary).toBe(
                `setup skipped · restored from capture ${n}`,
              );
            }),
          {
            captured: memory,
            workspaceImage: { ...CUSTOM_BASE, setupCommands: [NPM_CI] },
            sealantLayer: lifecycleLayer(created, {
              execCalls,
              captureOps: {
                stopAnswer: () => "stopped",
                beforeCreate: () =>
                  Effect.sync(() => {
                    executorRoot = path.join(root, `executor-${created.length}`);
                    // The first executor lays capture 0 down; the resume restores the capture.
                    fs.cpSync(created.length === 1 ? seed : saved, executorRoot, {
                      recursive: true,
                      preserveTimestamps: true,
                    });
                    restoredReads.push(fs.readFileSync(path.join(executorRoot, DEP), "utf8"));
                  }),
                exec: (argv) => {
                  if (argv[0] !== "sh" || argv[1] !== "-lc" || argv[2] !== NPM_CI) return undefined;
                  setups += 1;
                  const run = spawnSync("sh", ["-lc", NPM_CI], {
                    cwd: executorRoot,
                    encoding: "utf8",
                  });
                  return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
                },
              },
            }),
          },
        ).pipe(
          Effect.ensuring(Effect.sync(() => fs.rmSync(root, { recursive: true, force: true }))),
        );
      }),
    { timeout: 60_000 },
  );

  for (const head of ["capture 0", "a saved capture"] as const) {
    it.effect(
      `a standby claimed onto ${head} ${head === "capture 0" ? "runs its setup commands at claim, after the replan" : "runs no setup command after its replan, still installs the helper, and says why"}`,
      () =>
        Effect.gen(function* () {
          const execCalls: ReadonlyArray<string>[] = [];
          const memory = makeMemoryCaptureStore();
          const pool = memoryHotPool();
          const clock = yield* makeLaunchClock;
          const SETUP = "npm ci --offline";
          /** Every exec, in order, with whether the replan had happened yet. */
          const order: string[] = [];
          let executor: SessionId | null = null;
          // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
          const flush = () => Effect.succeed(captureAnswer({ epoch: 2 }));
          const replan = (workspace: Workspace) =>
            Effect.gen(function* () {
              if (executor === null) throw new Error("no executor to replan");
              order.push("replan");
              const api = servedSocketApis.get(executor)?.capture;
              if (api === undefined) throw new Error("the executor serves no capture api");
              const plan = yield* api.planGet({ worktree_id: null, epoch: 0 }).pipe(
                Effect.mapError(
                  (error) =>
                    new SealantPlatformError({
                      code: "replan_refused",
                      status: error.status,
                      message: `${error.reason}: ${error.message}`,
                      cause: error,
                    }),
                ),
              );
              return {
                worktreeId: plan.worktree_id,
                epoch: plan.epoch,
                ...(plan.head === null
                  ? {}
                  : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
                filesWritten: 1,
                bytesWritten: 14,
                filesSkipped: 0,
                bytesSkipped: 0,
                removed: 0,
                unchanged: workspace.id === "",
              } satisfies WorkspaceCaptureReplanned;
            });
          yield* withPreparedEngineEffect(
            (world, tmp) => setup(tmp, world),
            (world, tmp, project) =>
              Effect.gen(function* () {
                world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
                const engine = yield* SessionEngine;
                yield* engine.reconcileHotSessions(project.id);
                yield* clock.untilChanged(
                  () => pool.entries.some((entry) => entry.status === "ready"),
                  "a standby",
                );
                const standby = pool.entries[0];
                if (standby === undefined) throw new Error("no standby");
                // Nothing executes in a capture-mode standby before its claim (e2e9 F-B).
                expect(execCalls).toEqual([]);
                // The claim waits out one checkpoint for the standby's capture 0 to register.
                const session = yield* clock.checkpointWait(
                  engine.provision({
                    projectId: project.id,
                    harness: "codex",
                    label: null,
                    name: null,
                    ownerUserId: "user-fixture",
                    start: { kind: "base", base: null },
                  }),
                );
                // The session claimed the standby.
                expect(session.id).toBe(standby.id);
                executor = session.id;
                let savedN: number | null = null;
                if (head === "a saved capture") {
                  // The worktree's head is past capture 0 when the replan lays it down: capture 1,
                  // saved by an earlier executor under an earlier epoch.
                  const tree = path.join(tmp, "standby-saved");
                  fs.mkdirSync(path.join(tree, "tree"), { recursive: true });
                  fs.writeFileSync(path.join(tree, "tree", "edit.txt"), "saved work\n");
                  const cap0 = memory.chains.get(session.worktreeId)?.headCapture ?? null;
                  const snapshot = snapshotDirectory(tree, captureKeys(session.worktreeId, 1), {
                    chunkSize: 64,
                  });
                  const built = buildManifest({
                    worktreeId: session.worktreeId,
                    n: 1,
                    parent: cap0,
                    epoch: 1,
                    seq: 10,
                    kind: "final",
                    git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
                    workspace: { root: snapshot.root, packs: snapshot.packs },
                  });
                  yield* uploadObjects(
                    new Map([...snapshot.objects, [built.key, built.bytes]]),
                  ).pipe(Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))));
                  memory.captures.set(built.id, {
                    id: built.id,
                    worktreeId: session.worktreeId,
                    n: 1,
                    parent: cap0,
                    epoch: 1,
                    seq: 10n,
                    kind: "final",
                    manifestKey: built.key,
                    sections: built.manifest.sections,
                    gitFsck: "verified",
                    createdAt: now(),
                  });
                  memory.chains.set(session.worktreeId, {
                    ...(memory.chains.get(session.worktreeId) ?? { headEpoch: 1 }),
                    headCapture: built.id,
                    headN: 1,
                    headEpoch: 1,
                  });
                  savedN = 1;
                }
                yield* engine.launch(session.id, ["codex"]);
                expect(order[0]).toBe("replan");
                const setups = order.filter((entry) => entry === "setup");
                const helper = order.indexOf("helper");
                expect(helper).toBeGreaterThan(0);
                const summary = drawnLine(world.sessions.get(session.id)?.summary);
                if (savedN === null) {
                  expect(setups).toHaveLength(1);
                  expect(order.indexOf("setup")).toBeGreaterThan(0);
                  expect(order.indexOf("setup")).toBeLessThan(helper);
                  expect(summary ?? "").not.toMatch(/setup skipped/);
                } else {
                  expect(setups).toEqual([]);
                  expect(summary).toBe(`setup skipped · restored from capture ${savedN}`);
                }
              }),
            {
              captured: memory,
              workspaceImage: { ...CUSTOM_BASE, setupCommands: [SETUP] },
              sealantLayer: sealantLaunchLayer(
                [],
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
                  replan,
                  flush,
                  exec: (argv) => {
                    if (argv[0] === "sh" && argv[1] === "-lc" && argv[2] === SETUP) {
                      order.push("setup");
                    } else if ((argv[2] ?? "").includes("/usr/local/bin/mend")) {
                      order.push("helper");
                    }
                    return undefined;
                  },
                },
              ),
              hotWorkspacesLayer: signallingPool(pool, clock.changes),
              wrapCaptureChannel: clock.wrapCaptureChannel,
            },
          );
        }),
    );
  }
});

// Review 2026-09-28 (16) #1: a resume onto a saved head whose tree is this platform's keeps the
// user's patch in `node_modules` whether the manifest read at the install decision succeeds or
// fails once (HTTP 503). A failed read is unavailable, never "no tree here".
for (const fault of [false, true]) {
  it.effect(
    `AUDIT R16 same-platform resume preserves dependency patch with manifest GET fault=${fault}`,
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const { root, seed } = npmProject();
        const saved = path.join(root, "saved");
        let executorRoot = "";
        let failedReads = 0;
        let failRead = false;
        let manifestKey = "";
        let installs = 0;
        const restoredReads: string[] = [];
        const logs: string[] = [];
        const clock = yield* makeLaunchClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, adopted) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(adopted);
              const project = world.projects.get(session.projectId);
              if (project === undefined) throw new Error("project missing");
              world.projects.set(project.id, new Project({ ...project, installCommand: NPM_CI }));
              yield* engine.launch(session.id, ["codex"]);
              expect(installs).toBe(1);
              fs.writeFileSync(path.join(executorRoot, DEP), PATCH);
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              const chain = memory.chains.get(session.worktreeId);
              const n = (chain?.headN ?? 0) + 1;
              const snapshot = snapshotDirectory(
                executorRoot,
                captureKeys(session.worktreeId, epoch),
                { chunkSize: 64 },
              );
              const bulkRoot = path.join(root, "bulk");
              fs.mkdirSync(path.join(bulkRoot, "tree"), { recursive: true });
              fs.cpSync(
                path.join(executorRoot, "node_modules"),
                path.join(bulkRoot, "tree/node_modules"),
                { recursive: true },
              );
              const bulk = snapshotDirectory(bulkRoot, captureKeys(session.worktreeId, epoch), {
                chunkSize: 64,
              });
              const built = buildManifest({
                worktreeId: session.worktreeId,
                n,
                parent: chain?.headCapture ?? null,
                epoch,
                seq: n * 10,
                kind: "final",
                git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
                workspace: { root: snapshot.root, packs: snapshot.packs },
                bulk: { root: bulk.root, packs: bulk.packs, platform: "linux-x86_64-gnu" },
              });
              yield* uploadObjects(
                new Map([...snapshot.objects, ...bulk.objects, [built.key, built.bytes]]),
              ).pipe(Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))));
              const api = servedSocketApis.get(session.id)?.capture;
              if (api === undefined) throw new Error("capture api missing");
              const registered = yield* api.register({
                worktree_id: session.worktreeId,
                epoch,
                n,
                parent: chain?.headCapture ?? null,
                capture_id: built.id,
                manifest_key: built.key,
                manifest: built.manifest,
              });
              expect(registered.head_n).toBe(n);
              manifestKey = built.key;
              fs.cpSync(executorRoot, saved, { recursive: true, preserveTimestamps: true });
              yield* engine.stop(session.id);
              yield* clock.untilChanged(
                () =>
                  world.sessions.get(session.id)?.captureDrain === null &&
                  world.sessions.get(session.id)?.status === "stopped",
                "saved stop",
              );
              const resumed = yield* engine.resumeSession(session.id, "shell");
              expect(created).toHaveLength(2);
              expect(restoredReads.at(-1)).toBe(PATCH);
              expect(resumed.status).toBe("running");
              expect(failedReads).toBe(fault ? 1 : 0);
              expect(fs.readFileSync(path.join(executorRoot, DEP), "utf8")).toBe(PATCH);
              // The restored tree is observed on a read; an unavailable read runs no installer.
              expect(installs).toBe(1);
              const summary = world.sessions.get(session.id)?.summary ?? "";
              if (fault) {
                expect(summary).toContain(
                  `dependency install skipped · capture ${n} manifest unavailable`,
                );
                expect(
                  logs.some((line) =>
                    line.includes("dependency install skipped · manifest unavailable"),
                  ),
                ).toBe(true);
              } else {
                expect(summary).not.toMatch(/dependency install skipped/);
              }
            }),
          {
            captured: memory,
            logs,
            prepareWorld: clock.prepareWorld,
            transformBlobs: (base) =>
              Layer.effect(
                BlobStore,
                Effect.gen(function* () {
                  const inner = yield* BlobStore;
                  return {
                    ...inner,
                    get: (key: string) =>
                      Effect.suspend(() => {
                        if (failRead && key === manifestKey) {
                          failRead = false;
                          failedReads += 1;
                          return Effect.fail(
                            new BlobStoreError({
                              operation: "get",
                              key,
                              cause: new Error("503 ServiceUnavailable on one manifest read"),
                            }),
                          );
                        }
                        return inner.get(key);
                      }),
                  };
                }),
              ).pipe(Layer.provide(base)),
            workspaceImage: { ...CUSTOM_BASE, setupCommands: [] },
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopAnswer: () => "stopped",
                beforeCreate: () =>
                  Effect.sync(() => {
                    executorRoot = path.join(root, `executor-${created.length}`);
                    fs.cpSync(
                      created.length === 1 ? seed : (process.env.REVIEW16_RESTORED_ROOT ?? saved),
                      executorRoot,
                      { recursive: true, preserveTimestamps: true },
                    );
                    restoredReads.push(fs.readFileSync(path.join(executorRoot, DEP), "utf8"));
                  }),
                exec: (argv) => {
                  if ((argv[2] ?? "").startsWith("uname -s; uname -m;")) {
                    if (created.length === 2) failRead = fault;
                    return {
                      exitCode: 0,
                      stdout: "Linux\nx86_64\nldd (GNU libc) 2.39\n",
                      stderr: "",
                    };
                  }
                  if (argv[0] !== "sh" || argv[1] !== "-lc" || argv[2] !== NPM_CI) return undefined;
                  installs += 1;
                  const run = spawnSync("sh", ["-lc", NPM_CI], {
                    cwd: executorRoot,
                    encoding: "utf8",
                  });
                  return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
                },
              },
            }),
          },
        ).pipe(
          Effect.ensuring(Effect.sync(() => fs.rmSync(root, { recursive: true, force: true }))),
        );
      }),
    { timeout: 60000 },
  );
}

/**
 * Review 2026-09-28 (18) #1: skills delivery on resume decided that a skill directory was its own
 * delivery by file contents alone, removed it and wrote it again. A helper script the user made
 * executable came back 0644; an empty directory and a hard link were gone. The reviewer's probe:
 * the actual engine launches and delivers `build-helper`, the user customizes it, the harness home
 * is registered in a sealed capture, and the cold resume runs the emitted `mend-skills` and
 * `mend-write` commands against a `cp -a` copy (the reviewer proved sealantd restores exactly
 * these: mode, nanosecond mtime, empty directory, both link names).
 */
it.effect(
  "AUDIT R18 cold resume preserves a saved skill's metadata",
  () =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r18-skills-"));
      const saved = path.join(root, "saved");
      let executorHome = "";
      const base = launchSkill("build-helper", "# Build helper\nRun scripts/check.sh.\n", {
        scope: "user",
        userId: "user-fixture",
      });
      const delivered = new SkillWithFiles({
        ...base,
        files: [...base.files, { path: "scripts/check.sh", contents: "#!/bin/sh\necho checked\n" }],
      });
      const skillsLayer = skillsForLaunchLayer(() =>
        Effect.succeed({ user: [delivered], project: [] }),
      );
      const facts = () => {
        const script = path.join(executorHome, ".claude/skills/build-helper/scripts/check.sh");
        return {
          mode: fs.statSync(script).mode & 0o777,
          empty: fs.existsSync(
            path.join(executorHome, ".claude/skills/build-helper/scratch/empty"),
          ),
          linked:
            fs.statSync(script).ino === fs.statSync(path.join(executorHome, "my-check.sh")).ino,
          mtime: fs.statSync(script, { bigint: true }).mtimeNs.toString(),
          bytes: fs.readFileSync(script, "utf8"),
        };
      };
      let before: ReturnType<typeof facts> | null = null;
      const ran: Array<string> = [];
      const clock = yield* makeLaunchClock;
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            const dir = path.join(executorHome, ".claude/skills/build-helper");
            const script = path.join(dir, "scripts/check.sh");
            fs.chmodSync(script, 0o755);
            fs.mkdirSync(path.join(dir, "scratch/empty"), { recursive: true });
            fs.linkSync(script, path.join(executorHome, "my-check.sh"));
            fs.utimesSync(script, 1700000000.123, 1700000000.123);
            fs.mkdirSync(saved);
            expect(spawnSync("cp", ["-a", `${executorHome}/.`, saved]).status).toBe(0);
            const chain = memory.chains.get(session.worktreeId);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const n = (chain?.headN ?? 0) + 1;
            const snapshotRoot = path.join(root, "snapshot");
            fs.mkdirSync(snapshotRoot);
            fs.cpSync(saved, path.join(snapshotRoot, "harness"), { recursive: true });
            const snapshot = snapshotDirectory(
              snapshotRoot,
              captureKeys(session.worktreeId, epoch),
              {
                chunkSize: 64,
              },
            );
            const built = buildManifest({
              worktreeId: session.worktreeId,
              n,
              parent: chain?.headCapture ?? null,
              epoch,
              seq: n * 10,
              kind: "final",
              git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
              workspace: { root: snapshot.root, packs: snapshot.packs },
            });
            yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
              Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
            );
            const api = servedSocketApis.get(session.id)?.capture;
            if (api === undefined) throw new Error("capture api missing");
            yield* api.register({
              worktree_id: session.worktreeId,
              epoch,
              n,
              parent: chain?.headCapture ?? null,
              capture_id: built.id,
              manifest_key: built.key,
              manifest: built.manifest,
            });
            yield* engine.stop(session.id);
            yield* clock.untilChanged(
              () =>
                world.sessions.get(session.id)?.captureDrain === null &&
                world.sessions.get(session.id)?.status === "stopped",
              "saved stop",
            );
            const resumed = yield* engine.resumeSession(session.id, "shell");
            expect(resumed.status).toBe("running");
            expect(before).toMatchObject({ mode: 0o755, empty: true, linked: true });
            expect(facts()).toEqual(before);
            // The resume ran the delivery: it found the skill unchanged and wrote none of its files.
            expect(ran.filter((op) => op === "mend-skills").length).toBe(2);
          }),
        {
          captured: memory,
          skillsLayer,
          prepareWorld: clock.prepareWorld,
          workspaceImage: { ...CUSTOM_BASE, setupCommands: [] },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopAnswer: () => "stopped",
              beforeCreate: () =>
                Effect.sync(() => {
                  executorHome = path.join(root, `home-${created.length}`);
                  fs.mkdirSync(executorHome);
                  if (created.length > 1) {
                    expect(spawnSync("cp", ["-a", `${saved}/.`, executorHome]).status).toBe(0);
                    before = facts();
                  }
                }),
              // The skill files: redeemed over the session's channel and written as the pickup
              // writer writes them, into this executor's home.
              execEffect: (argv) => {
                if (argv[3] !== "mend-write" || !isPickupExec(argv)) return undefined;
                ran.push("mend-write");
                const channel = created.at(-1)?.env?.["MEND_SESSION_ID"];
                return redeemPickupExec(
                  argv,
                  channel === undefined ? null : SessionId.make(channel),
                ).pipe(
                  Effect.map((answer) => {
                    writePickedUp(answer.files, (at) =>
                      at.replaceAll("/workspace/harness-home", executorHome),
                    );
                    return { exitCode: 0, stdout: "", stderr: "" };
                  }),
                  Effect.orDie,
                );
              },
              exec: (argv) => {
                const op = argv[3] ?? "";
                const manifestRead =
                  argv[0] === "cat" && (argv[1] ?? "").includes(".mend-managed-skills");
                if (op !== "mend-skills" && !manifestRead) return undefined;
                ran.push(manifestRead ? "cat" : op);
                const mapped = argv.map((arg) =>
                  arg.replaceAll("/workspace/harness-home", executorHome),
                );
                const run = spawnSync(mapped[0] ?? "", mapped.slice(1), {
                  cwd: executorHome,
                  env: { ...process.env, HOME: executorHome },
                  encoding: "utf8",
                });
                return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
              },
            },
          }),
        },
      ).pipe(Effect.ensuring(Effect.sync(() => fs.rmSync(root, { recursive: true, force: true }))));
    }),
  { timeout: 60_000 },
);

/** Core's credential writer (`credential-files.ts`), as it runs in a fresh executor. */
const injectCoreCredential = (home: string) =>
  spawnSync(
    "sh",
    [
      "-c",
      'umask 077 && mkdir -p "$(dirname "$HOME/.claude/.credentials.json")" && ' +
        'base64 -d > "$HOME/.claude/.credentials.json" && ' +
        'chmod 600 "$HOME/.claude/.credentials.json"',
    ],
    {
      env: { ...process.env, HOME: home },
      input: Buffer.from("fresh injected credential\n").toString("base64"),
    },
  ).status;

/**
 * Review 2026-09-28 (19) #1: after a correct cold restore, the relocation merged the fresh
 * executor's `$HOME/.claude` (Core writes the connected-account credential under `umask 077`) into
 * the restored harness root with `cp -an source/. root/`, which copied that directory's 0700 and
 * time over the restored `.claude` saved at 0750. The reviewer's probe: the actual engine launches,
 * `.claude` is set to 0750 with an exact time, the harness home is registered in a sealed capture,
 * and the cold resume runs Core's credential write into a fresh home, then the engine's own
 * relocation and skills commands against a `cp -a` copy of what was saved.
 */
it.effect(
  "AUDIT R19 cold resume preserves directory metadata through actual relocation",
  () =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r19-relocation-"));
      const saved = path.join(root, "saved");
      let executorHome = "";
      let ephemeralHome = "";
      const relocations: Array<{
        readonly before: { readonly mode: number; readonly mtime: string } | null;
        readonly after: { readonly mode: number; readonly mtime: string };
        readonly status: number | null;
      }> = [];
      const dirFacts = () => {
        const stat = fs.statSync(path.join(executorHome, ".claude"), { bigint: true });
        return { mode: Number(stat.mode & 0o777n), mtime: stat.mtimeNs.toString() };
      };
      const base = launchSkill("build-helper", "# Build helper\nRun scripts/check.sh.\n", {
        scope: "user",
        userId: "user-fixture",
      });
      const delivered = new SkillWithFiles({
        ...base,
        files: [...base.files, { path: "scripts/check.sh", contents: "#!/bin/sh\necho checked\n" }],
      });
      const skillsLayer = skillsForLaunchLayer(() =>
        Effect.succeed({ user: [delivered], project: [] }),
      );
      const clock = yield* makeLaunchClock;
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            fs.chmodSync(path.join(executorHome, ".claude"), 0o750);
            fs.utimesSync(path.join(executorHome, ".claude"), 1700000000.125, 1700000000.125);
            fs.mkdirSync(saved);
            expect(spawnSync("cp", ["-a", `${executorHome}/.`, saved]).status).toBe(0);
            const chain = memory.chains.get(session.worktreeId);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            const n = (chain?.headN ?? 0) + 1;
            const snapshotRoot = path.join(root, "snapshot");
            fs.mkdirSync(snapshotRoot);
            fs.cpSync(saved, path.join(snapshotRoot, "harness"), { recursive: true });
            const snapshot = snapshotDirectory(
              snapshotRoot,
              captureKeys(session.worktreeId, epoch),
              { chunkSize: 64 },
            );
            const built = buildManifest({
              worktreeId: session.worktreeId,
              n,
              parent: chain?.headCapture ?? null,
              epoch,
              seq: n * 10,
              kind: "final",
              git: { packs: [], refs: {}, head: "refs/heads/main", fsck: "verified" },
              workspace: { root: snapshot.root, packs: snapshot.packs },
            });
            yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
              Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
            );
            const api = servedSocketApis.get(session.id)?.capture;
            if (api === undefined) throw new Error("capture api missing");
            yield* api.register({
              worktree_id: session.worktreeId,
              epoch,
              n,
              parent: chain?.headCapture ?? null,
              capture_id: built.id,
              manifest_key: built.key,
              manifest: built.manifest,
            });
            yield* engine.stop(session.id);
            yield* clock.untilChanged(
              () =>
                world.sessions.get(session.id)?.captureDrain === null &&
                world.sessions.get(session.id)?.status === "stopped",
              "saved stop",
            );
            const resumed = yield* engine.resumeSession(session.id, "shell");
            expect(resumed.status).toBe("running");
            // Both launches relocated; the resume's ran over the restored `.claude`.
            expect(relocations).toHaveLength(2);
            const last = relocations.at(-1);
            expect(last?.status).toBe(0);
            expect(last?.before).toEqual({ mode: 0o750, mtime: "1700000000125000000" });
            expect(last?.after).toEqual(last?.before);
            // The fresh credential arrived beside it, as Core wrote it.
            const credential = path.join(executorHome, ".claude/.credentials.json");
            expect(fs.readFileSync(credential, "utf8")).toBe("fresh injected credential\n");
            expect(fs.statSync(credential).mode & 0o777).toBe(0o600);
            expect(fs.realpathSync(path.join(ephemeralHome, ".claude"))).toBe(
              path.join(executorHome, ".claude"),
            );
          }),
        {
          captured: memory,
          skillsLayer,
          prepareWorld: clock.prepareWorld,
          workspaceImage: { ...CUSTOM_BASE, setupCommands: [] },
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              stopAnswer: () => "stopped",
              beforeCreate: () =>
                Effect.sync(() => {
                  executorHome = path.join(root, `capture-${created.length}`);
                  fs.mkdirSync(executorHome);
                  ephemeralHome = path.join(root, `home-${created.length}`);
                  fs.mkdirSync(ephemeralHome);
                  expect(injectCoreCredential(ephemeralHome)).toBe(0);
                  if (created.length > 1) {
                    expect(spawnSync("cp", ["-a", `${saved}/.`, executorHome]).status).toBe(0);
                  }
                }),
              exec: (argv) => {
                const relocation = (argv[2] ?? "").includes("harness-home relocation failed");
                const op = argv[3] ?? "";
                const manifestRead =
                  argv[0] === "cat" && (argv[1] ?? "").includes(".mend-managed-skills");
                if (!relocation && op !== "mend-skills" && op !== "mend-write" && !manifestRead) {
                  return undefined;
                }
                const mapped = argv.map((arg) =>
                  arg.replaceAll("/workspace/harness-home", executorHome),
                );
                const before =
                  relocation && fs.existsSync(path.join(executorHome, ".claude"))
                    ? dirFacts()
                    : null;
                const run = spawnSync(mapped[0] ?? "", mapped.slice(1), {
                  cwd: executorHome,
                  env: { ...process.env, HOME: ephemeralHome },
                  encoding: "utf8",
                });
                if (relocation) relocations.push({ before, after: dirFacts(), status: run.status });
                return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
              },
            },
          }),
        },
      ).pipe(Effect.ensuring(Effect.sync(() => fs.rmSync(root, { recursive: true, force: true }))));
    }),
  { timeout: 60_000 },
);

/**
 * An agent's first screen on a fresh executor (alpha 2026-09-30, fda7180d): the machine is ready
 * in seconds, and the harness then reads node and its own files from a lazily fetched disk for the
 * first time. The launch reads them once in the background while the rest of its setup runs, and
 * the session line says the agent is starting until its record carries output.
 */
describe("secret files under a directory sessions now save (review 2026-10-04)", () => {
  it("refuses the launch, before the harness home moves, when the home's record of secret files cannot be read", async () => {
    for (const answer of ["exits", "fails"] as const) {
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      let opened = 0;
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
            const refusal = yield* engine.launch(session.id, ["opencode"]).pipe(Effect.flip);
            expect(String(refusal.message), answer).toContain(
              "a secret file under a directory sessions now save could not be taken out of it",
            );
            // Nothing moved the harness home, and no agent started.
            expect(
              execCalls.some((argv) => String(argv[2]).includes("harness-home relocation")),
            ).toBe(false);
            expect(opened).toBe(0);
            expect(world.sessions.get(session.id)?.status).toBe("failed");
            expect(world.sessions.get(session.id)?.summary ?? "").toContain("launch failed:");
          }),
        {
          sealantLayer: lifecycleLayer(created, {
            execCalls,
            captureOps: {
              execEffect: (argv) =>
                argv.join(" ") === secretFilesDeliveredExec.join(" ")
                  ? answer === "exits"
                    ? Effect.succeed({ exitCode: 1, stdout: "", stderr: "unreadable" })
                    : Effect.fail(
                        new SealantPlatformError({
                          code: "exec-failed",
                          status: null,
                          message: "the workspace did not answer",
                          cause: null,
                        }),
                      )
                  : undefined,
              beforeOpen: () => {
                opened += 1;
              },
            },
          }),
        },
      );
    }
  });

  it("keeps the platform's words off the line of a join whose home's record it could not read (SLNT-385)", async () => {
    const words = "Anna is interviewing at Northwind on Friday, keep it quiet";
    let reads = 0;
    const summary = await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const holder = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: "holder",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(holder.id, ["codex"]);
          const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          yield* engine.launch(joined.id, ["codex"]).pipe(Effect.exit);
          return world.sessions.get(joined.id)?.summary ?? null;
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: lifecycleLayer([], {
          execCalls: [],
          captureOps: {
            execEffect: (argv) =>
              argv.join(" ") === secretFilesDeliveredExec.join(" ") && reads++ > 0
                ? Effect.fail(toPlatformError(new SealantApiError(words, { status: 500 })))
                : undefined,
          },
        }),
      },
    );
    expect(reads).toBeGreaterThan(1);
    expect(summary).not.toContain(words);
    expect(summary).toMatch(
      /^resume failed: a secret file under a directory sessions now save could not be taken out of it.* · reference [0-9a-f]{16}$/,
    );
  });
});
