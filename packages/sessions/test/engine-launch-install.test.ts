// What a launch installs and first shows: the automatic install, the workspace note, and an
// agent's first screen.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Project, noResumeLine } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { BlobStoreFsLive, captureKeys } from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, TimelineEntry } from "@sealant/sdk";
import { ConfigProvider, Deferred, Duration, Effect, Stream } from "effect";
import { describe, expect } from "vitest";

import { installScript } from "../src/dependency-cache.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { makeLaunchClock } from "./engine-launch-recovery-fixtures.ts";
import {
  CUSTOM_BASE,
  isWarmup,
  launchOnce,
  lifecycleLayer,
  provisionIn,
} from "./engine/capture-fixture.ts";
import {
  fakeExecRun,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

// "Automatic install": on (the default), a fresh worktree's launch runs the project's install
// command before the harness; off, the launch runs none, saved command or detected.
describe("automatic install", () => {
  const INSTALL = "echo automatic-install-ran";
  for (const installEnabled of [true, false]) {
    it(`${installEnabled ? "on" : "off"}: a fresh launch ${installEnabled ? "runs" : "runs no"} install command`, async () => {
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const logs: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const project = world.projects.get(session.projectId);
            if (project === undefined) throw new Error("project missing");
            world.projects.set(
              project.id,
              new Project({ ...project, installCommand: INSTALL, installEnabled }),
            );
            yield* engine.launch(session.id, ["codex"]);
            const installs = execCalls.filter(
              (argv) => argv[0] === "sh" && argv[1] === "-lc" && argv[2] === INSTALL,
            );
            expect(installs).toHaveLength(installEnabled ? 1 : 0);
            expect(
              logs.some((line) =>
                line.includes("dependency install skipped · automatic install off"),
              ),
            ).toBe(!installEnabled);
          }),
        {
          captured: memory,
          logs,
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
  }

  // A plain pnpm install runs with Mend's fetch timeouts (`installScript`), and the line it logs
  // says how many fetch retries the output reported, counted from the execs' output alone. When
  // the shortened install fails on fetch timeouts (a registry slower than 15 s to answer), the
  // command runs once more as written, with pnpm's defaults, and a line says so.
  const RETRY =
    " WARN  GET https://registry.npmjs.org/a/-/a-1.0.0.tgz error (ERR_SOCKET_TIMEOUT). Will retry in 2 seconds. 2 retries left.";
  const GIVE_UP =
    " ERR_SOCKET_TIMEOUT  request to https://registry.npmjs.org/a/-/a-1.0.0.tgz failed, reason: Socket timeout\n";
  for (const shortened of ["completes", "fails on fetch timeouts"] as const) {
    it(`a detected pnpm install runs with fetch timeouts; ${shortened === "completes" ? "it completes and logs its fetch retries" : "it fails on fetch timeouts, runs again with pnpm's defaults and says so"}`, async () => {
      const PNPM = "pnpm install --frozen-lockfile";
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const logs: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const project = world.projects.get(session.projectId);
            if (project === undefined) throw new Error("project missing");
            world.projects.set(project.id, new Project({ ...project, installCommand: PNPM }));
            yield* engine.launch(session.id, ["codex"]);
            const installs = execCalls
              .filter((argv) => argv[0] === "sh" && argv[1] === "-lc")
              .map((argv) => argv[2])
              .filter((script) => script === installScript(PNPM) || script === PNPM);
            const retried = logs.some((line) =>
              line.includes("dependency install · retried with defaults"),
            );
            if (shortened === "completes") {
              expect(installs).toEqual([installScript(PNPM)]);
              expect(retried).toBe(false);
              expect(
                logs.some((line) =>
                  line.includes("dependency install · completed · exit 0 · fetch retries 2"),
                ),
              ).toBe(true);
            } else {
              expect(installs).toEqual([installScript(PNPM), PNPM]);
              expect(retried).toBe(true);
              // The end line keeps its shape: the rerun's exit, the retries of both runs.
              expect(
                logs.some((line) =>
                  line.includes("dependency install · completed · exit 0 · fetch retries 1"),
                ),
              ).toBe(true);
            }
            // Only the count is logged, never the output it was counted from.
            expect(logs.some((line) => line.includes("registry.npmjs.org"))).toBe(false);
          }),
        {
          captured: memory,
          logs,
          sealantLayer: lifecycleLayer(created, {
            execCalls,
            captureOps: {
              exec: (argv) =>
                (argv[2] ?? "").startsWith("uname -s; uname -m;")
                  ? { exitCode: 0, stdout: "Linux\nx86_64\nldd (GNU libc) 2.39\n", stderr: "" }
                  : argv[2] === installScript(PNPM)
                    ? shortened === "completes"
                      ? {
                          exitCode: 0,
                          stdout: ["Packages: +2024", RETRY, RETRY, "Done in 31.2s"].join("\n"),
                          stderr: "",
                        }
                      : { exitCode: 1, stdout: `${RETRY}\n`, stderr: GIVE_UP }
                    : argv[2] === PNPM
                      ? { exitCode: 0, stdout: "Done in 20.2s using pnpm v10.32.1\n", stderr: "" }
                      : undefined,
            },
          }),
        },
      );
    });
  }

  // The server's npm mirror (`MEND_NPM_MIRROR_URL`): the install script carries it, and a run that
  // failed on the mirror runs again as written, so it reaches the registry itself.
  for (const mirrored of ["completes", "fails on the mirror"] as const) {
    it(`with the server's npm mirror, the install goes through it; ${mirrored === "completes" ? "it completes" : "it fails on the mirror and runs again without it"}`, async () => {
      const PNPM = "pnpm install --frozen-lockfile";
      const MIRROR = "http://npm-mirror:4873/";
      const created: Array<CreateOptions> = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const memory = makeMemoryCaptureStore();
      const logs: string[] = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launchOnce(world, tmp);
            const project = world.projects.get(session.projectId);
            if (project === undefined) throw new Error("project missing");
            world.projects.set(project.id, new Project({ ...project, installCommand: PNPM }));
            // What `mend server setup`'s mirrors overlay hands the server.
            yield* engine
              .launch(session.id, ["codex"])
              .pipe(
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromEnv({ env: { MEND_NPM_MIRROR_URL: MIRROR } }),
                ),
              );
            const installs = execCalls
              .filter((argv) => argv[0] === "sh" && argv[1] === "-lc")
              .map((argv) => argv[2])
              .filter((script) => script === installScript(PNPM, MIRROR) || script === PNPM);
            const fellBack = logs.some((line) =>
              line.includes("dependency install · retried without the npm mirror"),
            );
            expect(installs).toEqual(
              mirrored === "completes"
                ? [installScript(PNPM, MIRROR)]
                : [installScript(PNPM, MIRROR), PNPM],
            );
            expect(fellBack).toBe(mirrored !== "completes");
            expect(
              logs.some((line) => line.includes("dependency install · completed · exit 0")),
            ).toBe(true);
          }),
        {
          captured: memory,
          logs,
          sealantLayer: lifecycleLayer(created, {
            execCalls,
            captureOps: {
              exec: (argv) =>
                (argv[2] ?? "").startsWith("uname -s; uname -m;")
                  ? { exitCode: 0, stdout: "Linux\nx86_64\nldd (GNU libc) 2.39\n", stderr: "" }
                  : argv[2] === installScript(PNPM, MIRROR)
                    ? mirrored === "completes"
                      ? {
                          exitCode: 0,
                          stdout: "Done in 6.1s using pnpm v10.32.1\n",
                          stderr: `mend: npm mirror · used · ${MIRROR}\n`,
                        }
                      : {
                          exitCode: 1,
                          stdout: "",
                          stderr: `mend: npm mirror · used · ${MIRROR}\n ERR_PNPM_FETCH_502  GET ${MIRROR}a/-/a-1.0.0.tgz: Bad Gateway - 502\n`,
                        }
                    : argv[2] === PNPM
                      ? { exitCode: 0, stdout: "Done in 20.2s using pnpm v10.32.1\n", stderr: "" }
                      : undefined,
            },
          }),
        },
      );
    });
  }
});

/**
 * Review 2026-09-28 (17) #1: a cold resume rewrote Mend's note in the restored harness memory
 * files by cutting each file at the old `<!-- mend:mounts -->` marker, so whatever the user or
 * the agent wrote below the note was lost. The reviewer's probe, kept whole: the actual engine
 * launches, the note command it emits runs against a real directory standing in for the executor
 * home, the text appended after the note is registered in a sealed capture, and the resume runs
 * the note command again over the restored copy. Three starting points: a fresh home (owner text
 * before, user text after the bounded block), a home holding the note the pre-fix engine wrote
 * with user text after it (`fixtures/workspace-note-legacy.txt`: that engine's output, captured and
 * cold-restored by sealantd), and the same old note with a line the user wrote inside it.
 */
const noteBlockCount = (text: string) => text.split("<!-- mend:workspace-note:begin").length - 1;

describe("review 17 #1: the workspace note never takes the user's text with it", () => {
  const legacyFixture = fs.readFileSync(
    new URL("./fixtures/workspace-note-legacy.txt", import.meta.url),
    "utf8",
  );
  const legacyUserText = "\n## My project notes\nKeep the migration compatibility shim until v3.\n";
  const insideEdit = "Never touch /workspace/ref/api by hand.\n";
  const scenarios = [
    {
      name: "a fresh home: owner text before the block and user text after it survive a resume",
      initial: "# Owner instructions\nUse the local test runner.\n",
      kept: ["# Owner instructions\nUse the local test runner.\n"],
      legacyKept: false,
    },
    {
      name: "the pre-fix engine's open-ended note becomes the block; the text after it stays",
      initial: legacyFixture,
      kept: ["# Owner instructions\nUse the local test runner.\n", legacyUserText],
      legacyKept: false,
    },
    {
      name: "an old note with the user's own line inside it is left whole, and the block is added",
      initial: legacyFixture.replace(
        "Mounted beside the repo:\n\n",
        `Mounted beside the repo:\n\n${insideEdit}`,
      ),
      kept: ["# Owner instructions\nUse the local test runner.\n", insideEdit, legacyUserText],
      legacyKept: true,
    },
  ] as const;

  for (const scenario of scenarios) {
    it.effect(
      scenario.name,
      () =>
        Effect.gen(function* () {
          const created: Array<CreateOptions> = [];
          const memory = makeMemoryCaptureStore();
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r17-notes-"));
          const saved = path.join(root, "saved");
          const notes = [".claude/CLAUDE.md", ".codex/AGENTS.md"];
          const userText =
            "\n## Appended in the session\nRun the migration check before every push.\n";
          let executorHome = "";
          let noteRuns = 0;
          const beforeResume: string[] = [];
          const clock = yield* makeLaunchClock;
          yield* withPreparedEngineEffect(
            (world, tmp) => setup(tmp, world),
            (world, tmp, project) =>
              Effect.gen(function* () {
                const { engine, session } = yield* provisionIn(project);
                yield* engine.launch(session.id, ["codex"]);
                expect(noteRuns).toBe(1);
                const firstLaunch: Array<string> = [];
                for (const note of notes) {
                  const target = path.join(executorHome, note);
                  const written = fs.readFileSync(target, "utf8");
                  for (const text of scenario.kept) expect(written).toContain(text);
                  firstLaunch.push(written);
                  fs.appendFileSync(target, userText);
                }
                const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
                const chain = memory.chains.get(session.worktreeId);
                const n = (chain?.headN ?? 0) + 1;
                const snapshotRoot = path.join(root, "snapshot");
                fs.mkdirSync(snapshotRoot);
                fs.cpSync(executorHome, path.join(snapshotRoot, "harness"), { recursive: true });
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
                fs.cpSync(executorHome, saved, { recursive: true, preserveTimestamps: true });
                yield* engine.stop(session.id);
                yield* clock.untilChanged(
                  () =>
                    world.sessions.get(session.id)?.captureDrain === null &&
                    world.sessions.get(session.id)?.status === "stopped",
                  "saved stop",
                );
                const resumed = yield* engine.resumeSession(session.id, "shell");
                expect(created).toHaveLength(2);
                expect(noteRuns).toBe(2);
                expect(beforeResume).toHaveLength(2);
                for (const text of beforeResume) expect(text).toContain(userText);
                expect(resumed.status).toBe("running");
                const afterResume = notes.map((note) =>
                  fs.readFileSync(path.join(executorHome, note), "utf8"),
                );
                // What the user and the agent wrote comes through the resume.
                for (const after of afterResume) {
                  expect(after).toContain(userText);
                  for (const text of scenario.kept) expect(after).toContain(text);
                }
                // One bounded block; an old note is gone only where it matched exactly.
                for (const written of firstLaunch) {
                  expect(noteBlockCount(written)).toBe(1);
                  expect(written.includes("<!-- mend:mounts -->")).toBe(scenario.legacyKept);
                }
                // The restored file was already current: the resume wrote nothing, byte for byte.
                for (const [index, after] of afterResume.entries()) {
                  expect(after).toBe(beforeResume[index]);
                  expect(noteBlockCount(after)).toBe(1);
                }
              }),
            {
              captured: memory,
              prepareWorld: clock.prepareWorld,
              workspaceImage: { ...CUSTOM_BASE, setupCommands: [] },
              sealantLayer: lifecycleLayer(created, {
                captureOps: {
                  stopAnswer: () => "stopped",
                  beforeCreate: () =>
                    Effect.sync(() => {
                      executorHome = path.join(root, `home-${created.length}`);
                      if (created.length === 1) {
                        for (const note of notes) {
                          fs.mkdirSync(path.dirname(path.join(executorHome, note)), {
                            recursive: true,
                          });
                          fs.writeFileSync(path.join(executorHome, note), scenario.initial);
                        }
                      } else {
                        fs.cpSync(saved, executorHome, {
                          recursive: true,
                          preserveTimestamps: true,
                        });
                        beforeResume.push(
                          ...notes.map((note) =>
                            fs.readFileSync(path.join(executorHome, note), "utf8"),
                          ),
                        );
                      }
                    }),
                  exec: (argv) => {
                    if (
                      argv[0] !== "sh" ||
                      argv[1] !== "-c" ||
                      !(argv[2] ?? "").includes("mend:mounts")
                    ) {
                      return undefined;
                    }
                    noteRuns += 1;
                    const run = spawnSync(argv[0], argv.slice(1), {
                      cwd: executorHome,
                      env: { ...process.env, HOME: executorHome },
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
  }
});

const outputEntry = (sequence: bigint, occurredAt: string, byteCount: string): TimelineEntry => ({
  kind: "ioChunk",
  sequence,
  occurredAt,
  summary: "pty-out",
  data: { stream: 1, byteCount, streamOffset: "0" },
});

describe("an agent's first screen (alpha 2026-09-30)", () => {
  it("a launch warms the harness's files in the background: asked before the agent starts, never waited for", async () => {
    const created: Array<CreateOptions> = [];
    const events: string[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
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
          const launched = yield* engine.launch(session.id, ["claude"]);

          // The warm-up never answered, and the agent started anyway.
          expect(launched.status).toBe("running");
          expect(events.indexOf("warm-up asked")).toBeGreaterThanOrEqual(0);
          expect(events.indexOf("warm-up asked")).toBeLessThan(events.indexOf("agent opened"));
          expect(events).not.toContain("warm-up answered");
          const warmups = execCalls.filter(isWarmup);
          expect(warmups).toHaveLength(1);
          // Read-only toward the user's: from `/`, with a throwaway HOME, for this harness.
          const [, , script, , harness] = warmups[0] ?? [];
          expect(harness).toBe("claude");
          expect(script).toContain("cd / ||");
          expect(script).toContain('HOME="$d"');
          expect(script).toContain('rm -rf "$d"');
        }),
      {
        sealantLayer: lifecycleLayer(created, {
          execCalls,
          captureOps: {
            execEffect: (argv) =>
              isWarmup(argv)
                ? Effect.sync(() => events.push("warm-up asked")).pipe(
                    Effect.andThen(Effect.never),
                    Effect.tap(() => Effect.sync(() => events.push("warm-up answered"))),
                  )
                : undefined,
            beforeOpen: () => {
              events.push("agent opened");
            },
          },
        }),
      },
    );
  });

  it.effect("a warm-up that fails, or runs past its bound, changes nothing about the launch", () =>
    Effect.gen(function* () {
      for (const answer of ["fails", "hangs"] as const) {
        const created: Array<CreateOptions> = [];
        const clock = yield* makeLaunchClock;
        const logs = clock.watched<string>();
        const interrupted: string[] = [];
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
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
              expect(launched.status).toBe("running");
              const ended = () =>
                logs.some((line) => line.includes("harness warm-up · not finished"));
              if (answer === "hangs") {
                // One millisecond short of its bound the warm-up still runs, uninterrupted.
                yield* TestClock.adjust(49);
                expect(ended()).toBe(false);
                expect(interrupted).toEqual([]);
                yield* TestClock.adjust(1);
              }
              yield* clock.untilChanged(ended, `the ${answer} warm-up to end`);
              if (answer === "fails") {
                // Its bound passing after the failure interrupts nothing: the warm-up had ended.
                yield* TestClock.adjust(50);
                expect(interrupted).toEqual([]);
              }
              const after = world.sessions.get(session.id);
              expect(after?.status).toBe("running");
              expect(after?.settledAt ?? null).toBeNull();
              expect(after?.summary).toBe("codex is starting on the new machine");
              // A warm-up past its bound is abandoned, not left running.
              if (answer === "hangs") expect(interrupted).toEqual(["warm-up"]);
            }),
          {
            logs,
            drainPolicy: { harnessWarmupTimeout: Duration.millis(50) },
            sealantLayer: lifecycleLayer(created, {
              execCalls: [],
              captureOps: {
                execEffect: (argv) =>
                  !isWarmup(argv)
                    ? undefined
                    : answer === "fails"
                      ? Effect.fail(
                          new SealantPlatformError({
                            code: "exec_failed",
                            status: 502,
                            message: "the executor did not run the command",
                            cause: null,
                          }),
                        )
                      : Effect.never.pipe(
                          Effect.onInterrupt(() => Effect.sync(() => interrupted.push("warm-up"))),
                        ),
              },
            }),
          },
        );
      }
    }),
  );

  it("a shell or a command of the owner's own warms nothing and never reads as starting", async () => {
    const created: Array<CreateOptions> = [];
    const execCalls: ReadonlyArray<string>[] = [];
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
          const launched = yield* engine.launch(session.id, ["make", "test"]);
          expect(launched.status).toBe("running");
          expect(execCalls.filter(isWarmup)).toEqual([]);
          expect(world.sessions.get(session.id)?.summary ?? null).toBeNull();
        }),
      { sealantLayer: lifecycleLayer(created, { execCalls }) },
    );
  });

  it("refuses to resume a `mend run` command on its own harness, in words, starting nothing", async () => {
    const created: Array<CreateOptions> = [];
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
          yield* engine.launch(session.id, ["make", "test"]);
          yield* engine.stop(session.id);
          const launches = created.length;

          for (const harness of [null, "run"]) {
            const refused = yield* engine.resumeSession(session.id, harness).pipe(Effect.flip);
            expect(refused).toBeInstanceOf(SealantPlatformError);
            expect(refused.message).toBe(noResumeLine("run"));
          }
          expect(created).toHaveLength(launches);
        }),
      { sealantLayer: lifecycleLayer(created) },
    );
  });

  it.effect(
    "the agent reads as starting until its record carries output, then its row says when it drew and the words go",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const drew = "2026-09-30T17:15:41.000Z";
        const drawn = yield* Deferred.make<void>();
        const clock = yield* makeLaunchClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                base: null,
              });
              yield* engine.launch(session.id, ["claude"]);
              const agent = () =>
                [...world.processes.values()].find(
                  (process) => process.sessionId === session.id && process.kind === "agent-pty",
                );
              // Before any output: starting, and the row says nothing drew.
              expect(world.sessions.get(session.id)?.summary).toBe(
                "claude is starting on the new machine",
              );
              expect(agent()?.firstOutputAt ?? null).toBeNull();

              yield* Deferred.succeed(drawn, undefined);
              yield* clock.untilChanged(
                () => agent()?.firstOutputAt != null,
                "the first output to be stamped",
              );
              expect(agent()?.firstOutputAt?.toISOString()).toBe(drew);
              yield* clock.untilChanged(
                () => (world.sessions.get(session.id)?.summary ?? null) === null,
                "the starting words to go",
              );
              expect(world.sessions.get(session.id)?.status).toBe("running");
            }),
          {
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                // The record opens with a heartbeat and an empty chunk; the first bytes come
                // later.
                record: () =>
                  Stream.make(outputEntry(1n, "2026-09-30T17:14:56.000Z", "0")).pipe(
                    Stream.concat(
                      Stream.fromEffect(Deferred.await(drawn)).pipe(
                        Stream.map(() => outputEntry(2n, drew, "312")),
                      ),
                    ),
                    Stream.concat(Stream.fromEffect(Effect.never)),
                  ),
              },
            }),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
  );

  it.effect(
    "a launch whose run settles completed but exited non-zero settles failed, as its PTY end reads",
    () =>
      Effect.gen(function* () {
        // Core settles an interactive session's run `completed` whatever its process exited with.
        // 2026-10-05: two joins whose `claude` could not start read `failed · exited with code 1`
        // and `completed`, depending on whether the PTY watcher or the run's supervision saw the
        // end first.
        const created: Array<CreateOptions> = [];
        const clock = yield* makeLaunchClock;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                base: null,
              });
              yield* engine.launch(session.id, ["claude"]);
              yield* clock.untilChanged(
                () => world.sessions.get(session.id)?.settledAt != null,
                "the session to settle from its run",
              );
              expect(world.sessions.get(session.id)?.status).toBe("failed");
              expect(world.sessions.get(session.id)?.summary).toContain("exited with code 1");
            }),
          {
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                record: () => Stream.empty,
                waitRun: () =>
                  Effect.succeed({
                    ...fakeExecRun,
                    result: { status: "completed", outcome: "completed", exitCode: 1 },
                  }),
              },
            }),
            prepareWorld: clock.prepareWorld,
          },
        );
      }),
  );

  it.effect("an agent that ends before it draws takes its starting words with it", () =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const clock = yield* makeLaunchClock;
      const { ptyStates } = clock;
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(session.id, ["claude"]);
            yield* engine.openShell(session.id);
            expect(world.sessions.get(session.id)?.summary).toBe(
              "claude is starting on the new machine",
            );
            const agent = [...world.processes.values()].find(
              (process) => process.sessionId === session.id && process.kind === "agent-pty",
            );
            if (agent?.sealantSessionId == null) throw new Error("no agent PTY");
            ptyStates.set(agent.sealantSessionId, {
              status: "exited",
              exitCode: 1,
              outputHighWater: 0n,
            });
            // The exit is read at the PTY watcher's next look; nothing ends before it.
            yield* clock.nextLook(
              agent.sealantSessionId,
              () => world.processes.get(agent.id)?.exitedAt == null,
            );
            yield* clock.untilChanged(
              () => world.processes.get(agent.id)?.exitedAt != null,
              "the agent's end to be observed",
            );
            // A shell still holds the workspace, so nothing settled over the line: the words
            // went with the agent.
            yield* clock.untilChanged(
              () => !(world.sessions.get(session.id)?.summary ?? "").includes("claude is starting"),
              "the starting words to go with the agent",
            );
          }),
        {
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            ptyStates,
          ),
          prepareWorld: clock.prepareWorld,
        },
      );
    }),
  );
});
