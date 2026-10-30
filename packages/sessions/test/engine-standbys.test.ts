import * as fs from "node:fs";
import * as path from "node:path";

import {
  CaptureStoreRepo,
  HotWorkspacesRepo,
  SessionGitOpsRepo,
  type SessionGitOpRow,
  UserDotfilesRepo,
  linuxLoginNameOf,
  makeHarnessLayoutsMemoryState,
} from "@mend/db";
import { SessionId, WorktreeId, type DotfilesRepository } from "@mend/domain";
import { HotWorkspace, Project, Session } from "@mend/domain/workbench";
import type { HarnessLayout } from "@mend/domain/workbench";
import {
  type CaptureFlushKind,
  CONTROL_PLANE_UNREADABLE,
  PersonLayoutPlatform,
  type PersonSessionOptions,
  SealantClient,
  type SealantClientShape,
  SealantPlatformError,
  type WorkspaceStopOptions,
} from "@mend/sealant";
import { type CaptureCompletionSeal, HARNESS_HOME_MOUNT_PATH, SessionEngine } from "@mend/sessions";
import { BlobStoreFsLive, captureKeys, DotfilesStore, decodeManifest } from "@mend/store";
import { buildManifest, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type {
  CreateOptions,
  Workspace,
  WorkspaceCaptureOwnerMap,
  WorkspaceCaptureReplanned,
} from "@sealant/sdk";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Queue } from "effect";
import { describe, expect } from "vitest";

import { REMOTE_SSH_ROOT_WORDS } from "../src/harness-layout-steps.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  NEWER_SNAPSHOT,
  SNAPSHOT,
  failureText,
  flushReport,
  isShellProfileExec,
  isWarmup,
  launchOnce,
  lifecycleLayer,
  memoryHotPool,
  memorySeals,
  shipHarnessCapture,
} from "./engine/capture-fixture.ts";
import { makeStandbyClock, signal, signalled } from "./engine/clock-fixture.ts";
import {
  captureAnswer,
  drawnLine,
  gitOpsStubLayer,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  type World,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";
import {
  LAYOUT_READY,
  MARIA,
  answerLayout,
  perAccountKeys,
  personPlatform,
} from "./engine/person-fixture.ts";

/**
 * The shared standby clock (pool rows, a claim's registration wait), and what these cases wait on
 * besides: every reconcile pass (`listForProject`), and every stop the platform answered, where a
 * drain's termination wait starts.
 */
const makePoolClock = (pool: ReturnType<typeof memoryHotPool>) =>
  Effect.gen(function* () {
    const standby = yield* makeStandbyClock(pool);
    /** A reconcile pass reads the project's rows first; passes run one at a time per project. */
    const passes = yield* Queue.make<void>();
    const poolLayer: Layer.Layer<HotWorkspacesRepo> = Layer.effect(
      HotWorkspacesRepo,
      Effect.map(HotWorkspacesRepo, (inner) => ({
        ...inner,
        listForProject: (projectId) => signal(passes)(inner.listForProject(projectId)),
      })),
    ).pipe(Layer.provide(standby.poolLayer));
    /** The platform answered a stop: a drain's termination wait starts here. */
    const stops = yield* Queue.make<void>();
    const wrapSealant = (layer: Layer.Layer<SealantClient>): Layer.Layer<SealantClient> =>
      Layer.effect(
        SealantClient,
        Effect.map(SealantClient, (inner) => ({
          ...inner,
          stopWorkspace: (workspace, options) =>
            signal(stops)(inner.stopWorkspace(workspace, options)),
        })),
      ).pipe(Layer.provide(layer));
    const untilStopped = signalled(stops);
    /**
     * One drain's termination wait, driven: the platform answered the stop, then Mend looks every
     * `pollInterval` until `terminationWait` is out. `before` runs one look short of it.
     */
    const terminationWait = (
      policy: {
        readonly terminationWait: Duration.Duration;
        readonly pollInterval: Duration.Duration;
      },
      before: () => void,
    ) =>
      Effect.gen(function* () {
        yield* Queue.take(stops);
        const looks =
          Duration.toMillis(policy.terminationWait) / Duration.toMillis(policy.pollInterval);
        for (let look = 1; look < looks; look++) yield* TestClock.adjust(policy.pollInterval);
        before();
        yield* TestClock.adjust(policy.pollInterval);
      });
    /**
     * Every pass requested before this one has ended once this one starts: what a settle sleep
     * after a reconcile waited for, read from the pool instead of the clock.
     */
    const afterPasses = (reconcile: Effect.Effect<void>) =>
      Effect.gen(function* () {
        yield* Queue.clear(passes);
        yield* reconcile;
        yield* Queue.take(passes);
      });
    return { ...standby, poolLayer, wrapSealant, untilStopped, afterPasses, terminationWait };
  });

type PoolClock = Effect.Success<ReturnType<typeof makePoolClock>>;

/** What an owner's dotfiles resolve to right now, as a hot-pool test changes them. */
interface DotfilesState {
  repository: DotfilesRepository | null;
  snapshot: { readonly sha: string; readonly data: string };
}

/** A capture route's refusal reason, or `ok`. */
const routeReason = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  effect.pipe(
    Effect.as("ok"),
    Effect.catch((error) => Effect.succeed(error.reason)),
  );

describe("SessionEngine capture mode", () => {
  it.effect(
    "under the default, keeps standbys in the layout launches run: shared ones where they run shared, person ones booted as their owner once they run per person, never draining a claimed one (docs/adr/0016, per-person standbys)",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const homes: Array<string | undefined> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        const logs: Array<string> = [];
        const state = makeHarnessLayoutsMemoryState();
        // Core's report on the image, as it changes under the test: first a runtime that cannot run
        // per person (Kubernetes' no-new-privileges), then one that can.
        const coreSays: { person: boolean | null; missing: ReadonlyArray<string> } = {
          person: false,
          missing: ["sudo-no-new-privileges"],
        };
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const hot = new Project({ ...project, hotSessions: 2 });
              world.projects.set(project.id, hot);
              world.recentOwners = ["user-fixture"];
              const engine = yield* SessionEngine;
              // Every launch would run shared: shared standbys, booted as before.
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.filter((entry) => entry.status === "ready").length === 2,
                "two standbys",
              );
              expect(pool.entries.map((entry) => entry.harnessLayout)).toEqual([
                "shared",
                "shared",
              ]);
              expect(homes).toEqual([undefined, undefined]);
              expect(created.every((options) => options.source?.kind === "capture")).toBe(true);
              expect(
                created.some(
                  (options) => options.source?.kind === "capture" && "ownerMap" in options.source,
                ),
              ).toBe(false);
              // One is claimed by a launch in flight.
              const first = pool.entries[0];
              if (first === undefined) throw new Error("no standby");
              pool.entries[0] = new HotWorkspace({ ...first, status: "claimed" });
              // Now a fresh worktree would run per person: the ready shared standby could never be
              // claimed, and goes; the claimed one is the launch's; person standbys warm in its place.
              coreSays.person = true;
              coreSays.missing = [];
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () =>
                  pool.entries.filter(
                    (entry) => entry.status === "ready" && entry.harnessLayout === "person",
                  ).length === 2,
                "two person standbys",
              );
              expect(pool.entries.map((entry) => [entry.status, entry.harnessLayout])).toEqual([
                ["claimed", "shared"],
                ["ready", "person"],
                ["ready", "person"],
              ]);
              // Booted as their owner: their logins in their own home, their owner map naming them
              // alone, and no dotfiles at boot.
              const owner = state.identities.get("user-fixture");
              if (owner === undefined) throw new Error("no identity made for the standby's owner");
              expect(homes.slice(2)).toEqual([
                `/home/${owner.name} ${owner.uid}:40000`,
                `/home/${owner.name} ${owner.uid}:40000`,
              ]);
              for (const options of created.slice(2)) {
                expect(options.source).toMatchObject({
                  kind: "capture",
                  ownerMap: {
                    gid: 40000,
                    worktreeUid: owner.uid,
                    people: [{ id: "user-fixture", uid: owner.uid }],
                  },
                });
                expect(options.dotfiles).toBeUndefined();
              }
              expect(logs.some((line) => line.includes("warm skipped"))).toBe(false);
            }),
          {
            captured: memory,
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
              undefined,
              undefined,
              { createHomes: homes },
            ),
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
            harnessLayout: { flag: "person", platform: personPlatform([], coreSays), state },
            logs,
          },
        );
      }),
  );

  it.effect(
    "a claimed standby found dead gives up its claim at once: the cold launch does not wait it out (review round 4)",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        let standbyDead = false;
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((entry) => entry.status === "ready"),
                "a standby",
              );
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "codex",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              expect(memory.leases.get(session.worktreeId)?.launchId).toBe(`standby:${session.id}`);
              // The standby's container died between the claim and the launch.
              standbyDead = true;
              const launched = yield* engine.launch(session.id, ["codex"]);
              expect(launched.status).toBe("running");
              const lease = memory.leases.get(session.worktreeId);
              expect(lease?.executorId).toBe(session.id);
              expect(lease?.launchId).not.toBe(`standby:${session.id}`);
            }),
          {
            captured: memory,
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
              undefined,
              undefined,
              {
                status: () => (standbyDead ? "stopped" : "ready"),
                beforeCreate: () =>
                  Effect.sync(() => {
                    if (standbyDead) standbyDead = false;
                  }),
              },
            ),
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );

  it.effect(
    "keeps the pool per owner: one standby for each recent owner who may run here, never for anyone else, and another owner's session goes cold",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              world.members.set("user-teammate", "member");
              world.members.set("user-late", "member");
              // user-gone ran sessions here but is no longer a member of the organization.
              world.recentOwners = ["user-teammate", "user-gone", "user-fixture"];
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.filter((entry) => entry.status === "ready").length === 2,
                "a standby per eligible owner",
              );
              expect(pool.entries.map((entry) => entry.ownerUserId).toSorted()).toEqual([
                "user-fixture",
                "user-teammate",
              ]);
              expect(created).toHaveLength(2);

              // An owner with no standby of their own is served cold; nobody else's is spent.
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-late",
                start: { kind: "base", base: null },
              });
              expect(pool.entries.map((entry) => entry.id)).not.toContain(session.id);
              expect(
                pool.entries
                  .filter((entry) => entry.ownerUserId !== "user-late")
                  .every((entry) => entry.status === "ready"),
              ).toBe(true);

              // Losing access drains that owner's standby on the next pass.
              world.members.delete("user-teammate");
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () =>
                  pool.entries.every((entry) => entry.ownerUserId !== "user-teammate") &&
                  pool.entries.some(
                    (entry) => entry.ownerUserId === "user-late" && entry.status === "ready",
                  ),
                "the former member's standby to drain and user-late's to warm",
              );
              // user-late's cold session made them a recent owner; the pool now serves them too.
              expect(pool.entries.map((entry) => entry.ownerUserId).toSorted()).toEqual([
                "user-fixture",
                "user-late",
              ]);
            }),
          {
            captured: memory,
            sealantLayer: sealantLaunchLayer(created),
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );

  it.effect(
    "warms a standby without a dotfiles source that fails, and the row records what was left out",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        const repository: DotfilesRepository = {
          url: "git://127.0.0.1:1/dots",
          ref: null,
          subdirectory: null,
          manager: "auto",
          bootstrap: true,
        };
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((entry) => entry.status !== "warming"),
                "the standby to settle",
              );
              const entry = pool.entries[0];
              expect(entry?.status).toBe("ready");
              expect(created).toHaveLength(1);
              expect(created[0]?.dotfiles).toBeUndefined();
              expect(entry?.dotfiles).toEqual({
                repository: { url: repository.url, ref: null },
                snapshotSha: null,
                notApplied: [
                  {
                    source: "repository",
                    reason: expect.stringMatching(
                      /^dotfiles clone of git:\/\/127\.0\.0\.1:1\/dots failed: /,
                    ),
                  },
                ],
              });
            }),
          {
            captured: memory,
            sealantLayer: sealantLaunchLayer(created),
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
            userDotfilesLayer: Layer.succeed(UserDotfilesRepo, {
              repository: () => Effect.succeed(repository),
              setRepository: (_userId, value) => Effect.succeed(value),
              startAgentsAfterInstall: () => Effect.succeed(false),
              setStartAgentsAfterInstall: (_userId, value) => Effect.succeed(value),
            }),
          },
        );
      }),
  );

  const unreachableDotfiles = "git://127.0.0.1:1";
  const warmedRepository: DotfilesRepository = {
    url: `${unreachableDotfiles}/dots`,
    ref: null,
    subdirectory: "dots",
    manager: "stow",
    bootstrap: true,
  };
  it.effect.each<{
    readonly label: string;
    readonly change: (state: DotfilesState, world: World, project: Project) => void;
  }>([
    {
      label: "a new snapshot",
      change: (state) => {
        state.snapshot = NEWER_SNAPSHOT;
      },
    },
    {
      label: "another repository",
      change: (state) => {
        state.repository = { ...warmedRepository, url: `${unreachableDotfiles}/other-dots` };
      },
    },
    {
      label: "another branch",
      change: (state) => {
        state.repository = { ...warmedRepository, ref: "laptop" };
      },
    },
    {
      label: "another manager",
      change: (state) => {
        state.repository = { ...warmedRepository, manager: "chezmoi" };
      },
    },
    {
      label: "another subdirectory",
      change: (state) => {
        state.repository = { ...warmedRepository, subdirectory: null };
      },
    },
    {
      label: "install.sh off",
      change: (state) => {
        state.repository = { ...warmedRepository, bootstrap: false };
      },
    },
    {
      label: "no repository",
      change: (state) => {
        state.repository = null;
      },
    },
    {
      label: "dotfiles turned off for the project",
      change: (_state, world, project) => {
        world.projects.set(project.id, new Project({ ...project, applyDotfiles: false }));
      },
    },
  ])("a standby is claimed only while its owner's dotfiles are unchanged: $label", ({ change }) =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const pool = memoryHotPool();
      const clock = yield* makePoolClock(pool);
      const state: DotfilesState = { repository: warmedRepository, snapshot: SNAPSHOT };
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, adopted) =>
          Effect.gen(function* () {
            const project = new Project({ ...adopted, hotSessions: 1 });
            world.projects.set(project.id, project);
            const engine = yield* SessionEngine;
            const provision = engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.reconcileHotSessions(project.id);
            yield* clock.untilReady(
              () => pool.entries.some((entry) => entry.status === "ready"),
              "a standby",
            );
            expect(created[0]?.dotfiles).toEqual({
              archives: [{ data: SNAPSHOT.data, manager: "copy", bootstrap: false }],
            });

            const stale = pool.entries.find((entry) => entry.status === "ready");
            if (stale === undefined) throw new Error("no standby before the change");
            change(state, world, project);
            const session = yield* provision;
            expect(session.id).not.toBe(stale.id);

            yield* engine.reconcileHotSessions(project.id);
            yield* clock.untilReady(
              () =>
                pool.entries.every((entry) => entry.id !== stale.id) &&
                pool.entries.some((entry) => entry.status === "ready"),
              "the stale standby to drain and a fresh one to warm",
            );
            const applies = world.projects.get(project.id)?.applyDotfiles === true;
            const fresh = pool.entries.find((entry) => entry.status === "ready");
            expect(fresh?.dotfiles).toMatchObject({
              repository:
                !applies || state.repository === null
                  ? null
                  : { url: state.repository.url, ref: state.repository.ref },
              snapshotSha: applies ? state.snapshot.sha : null,
            });

            const claimed = yield* clock.claim(provision);
            expect(claimed.id).toBe(fresh?.id);
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(created),
          hotWorkspacesLayer: clock.poolLayer,
          wrapCaptureChannel: clock.wrapCaptureChannel,
          userDotfilesLayer: Layer.succeed(UserDotfilesRepo, {
            repository: () => Effect.sync(() => state.repository),
            setRepository: (_userId, value) => Effect.succeed(value),
            startAgentsAfterInstall: () => Effect.succeed(false),
            setStartAgentsAfterInstall: (_userId, value) => Effect.succeed(value),
          }),
          dotfilesStoreLayer: Layer.succeed(DotfilesStore, {
            snapshot: () => Effect.die("not in test"),
            current: () =>
              Effect.sync(() => ({
                sha: state.snapshot.sha,
                source: "laptop",
                committedAt: new Date(0),
                files: [],
              })),
            archive: () => Effect.sync(() => state.snapshot),
            clear: () => Effect.void,
          }),
        },
      );
    }),
  );

  it.effect(
    "a person's first session goes cold and starts warming for them; at most four people are warmed for",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              world.recentOwners = [];
              const engine = yield* SessionEngine;
              yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* clock.untilReady(
                () =>
                  pool.entries.some(
                    (entry) => entry.ownerUserId === "user-fixture" && entry.status === "ready",
                  ),
                "a standby for the new owner",
              );

              for (const name of ["a", "b", "c", "d"]) world.members.set(`user-${name}`, "member");
              world.recentOwners = ["user-a", "user-b", "user-c", "user-d"];
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.filter((entry) => entry.status === "ready").length === 4,
                "four owners warmed",
              );
              yield* clock.afterPasses(engine.reconcileHotSessions(project.id));
              // user-fixture's session is the most recent; user-d is fifth and gets nothing.
              expect(pool.entries.map((entry) => entry.ownerUserId).toSorted()).toEqual([
                "user-a",
                "user-b",
                "user-c",
                "user-fixture",
              ]);
            }),
          {
            captured: memory,
            sealantLayer: sealantLaunchLayer(created),
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );

  it.effect(
    "a claim rechecks the owner: a standby of someone who lost access is not handed to them",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((entry) => entry.status === "ready"),
                "a standby",
              );
              const standby = pool.entries[0];
              if (standby === undefined) throw new Error("no standby");
              world.members.delete("user-fixture");
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              expect(session.id).not.toBe(standby.id);
            }),
          {
            captured: memory,
            sealantLayer: sealantLaunchLayer(created),
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );

  it("a workspace's git transport reaches only the project's own remote with the owner's signer", async () => {
    const created: Array<CreateOptions> = [];
    const keysAsked: Array<string> = [];
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
          const api = servedSocketApis.get(session.id);
          if (api === undefined) throw new Error("the session serves no socket api");
          const origin = new URL(project.originUrl ?? "");
          keysAsked.length = 0;
          const elsewhere = yield* api
            .gitTransport({
              host: "github.com",
              port: null,
              command: "git-receive-pack 'acme/api.git'",
            })
            .pipe(Effect.exit);
          expect(failureText(elsewhere)).toContain(`bound to ${origin.hostname}`);
          // Git may supply the destination with its remote user. Both allowed forms must
          // produce a usable plan, rather than merely fail for a different reason.
          for (const destination of [origin.hostname, `git@${origin.hostname}`]) {
            const allowed = yield* api
              .gitTransport({
                host: destination,
                port: null,
                command: "git-upload-pack 'fixture.git'",
              })
              .pipe(Effect.exit);
            if (!Exit.isSuccess(allowed)) throw new Error(failureText(allowed));
            expect(allowed.value.kind).toBe("fetch");
            expect(allowed.value.argv.slice(0, 5)).toEqual([
              "ssh",
              "-F",
              "/dev/null",
              "-i",
              "/keys/user-fixture",
            ]);
            expect(allowed.value.argv.slice(-3)).toEqual([
              "--",
              destination,
              "git-upload-pack 'fixture.git'",
            ]);
          }
          const posing = yield* api
            .gitTransport({
              host: `${origin.hostname}@github.com`,
              port: null,
              command: "git-receive-pack 'acme/api.git'",
            })
            .pipe(Effect.exit);
          expect(failureText(posing)).toContain(`bound to ${origin.hostname}`);
          expect(keysAsked).toEqual(["user-fixture", "user-fixture"]);
        }),
      { sealantLayer: sealantLaunchLayer(created), mendKeysLayer: perAccountKeys(keysAsked) },
    );
  });

  it.each([
    { command: "git-upload-pack 'fixture.git'; printf injected", kind: null },
    { command: "git-upload-pack 'fixture.git'\nprintf injected", kind: null },
    { command: 'git-upload-pack "$(printf fixture.git)"', kind: null },
    { command: "git-upload-pack 'fixture.git' extra-argument", kind: null },
    { command: "git-upload-pack 'fixture.git'", kind: "fetch" },
  ])(
    "a workspace git transport validates the full command: $command",
    async ({ command, kind }) => {
      const created: Array<CreateOptions> = [];
      const keysAsked: Array<string> = [];
      const operations: Array<SessionGitOpRow> = [];
      const gitOpsLayer: Layer.Layer<SessionGitOpsRepo> = Layer.effect(
        SessionGitOpsRepo,
        Effect.map(SessionGitOpsRepo, (inner) => ({
          ...inner,
          record: (op) =>
            inner
              .record(op)
              .pipe(Effect.tap((row) => Effect.sync(() => void operations.push(row)))),
        })),
      ).pipe(Layer.provide(gitOpsStubLayer));
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
            const api = servedSocketApis.get(session.id);
            if (api === undefined) throw new Error("the session serves no socket api");
            const host = `git@${new URL(project.originUrl ?? "").hostname}`;
            keysAsked.length = 0;
            operations.length = 0;
            const result = yield* api.gitTransport({ host, port: null, command }).pipe(Effect.exit);
            if (kind === null) {
              expect(failureText(result)).toContain("this socket carries git transport only");
              expect(keysAsked).toEqual([]);
              expect(operations).toEqual([]);
              return;
            }
            if (!Exit.isSuccess(result)) throw new Error(failureText(result));
            expect(result.value).toEqual({
              opId: operations[0]?.id,
              kind: "fetch",
              argv: [
                "ssh",
                "-F",
                "/dev/null",
                "-i",
                "/keys/user-fixture",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "BatchMode=yes",
                "-o",
                "SendEnv=GIT_PROTOCOL",
                "--",
                host,
                command,
              ],
            });
            expect(keysAsked).toEqual(["user-fixture"]);
            expect(operations).toHaveLength(1);
            expect(operations[0]).toMatchObject({
              sessionId: session.id,
              projectId: project.id,
              host,
              port: null,
              kind: "fetch",
              command,
              authMode: "mend-key",
            });
          }),
        {
          sealantLayer: sealantLaunchLayer(created),
          mendKeysLayer: perAccountKeys(keysAsked),
          gitOpsLayer,
        },
      );
    },
  );

  it("a session with no owner launches as nobody: it settles failed before any platform call", async () => {
    const created: Array<CreateOptions> = [];
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
            ownerUserId: null,
            start: { kind: "base", base: null },
          });
          const failure = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
          expect(failure._tag === "SealantPlatformError" ? failure.code : failure._tag).toBe(
            "NO_PRINCIPAL",
          );
          expect(created).toHaveLength(0);
          expect(world.sessions.get(session.id)?.status).toBe("failed");
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  /**
   * Review 2026-09-28 (3) #1: a standby's `capture.replan` answer is lost after it re-planned onto
   * the worktree, registered a final capture and sealed it. The seal names the standby's launch
   * (what its plan answered); it must never be attested for any other executor.
   */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const standbyWhoseReplanAnswerIsLost = (
    stopAnswer: "kept" | "stopped",
    ran: (
      world: World,
      session: Session,
      standbyLaunch: string,
      epoch: number | undefined,
      clock: PoolClock,
    ) => Effect.Effect<void, unknown, SessionEngine>,
  ) => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    const records = new Map<string, CaptureCompletionSeal>();
    const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
    let executor: SessionId | null = null;
    let root = "";
    let resource = "standby-container";
    return {
      stopOptions,
      created,
      memory,
      records,
      run: () =>
        Effect.gen(function* () {
          const clock = yield* makePoolClock(pool);
          yield* withPreparedEngineEffect(
            (world, tmp) => setup(tmp, world),
            (world, tmp, project) =>
              Effect.gen(function* () {
                root = tmp;
                world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
                const engine = yield* SessionEngine;
                yield* engine.reconcileHotSessions(project.id);
                yield* clock.untilReady(
                  () => pool.entries.some((e) => e.status === "ready"),
                  "standby",
                );
                const standby = pool.entries[0];
                if (standby === undefined) throw new Error("no standby");
                const session = yield* clock.claim(
                  engine.provision({
                    projectId: project.id,
                    harness: "codex",
                    label: null,
                    name: null,
                    ownerUserId: "user-fixture",
                    start: { kind: "base", base: null },
                  }),
                );
                expect(session.id).toBe(standby.id);
                const epoch = memory.leases.get(session.worktreeId)?.epoch;
                executor = session.id;
                yield* ran(world, session, `standby:${standby.id}`, epoch, clock);
              }),
            {
              captured: memory,
              seals: memorySeals(records),
              hotWorkspacesLayer: clock.poolLayer,
              wrapCaptureChannel: clock.wrapCaptureChannel,
              sealantLayer: clock.wrapSealant(
                lifecycleLayer(created, {
                  captureOps: {
                    stopOptions,
                    stopAnswer: () => stopAnswer,
                    status: (stopAsked) =>
                      stopAsked && stopAnswer === "stopped" ? "stopped" : "ready",
                    // Kept: Core keeps the standby for recovery — its disk may hold work.
                    ...(stopAnswer === "kept"
                      ? {
                          retained: () => ({
                            reason: "the platform did not observe its final flush",
                            recoverable: true,
                          }),
                        }
                      : {}),
                    // Kept: no final flush answer ever says complete (the relay closed). Ended: the
                    // executors answer as a current sealantd does.
                    ...(stopAnswer === "kept" ? { finalCompletion: "unreported" as const } : {}),
                    resourceId: () => resource,
                    beforeCreate: (options) =>
                      Effect.sync(() => {
                        if (
                          options.source?.kind === "capture" &&
                          options.source.worktreeId !== undefined
                        ) {
                          resource = "cold-container";
                        }
                      }),
                    replan: () =>
                      Effect.gen(function* () {
                        if (executor === null) throw new Error("no executor");
                        const api = servedSocketApis.get(executor)?.capture;
                        if (api === undefined) throw new Error("no api");
                        const plan = yield* api
                          .planGet({ worktree_id: null, epoch: 0 })
                          .pipe(Effect.orDie);
                        const built = yield* shipHarnessCapture(
                          root,
                          memory,
                          WorktreeId.make(plan.worktree_id),
                          plan.epoch,
                          crypto.randomUUID(),
                          "final",
                        ).pipe(Effect.orDie);
                        // sealantd seals under the executor its plan named, and nothing else.
                        records.set(`${plan.worktree_id}:${plan.epoch}`, {
                          worktreeId: WorktreeId.make(plan.worktree_id),
                          epoch: plan.epoch,
                          executorId: plan.executor,
                          captureId: built.id,
                          n: built.manifest.n,
                          sealedAt: new Date(),
                        });
                        return yield* new SealantPlatformError({
                          code: "lost_replan_ack",
                          status: 503,
                          message: "replan reply lost",
                          cause: null,
                        });
                      }),
                  },
                }),
              ),
            },
          );
        }),
    };
  };

  it.effect(
    "e2e run 6 #4 shrinking the pool honours Core's stop: a standby still draining keeps its token and its row (failed, never claimed); only a confirmed end takes them",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        const tokenEvents: Array<string> = [];
        const drain = { terminationWait: Duration.millis(50), pollInterval: Duration.millis(10) };
        let answer: "draining" | "stopped" = "draining";
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((e) => e.status === "ready"),
                "standby",
              );
              const standby = pool.entries[0];
              if (standby === undefined) throw new Error("no standby");
              // The pool shrinks while Core is still draining the standby.
              world.projects.set(project.id, new Project({ ...project, hotSessions: 0 }));
              yield* engine.reconcileHotSessions(project.id);
              // Mend watches for the termination the whole wait: one look short of it, the row is
              // still ready.
              yield* clock.terminationWait(drain, () => {
                expect(pool.entries.find((e) => e.id === standby.id)?.status).toBe("ready");
              });
              yield* clock.untilReady(
                () => pool.entries.find((e) => e.id === standby.id)?.status === "failed",
                "the kept standby's row",
              );
              expect(tokenEvents.filter((event) => event.startsWith("revoke"))).toEqual([]);
              // Core confirms the end: the next pass takes the token and the row.
              answer = "stopped";
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => !pool.entries.some((e) => e.id === standby.id),
                "the ended standby's row gone",
              );
              expect(tokenEvents).toContain(`revokeLaunch:standby:${standby.id}`);
            }),
          {
            captured: memory,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
            tokenEvents,
            drainPolicy: drain,
            sealantLayer: clock.wrapSealant(
              lifecycleLayer(created, {
                captureOps: {
                  stopAnswer: () => answer,
                  status: (stopAsked) => (stopAsked && answer === "stopped" ? "stopped" : "ready"),
                  resourceId: () => "standby-container",
                },
              }),
            ),
          },
        );
      }),
    30_000,
  );

  it.effect(
    "e2e run 6 #3 a claimed standby whose replan failed still ships under its placeholder: its launch's routes stay the standby's there, never `wrong-worktree`; the session's worktree stays the session's",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        const answers: Record<string, string> = {};
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((e) => e.status === "ready"),
                "standby",
              );
              const standby = pool.entries[0];
              if (standby === undefined) throw new Error("no standby");
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "codex",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
              // The replan failed (the relay paused): the launch drains the standby, which the
              // platform keeps, and nothing else starts.
              yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              const routes = servedSocketApis.get(session.id)?.captureAs?.(`standby:${standby.id}`);
              if (routes === undefined) throw new Error("no launch-bound routes");
              const alias = `standby-${standby.id}`;
              answers["upload.urls · placeholder"] = yield* routeReason(
                routes.uploadUrls({
                  worktree_id: alias,
                  epoch: standby.createdAt.getTime(),
                  keys: [captureKeys(alias, standby.createdAt.getTime()).pack("a".repeat(64))],
                }),
              );
              answers["heartbeat · placeholder"] = yield* routeReason(
                routes.heartbeat({ worktree_id: alias, epoch: standby.createdAt.getTime() }),
              );
              answers["heartbeat · session"] = yield* routeReason(
                routes.heartbeat({ worktree_id: session.worktreeId, epoch }),
              );
            }),
          {
            captured: memory,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                stopAnswer: () => "kept",
                status: () => "ready",
                retained: () => ({ reason: "kept for recovery", recoverable: true }),
                finalCompletion: "unreported",
                resourceId: () => "standby-container",
                replan: () =>
                  Effect.fail(
                    new SealantPlatformError({
                      code: "replan_refused",
                      status: 503,
                      message: "capture plan.get failed: transport: timeout",
                      cause: null,
                    }),
                  ),
              },
            }),
          },
        );
        // The standby's own answer under its placeholder (nothing to ship until claimed), never the
        // session's `wrong-worktree`; the session's worktree is still routed as the session's.
        expect(answers["upload.urls · placeholder"]).toBe("lease-lost");
        expect(answers["heartbeat · placeholder"]).toBe("ok");
        expect(answers["heartbeat · session"]).not.toBe("wrong-worktree");
      }),
    30_000,
  );

  it.effect(
    "review 3 #1 a standby whose replan answer was lost is the session's executor: it drains, its seal is attested for it alone, and kept, nothing else starts",
    () =>
      Effect.gen(function* () {
        const scenario = standbyWhoseReplanAnswerIsLost(
          "kept",
          (world, session, standbyLaunch, epoch) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const refused = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              expect(refused._tag).toBe("SealantPlatformError");
              expect("code" in refused ? refused.code : null).toBe("capture_not_saved");
              // No second executor: nothing was created for the worktree, the epoch is the claim's.
              expect(
                scenario.created.some(
                  (o) => o.source?.kind === "capture" && o.source.worktreeId === session.worktreeId,
                ),
              ).toBe(false);
              expect(scenario.memory.leases.get(session.worktreeId)?.epoch).toBe(epoch);
              // The standby is the session's, under its own launch, and the stop attested its seal
              // for it — its runtime, its launch.
              expect(world.executorLaunches.get(session.id)?.launchId).toBe(standbyLaunch);
              const completions = scenario.stopOptions.flatMap((o) =>
                o?.completion === undefined ? [] : [o.completion],
              );
              expect(completions.length).toBeGreaterThan(0);
              for (const completion of completions) {
                expect(completion).toEqual({
                  executorId: "standby-container",
                  epoch,
                  captureN: scenario.records.get(`${session.worktreeId}:${epoch}`)?.n,
                  launchId: standbyLaunch,
                  sealedAt: scenario.records
                    .get(`${session.worktreeId}:${epoch}`)
                    ?.sealedAt.toISOString(),
                });
              }
            }),
        );
        yield* scenario.run();
      }),
    30_000,
  );

  it.effect(
    "review 3 #1 once the standby's end is observed, a cold executor starts under a fresh epoch and its own launch, and the standby's seal is never attested for it",
    () =>
      Effect.gen(function* () {
        const scenario = standbyWhoseReplanAnswerIsLost(
          "stopped",
          (world, session, standbyLaunch, epoch, clock) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              yield* engine.launch(session.id, ["codex"]);
              const cold = world.executorLaunches.get(session.id)?.launchId ?? "";
              expect(cold).toMatch(new RegExp(`^launch:${session.id}:`));
              expect(cold).not.toBe(standbyLaunch);
              expect(scenario.memory.leases.get(session.worktreeId)?.epoch).toBe((epoch ?? 0) + 1);
              const before = scenario.stopOptions.length;
              yield* engine.stop(session.id);
              yield* clock.untilStopped(
                () => scenario.stopOptions.length > before,
                "the cold executor's stop",
              );
              // The cold executor sealed nothing under its epoch: its stop, saved on its own word,
              // attests nothing — least of all the standby's seal.
              expect(
                scenario.stopOptions.slice(before).every((o) => o?.completion === undefined),
              ).toBe(true);
              expect(scenario.records.get(`${session.worktreeId}:${epoch}`)?.executorId).toBe(
                standbyLaunch,
              );
            }),
        );
        yield* scenario.run();
      }),
    30_000,
  );

  it.effect(
    "e2e9 F-B: nothing executes in a capture-mode standby before its claim; the helper, setup and note run after the replan",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const spawned: ReadonlyArray<string>[] = [];
        const flushed: string[] = [];
        const execCalls: ReadonlyArray<string>[] = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        /** Every exec reaching the standby, as it lands in `execCalls`. */
        const execs = yield* Queue.make<void>();
        /** How many execs had reached the standby when its replan was asked. */
        const execsAtReplan: Array<number> = [];
        let executor: SessionId | null = null;
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
        const flush = () => Effect.succeed(captureAnswer({ epoch: 2 }));
        const replan = (_workspace: Workspace) =>
          Effect.gen(function* () {
            execsAtReplan.push(execCalls.length);
            if (executor === null) throw new Error("no executor to replan");
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
              filesWritten: 0,
              bytesWritten: 0,
              filesSkipped: 0,
              bytesSkipped: 0,
              removed: 0,
              unchanged: false,
            } satisfies WorkspaceCaptureReplanned;
          });
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((entry) => entry.status === "ready"),
                "a standby",
              );
              // Warmed and ready: not one exec reached it (before: the helper install and the
              // prewarm note, each clearing sealantd's unclaimed marker).
              expect(execCalls).toEqual([]);
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "codex",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              expect(pool.entries.some((entry) => entry.id === session.id)).toBe(true);
              executor = session.id;
              yield* engine.launch(session.id, ["codex"]);
              expect(execsAtReplan).toEqual([0]);
              // After the replan: the helper and git transport, and the note, as a cold launch has.
              expect(execCalls.some((argv) => argv.join(" ").includes("core.sshCommand"))).toBe(
                true,
              );
              expect(execCalls.length).toBeGreaterThan(1);
              // The harness warm-up is one of them: warmed at its claim, for the harness it starts.
              const warmups = () => execCalls.filter(isWarmup).map((argv) => argv.at(-1));
              while (warmups().length === 0) yield* Queue.take(execs);
              expect(warmups()).toEqual(["codex"]);
            }),
          {
            captured: memory,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              spawned,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              execCalls,
              undefined,
              { flushed, replan, flush, exec: () => void Queue.offerUnsafe(execs, undefined) },
            ),
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );

  it.effect(
    "a worktree claims the standby: the session adopts its id, the lease is taken at a fresh epoch with the executor as holder, the launch re-plans it onto the worktree, its first register parents on capture 0, a fresh standby warms, a second worktree claims that one, and a join goes cold",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const spawned: ReadonlyArray<string>[] = [];
        const flushed: string[] = [];
        const execCalls: ReadonlyArray<string>[] = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        /** What sealantd's `capture.replan` does: `plan.get` with no worktree named, as the executor. */
        const replans: Array<{ readonly workspaceId: string; readonly executorId: SessionId }> = [];
        /** The executor's flush leaves captures pending (a stalled daemon). */
        let partialFlush = false;
        const flush = () =>
          Effect.succeed(captureAnswer({ epoch: 2, pending: partialFlush ? 3 : 0 }));
        const answered: Array<{
          readonly worktreeId: string;
          readonly epoch: number;
          readonly headN: number | null;
        }> = [];
        let executor: SessionId | null = null;
        const replan = (workspace: Workspace) =>
          Effect.gen(function* () {
            if (executor === null) throw new Error("no executor to replan");
            replans.push({ workspaceId: workspace.id, executorId: executor });
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
            answered.push({
              worktreeId: plan.worktree_id,
              epoch: plan.epoch,
              headN: plan.head?.n ?? null,
            });
            return {
              worktreeId: plan.worktree_id,
              epoch: plan.epoch,
              ...(plan.head === null
                ? {}
                : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
              filesWritten: 0,
              bytesWritten: 0,
              filesSkipped: 1,
              bytesSkipped: 14,
              removed: 0,
              unchanged: false,
            } satisfies WorkspaceCaptureReplanned;
          });
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((entry) => entry.status === "ready"),
                "a standby",
              );
              const standby = pool.entries[0];
              if (standby === undefined) throw new Error("no standby");
              const alias = `standby-${standby.id}`;

              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "codex",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              // The session adopted the standby's id; the worktree's lease is a FRESH epoch (capture
              // 0 went in under Mend's epoch 1) held by the executor, at the launch claim's TTL.
              expect(session.id).toBe(standby.id);
              const lease = memory.leases.get(session.worktreeId);
              expect(lease?.executorId).toBe(session.id);
              expect(lease?.epoch).toBe(2);
              expect((lease?.expiresAt ?? 0) - memory.clock.now()).toBeGreaterThan(60_000);
              expect(memory.chains.get(session.worktreeId)?.headN).toBe(0);
              const cap0 = memory.chains.get(session.worktreeId)?.headCapture ?? null;
              // No replan yet: the claim only takes the lease; the launch re-plans.
              expect(replans).toEqual([]);

              executor = session.id;
              yield* engine.launch(session.id, ["codex"]);
              // The claimed standby gets the default shell profile, as a cold executor does.
              expect(execCalls.filter(isShellProfileExec)).toHaveLength(1);
              // The standby's workspace was adopted, not created again, and re-planned exactly once:
              // the channel answered the claimed worktree, the claim's epoch and the head (capture 0).
              expect(spawned.length).toBeGreaterThan(0);
              expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
              expect(replans).toEqual([{ workspaceId: "workspace-1", executorId: session.id }]);
              expect(answered).toEqual([{ worktreeId: session.worktreeId, epoch: 2, headN: 0 }]);
              const epoch = 2;

              // The executor names its worktree from now on; the placeholder is refused.
              const api = servedSocketApis.get(session.id)?.capture;
              if (api === undefined) throw new Error("the session serves no capture api");
              const beat = yield* api.heartbeat({ worktree_id: session.worktreeId, epoch });
              expect(beat).toEqual({ expires_in_secs: 30 });
              const renewedIn =
                (memory.leases.get(session.worktreeId)?.expiresAt ?? 0) - memory.clock.now();
              expect(renewedIn).toBeGreaterThan(25_000);
              expect(renewedIn).toBeLessThanOrEqual(30_000);
              const refused = yield* api.heartbeat({ worktree_id: alias, epoch }).pipe(Effect.flip);
              expect(refused.reason).toBe("wrong-worktree");

              // A checkpoint asks the lease holder to flush before it observes the head.
              yield* engine.checkpointNow(session.id, "user-mark");
              expect(flushed).toEqual(["flush:workspace-1"]);
              // Automatic landing asks the same holder before it reads a turn's change, and hears
              // what the flush came to; nothing is checkpointed for it.
              expect(yield* engine.flushCaptures(session.id, "automatic landing")).toBe("flushed");
              expect(flushed).toEqual(["flush:workspace-1", "flush:workspace-1"]);
              // A flush that leaves captures pending is not a caught-up head.
              partialFlush = true;
              expect(yield* engine.flushCaptures(session.id, "automatic landing")).toBe(
                "incomplete",
              );
              partialFlush = false;

              // …and its first register parents on capture 0 — the head the replan handed it.
              const tree = path.join(tmp, "standby-ship");
              fs.mkdirSync(path.join(tree, "tree"), { recursive: true });
              fs.writeFileSync(path.join(tree, "tree", "edit.txt"), "from the standby\n");
              const keys = captureKeys(session.worktreeId, epoch);
              const snapshot = snapshotDirectory(tree, keys, { chunkSize: 64 });
              const built = buildManifest({
                worktreeId: session.worktreeId,
                n: 1,
                parent: cap0,
                epoch,
                seq: 5,
                kind: "turn",
                git: {
                  packs: [],
                  refs: {},
                  head: "refs/heads/main",
                  fsck: "verified",
                },
                workspace: { root: snapshot.root, packs: snapshot.packs },
              });
              yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]])).pipe(
                Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
              );
              const registered = yield* api.register({
                worktree_id: session.worktreeId,
                epoch,
                n: 1,
                parent: cap0,
                capture_id: built.id,
                manifest_key: built.key,
                manifest: built.manifest,
              });
              expect(registered.head_n).toBe(1);
              expect(memory.captures.get(built.id)?.parent).toBe(cap0);
              expect(memory.captures.get(built.id)?.worktreeId).toBe(session.worktreeId);

              // A fresh standby warms behind the claim…
              yield* clock.untilReady(
                () =>
                  pool.entries.some((entry) => entry.status === "ready" && entry.id !== standby.id),
                "the replacement standby",
              );
              const replacement = pool.entries.find((entry) => entry.status === "ready");
              if (replacement === undefined) throw new Error("no replacement standby");
              expect(replacement.id).not.toBe(standby.id);
              expect(created.filter((request) => request.source?.kind === "capture")).toHaveLength(
                2,
              );

              // …and a second worktree claims it the same way: its own lease, at its own fresh epoch.
              const second = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "claude",
                  label: null,
                  name: "second",
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              expect(second.id).toBe(replacement.id);
              expect(second.worktreeId).not.toBe(session.worktreeId);
              expect(memory.leases.get(second.worktreeId)?.executorId).toBe(second.id);
              expect(memory.leases.get(second.worktreeId)?.epoch).toBe(2);

              // A join into a worktree whose executor holds the lease runs inside the holder: cold,
              // and no standby is spent on it.
              const joined = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              expect(pool.entries.find((entry) => entry.id === joined.id)).toBeUndefined();
              expect(memory.leases.get(session.worktreeId)?.executorId).toBe(session.id);
            }),
          {
            captured: memory,
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              spawned,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              execCalls,
              undefined,
              { flushed, replan, flush },
            ),
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );
  it(
    "user marks never collide on the worktree's checkpoint ordinal: the executor's checkpoint capture is taken when it carries the ordinal, a stale one is observed and not taken, and concurrent marks allocate distinct ordinals through one writer",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const flushed: string[] = [];
      const memory = makeMemoryCaptureStore();
      /** What the executor ships inside its next flush: nothing, or a checkpoint capture. */
      let onFlush: Effect.Effect<void> = Effect.void;
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
            const worktreeId = session.worktreeId;
            const epoch = memory.leases.get(worktreeId)?.epoch ?? 0;
            expect(memory.leases.get(worktreeId)?.executorId).toBe(session.id);
            const api = servedSocketApis.get(session.id)?.capture;
            if (api === undefined) throw new Error("the session serves no capture api");
            const chain = () => world.checkpoints.filter((c) => c.worktreeId === worktreeId);
            const headOf = () => memory.chains.get(worktreeId)?.headCapture ?? null;
            const cap0 = headOf();
            if (cap0 === null) throw new Error("no capture 0");
            // The executor's captures carry capture 0's git section: the base pack and the
            // worktree tree the runner derives from.
            const cap0Key = memory.captures.get(cap0)?.manifestKey ?? "";
            const cap0Manifest = yield* decodeManifest(
              cap0Key,
              new Uint8Array(fs.readFileSync(path.join(tmp, "blobs", cap0Key))),
            ).pipe(Effect.orDie);
            const registerCheckpointCapture = (ordinal: number) =>
              Effect.gen(function* () {
                const parent = headOf();
                const n = (memory.chains.get(worktreeId)?.headN ?? 0) + 1;
                const built = buildManifest({
                  worktreeId,
                  n,
                  parent,
                  epoch,
                  seq: n * 10,
                  kind: "checkpoint",
                  git: cap0Manifest.sections.git,
                  checkpoint: {
                    ordinal,
                    sha: session.baseSha,
                    ref: `refs/mend/checkpoints/${worktreeId}/${ordinal}`,
                  },
                });
                yield* uploadObjects(new Map([[built.key, built.bytes]])).pipe(
                  Effect.provide(BlobStoreFsLive(path.join(tmp, "blobs"))),
                );
                yield* api.register({
                  worktree_id: worktreeId,
                  epoch,
                  n,
                  parent,
                  capture_id: built.id,
                  manifest_key: built.key,
                  manifest: built.manifest,
                });
                return built.id;
              });

            // Ordering 1 — the executor's flush registers a `checkpoint` capture carrying the
            // ordinal the mark is about to allocate: the mark takes it, one row, no derive.
            let shipped: string | null = null;
            onFlush = registerCheckpointCapture(chain().length).pipe(
              Effect.map((id) => {
                shipped = id;
              }),
              Effect.orDie,
            );
            const taken = yield* engine.checkpointNow(session.id, "user-mark");
            expect(flushed).toEqual(["flush:workspace-1"]);
            expect(taken.ordinal).toBe(2);
            expect(taken.sha).toBe(session.baseSha);
            expect(taken.ref).toBe(`refs/mend/checkpoints/${worktreeId}/2`);
            expect(world.checkpointCaptureIds.get(taken.id)).toBe(shipped);
            expect(chain().map((c) => c.ordinal)).toEqual([0, 1, 2]);

            // Ordering 2 — the executor's checkpoint capture lands AFTER the mark that used the
            // ordinal it names (a stale 2): the next mark is observed from it but allocates 3,
            // derived on the runner, never a second row at 2.
            onFlush = Effect.void;
            const stale = yield* registerCheckpointCapture(2);
            const next = yield* engine.checkpointNow(session.id, "user-mark");
            expect(next.ordinal).toBe(3);
            expect(next.ref).toBe(`refs/mend/checkpoints/${worktreeId}/3`);
            expect(next.sha).not.toBe(session.baseSha);
            expect(world.checkpointCaptureIds.get(next.id)).toBe(stale);
            expect(chain().map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);

            // The race — a user mark while the run-end checkpoint is in flight (observed in the
            // packaged acceptance as a 500): both succeed with distinct ordinals, and the
            // per-worktree writer means the unique index never had to refuse an insert.
            const [a, b] = yield* Effect.all(
              [
                engine.checkpointNow(session.id, "user-mark"),
                engine.checkpointNow(session.id, "turn-boundary"),
              ],
              { concurrency: "unbounded" },
            );
            expect([a.ordinal, b.ordinal].toSorted()).toEqual([4, 5]);
            expect(chain().map((c) => c.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
            expect(world.checkpointConflicts.count).toBe(0);
            expect(flushed).toHaveLength(4);
          }),
        {
          captured: memory,
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
            undefined,
            undefined,
            {
              flushed,
              flush: () => onFlush.pipe(Effect.map(() => captureAnswer({ registered: 1 }))),
            },
          ),
        },
      );
    },
  );

  /**
   * e2e8 F7: a claimed standby whose replan failed, on which no writer was ever admitted. sealantd
   * (b58bdeb) answers its FINAL at once `complete: true`, nothing pending, under the placeholder's
   * worktree, epoch and launch (`standby:<id>`), then exits 76, and Core releases it as nothing to
   * save. That answer never reads as the session's save (its epoch is not the session's lease), but
   * the drain reads the workspace gone and the launch goes on cold at once: no ~12 minute wait for
   * staging that never ships, and no `failed` line needing a discard.
   */
  it.effect(
    "a claimed standby whose replan failed and which held nothing ends at once, and the launch goes on cold",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makePoolClock(pool);
        let standbyFinal = false;
        let standbyAlias = "";
        let standbyEpoch = 0;
        let standbyLaunch = "";
        const flushed: Array<string> = [];
        const flushKinds: Array<CaptureFlushKind> = [];
        const stopOptions: Array<WorkspaceStopOptions | undefined> = [];
        const drain = { terminationWait: Duration.millis(50), pollInterval: Duration.millis(10) };
        /** The standby's FINAL, answered complete under its placeholder. */
        const standbyFlushed = yield* Deferred.make<void>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((e) => e.status === "ready"),
                "standby",
              );
              const standby = pool.entries[0];
              if (standby === undefined) throw new Error("no standby");
              standbyAlias = `standby-${standby.id}`;
              standbyEpoch = standby.createdAt.getTime();
              standbyLaunch = `standby:${standby.id}`;
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "codex",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              const startedAt = Date.now();
              const launching = yield* engine.launch(session.id, ["codex"]).pipe(Effect.forkChild);
              // The drain's look after the FINAL, one poll on, reads the workspace gone.
              yield* Deferred.await(standbyFlushed);
              yield* TestClock.adjust(drain.pollInterval);
              yield* Fiber.join(launching);
              expect(Date.now() - startedAt).toBeLessThan(10_000);
              expect(standbyFinal).toBe(true);
              const incoming = world.executorEvidence.get(standby.sealantWorkspaceId ?? "")?.saved;
              expect(incoming?.epoch).toBe(standbyEpoch);
              expect(incoming?.position).toMatchObject({
                epoch: standbyEpoch,
                launchId: standbyLaunch,
                bootId: "placeholder-boot",
                observation: 1,
              });
              expect(memory.leases.get(session.worktreeId)?.epoch).not.toBe(standbyEpoch);
              // The session row repeats the received answer; it is not a current-save selection.
              expect(world.captureSaved.get(session.id)).toMatchObject({
                workspaceId: standby.sealantWorkspaceId,
                epoch: standbyEpoch,
                position: { epoch: standbyEpoch, launchId: standbyLaunch },
              });
              expect(flushKinds).toContain("final");
              const after = world.sessions.get(session.id);
              expect(after?.status).toBe("running");
              expect(drawnLine(after?.summary)).toBeNull();
              expect(after?.captureNotSavedAt ?? null).toBeNull();
              // The standby's complete answer is under its placeholder, not the session's epoch: it
              // is never attested as the session's save.
              expect(stopOptions.every((options) => options?.completion === undefined)).toBe(true);
              // One cold executor after the standby, under the session's own launch.
              expect(created.length).toBeGreaterThanOrEqual(2);
              const current = world.sessions.get(session.id);
              const lease = memory.leases.get(session.worktreeId);
              const launch = world.executorLaunches.get(session.id);
              if (
                current?.sealantWorkspaceId == null ||
                lease === undefined ||
                launch === undefined
              ) {
                throw new Error("the cold successor has no workspace, lease or launch");
              }
              expect(current.sealantWorkspaceId).not.toBe(standby.sealantWorkspaceId);
              expect(launch.launchId).not.toBe(standbyLaunch);
              expect(lease.executorId).toBe(session.id);
              // The public read asks the cold executor, not the saved placeholder answer retained above.
              const reading = yield* engine.readCaptures(session.id);
              expect(reading).toMatchObject({
                pending: 3,
                epoch: lease.epoch,
                complete: null,
                position: {
                  epoch: lease.epoch,
                  launchId: launch.launchId,
                  bootId: "stand-in-boot",
                },
              });
              expect(reading?.epoch).not.toBe(standbyEpoch);
              expect(flushed.at(-1)).toBe(`flush:${current.sealantWorkspaceId}`);
              expect(flushKinds.at(-1)).toBe("suspend");
              expect(stopOptions.every((options) => options?.completion === undefined)).toBe(true);
            }),
          {
            captured: memory,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
            drainPolicy: drain,
            sealantLayer: distinctWorkspaces(
              lifecycleLayer(created, {
                captureOps: {
                  flushed,
                  flushKinds,
                  stopOptions,
                  // Exit 76 after its FINAL, released by Core: the workspace reads stopped from then on.
                  stopAnswer: () => "stopped",
                  resourceId: () => "standby-container",
                  flush: (target) =>
                    Effect.sync(() => {
                      if (target.id !== "workspace-1") return flushReport(3, 0);
                      standbyFinal = true;
                      Deferred.doneUnsafe(standbyFlushed, Effect.void);
                      return flushReport(0, 0, {
                        worktreeId: standbyAlias,
                        epoch: standbyEpoch,
                        origin: {
                          epoch: standbyEpoch,
                          launch: standbyLaunch,
                          bootId: "placeholder-boot",
                          bootGeneration: 1,
                          observation: 1,
                        },
                      });
                    }),
                  replan: () =>
                    Effect.fail(
                      new SealantPlatformError({
                        code: "replan_refused",
                        status: 503,
                        message: "capture plan.get failed: transport: timeout",
                        cause: null,
                      }),
                    ),
                },
              }),
              (id) => id === "workspace-1" && standbyFinal,
            ),
          },
        );
      }),
    30_000,
  );

  it("reads each live executor under its own lease and launch when another worktree was claimed first", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const flushed: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const { project, engine, session: first } = yield* launchOnce(world, tmp);
          yield* engine.launch(first.id, ["codex"]);
          const second = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          // Two completed claims before launch make this worktree's epoch differ independently.
          yield* Effect.gen(function* () {
            const repo = yield* CaptureStoreRepo;
            yield* repo.init(second.worktreeId);
            for (let attempt = 0; attempt < 2; attempt++) {
              const lease = yield* repo.claim(second.worktreeId, second.id, 30);
              expect(yield* repo.release(second.worktreeId, lease.epoch)).toBe(true);
            }
          }).pipe(Effect.provide(memory.layer));
          yield* engine.launch(second.id, ["claude"]);
          const firstLease = memory.leases.get(first.worktreeId);
          const secondLease = memory.leases.get(second.worktreeId);
          expect(firstLease?.epoch).not.toBe(secondLease?.epoch);
          expect(world.sessions.get(first.id)?.sealantWorkspaceId).toBe("workspace-1");
          expect(world.sessions.get(second.id)?.sealantWorkspaceId).toBe("workspace-2");
          for (const session of [first, second]) {
            const lease = memory.leases.get(session.worktreeId);
            const launch = world.executorLaunches.get(session.id);
            if (lease === undefined || launch === undefined)
              throw new Error("no executor identity");
            const reading = yield* engine.readCaptures(session.id);
            expect(reading).toMatchObject({
              pending: 1,
              epoch: lease.epoch,
              position: { epoch: lease.epoch, launchId: launch.launchId },
            });
          }
          expect(flushed).toEqual(["flush:workspace-1", "flush:workspace-2"]);
        }),
      {
        captured: memory,
        sealantLayer: distinctWorkspaces(
          lifecycleLayer(created, {
            captureOps: { flushed, flush: () => Effect.succeed(captureAnswer({ pending: 1 })) },
          }),
        ),
      },
    );
  }, 30_000);
});

/** Distinct created workspace handles and their ends, while the underlying fixture serves PTYs/exec. */
const distinctWorkspaces = (
  layer: Layer.Layer<SealantClient>,
  ended: (id: string) => boolean = () => false,
): Layer.Layer<SealantClient> =>
  Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client) => {
      const workspaces = new Map<string, Workspace>();
      const stopped = new Set<string>();
      return {
        ...client,
        createWorkspace: (options, launch, watch) =>
          client.createWorkspace(options, launch, watch).pipe(
            Effect.map((workspace) => {
              const id = `workspace-${workspaces.size + 1}`;
              const created: Workspace = {
                ...workspace,
                id,
                status: async () => (stopped.has(id) || ended(id) ? "stopped" : "ready"),
              };
              workspaces.set(id, created);
              return created;
            }),
          ),
        getWorkspace: (id) => {
          const workspace = workspaces.get(id);
          return workspace === undefined ? client.getWorkspace(id) : Effect.succeed(workspace);
        },
        stopWorkspace: (workspace, options) =>
          client.stopWorkspace(workspace, options).pipe(
            Effect.tap((answer) =>
              Effect.sync(() => {
                if (answer.state !== "kept") stopped.add(workspace.id);
              }),
            ),
          ),
      } satisfies SealantClientShape;
    }),
  ).pipe(Layer.provide(layer));

describe("per-person standbys (docs/adr/0016)", () => {
  const STANDBY_OWNER = linuxLoginNameOf("user-fixture");

  /**
   * A world whose pool warms per-person standbys for `user-fixture` (Core says the image runs
   * per person), with Maria a member: its replan answers the claimed worktree as sealantd does,
   * recording the map each claim says it expects.
   */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const personStandbyWorld = (options: {
    readonly report: { person: boolean | null; missing: ReadonlyArray<string> };
    readonly exec: (
      argv: ReadonlyArray<string>,
    ) => { exitCode: number; stdout: string; stderr: string } | undefined;
    /** What the control plane says of itself while asked (`CONTROL_PLANE_UNREADABLE` in a blip). */
    readonly controlPlane?: () => string | null;
    /** More of the platform's capture answers, over the defaults (a replan that fails). */
    readonly captureOps?: Omit<
      NonNullable<Parameters<typeof sealantLaunchLayer>[11]>,
      "createHomes" | "exec"
    >;
  }) => {
    const created: Array<CreateOptions> = [];
    const homes: Array<string | undefined> = [];
    const opened: Array<PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const stopped: Array<string> = [];
    const replanned: Array<WorkspaceCaptureOwnerMap | null | undefined> = [];
    const calls: Array<string> = [];
    const pool = memoryHotPool();
    const state = makeHarnessLayoutsMemoryState();
    const executor: { id: SessionId | null } = { id: null };
    const replan = (
      workspace: Workspace,
      replanOptions?: { readonly expectedOwnerMap: WorkspaceCaptureOwnerMap | null },
    ) =>
      Effect.gen(function* () {
        void workspace;
        replanned.push(replanOptions?.expectedOwnerMap);
        const api = servedSocketApis.get(executor.id ?? SessionId.make(""))?.capture;
        if (api === undefined) throw new Error("the executor serves no capture api");
        const plan = yield* api.planGet({ worktree_id: null, epoch: 0 }).pipe(Effect.orDie);
        return {
          worktreeId: plan.worktree_id,
          epoch: plan.epoch,
          ...(plan.head === null
            ? {}
            : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
          filesWritten: 0,
          bytesWritten: 0,
          filesSkipped: 0,
          bytesSkipped: 0,
          removed: 0,
          unchanged: true,
        } satisfies WorkspaceCaptureReplanned;
      });
    const layers = {
      captured: makeMemoryCaptureStore(),
      hotWorkspacesLayer: pool.layer,
      prepareWorld: (world: World) => {
        world.members.set(MARIA, "member");
        world.recentOwners = ["user-fixture"];
      },
      sealantLayer: sealantLaunchLayer(
        created,
        undefined,
        stopped,
        undefined,
        undefined,
        undefined,
        undefined,
        opened,
        undefined,
        execCalls,
        undefined,
        { createHomes: homes, replan, exec: options.exec, ...options.captureOps },
      ),
      harnessLayout: {
        flag: "person" as const,
        platform: personPlatform(
          calls,
          options.report,
          undefined,
          undefined,
          undefined,
          options.controlPlane,
        ),
        state,
      },
      drainPolicy: { terminationWait: Duration.millis(50), pollInterval: Duration.millis(10) },
    };
    return {
      created,
      homes,
      opened,
      execCalls,
      stopped,
      replanned,
      calls,
      pool,
      state,
      executor,
      layers,
    };
  };

  /** Warm the project's pool and wait for its one person standby. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const warmPersonStandby = (
    project: Project,
    pool: ReturnType<typeof memoryHotPool>,
    clock: PoolClock,
  ) =>
    Effect.gen(function* () {
      const engine = yield* SessionEngine;
      yield* engine.reconcileHotSessions(project.id);
      yield* clock.untilReady(
        () =>
          pool.entries.some(
            (entry) => entry.status === "ready" && entry.harnessLayout === "person",
          ),
        "a person standby",
      );
      const standby = pool.entries.find((entry) => entry.harnessLayout === "person");
      if (standby === undefined) throw new Error("no person standby");
      return standby;
    });

  /** A person standby warmed while the owner's person is bound in Core (`bound`) or not, then claimed. */
  const claimStandby = (bound: boolean) => {
    const sshUsers: Array<string | undefined> = [];
    const world = personStandbyWorld({
      report: { person: true, missing: [] },
      exec: answerLayout(LAYOUT_READY),
      captureOps: { createSshUsers: sshUsers },
    });
    const platform = personPlatform(
      world.calls,
      { person: true },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      () => true,
      bound,
    );
    let summary: string | null | undefined;
    return Effect.gen(function* () {
      const clock = yield* makePoolClock(world.pool);
      yield* withPreparedEngineEffect(
        (testWorld, tmp) => setup(tmp, testWorld),
        (testWorld, tmp, project) =>
          Effect.gen(function* () {
            testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
            const engine = yield* SessionEngine;
            const standby = yield* warmPersonStandby(project, world.pool, clock);
            const session = yield* clock.claim(
              engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              }),
            );
            expect(session.id).toBe(standby.id);
            world.executor.id = session.id;
            yield* engine.launch(session.id, ["claude"]);
            const launched = testWorld.sessions.get(session.id);
            expect(launched?.status).not.toBe("failed");
            expect(launched?.sealantWorkspaceId).toBe(standby.sealantWorkspaceId);
            summary = launched?.summary;
          }),
        {
          ...world.layers,
          hotWorkspacesLayer: clock.poolLayer,
          wrapCaptureChannel: clock.wrapCaptureChannel,
          harnessLayout: { ...world.layers.harnessLayout, platform },
        },
      );
      return { sshUsers, summary };
    });
  };

  it.effect(
    "a claimed person standby whose owner's person Core could not bind says Remote-SSH is root (review 3 of mend#641, N4)",
    () =>
      Effect.gen(function* () {
        const run = yield* claimStandby(false);
        // Its create asked for no SSH user, and the claim says so, as the standby's create decided.
        expect(run.sshUsers[0]).toBeUndefined();
        expect(run.summary).toContain(REMOTE_SSH_ROOT_WORDS);
      }),
  );

  it.effect(
    "a claimed person standby whose owner's person is bound keeps their SSH user and says nothing of root",
    () =>
      Effect.gen(function* () {
        const run = yield* claimStandby(true);
        expect(run.sshUsers[0]).toBe(`/home/${STANDBY_OWNER}`);
        expect(run.summary).not.toContain("Remote-SSH: root");
      }),
  );

  it.effect(
    "a person standby, warmed as its owner, is claimed by their fresh worktree and runs per person: their user, a 0700 home, their own logins, their saved directory under people/",
    () =>
      Effect.gen(function* () {
        const world = personStandbyWorld({
          report: { person: true, missing: [] },
          exec: answerLayout(LAYOUT_READY),
        });
        const clock = yield* makePoolClock(world.pool);
        yield* withPreparedEngineEffect(
          (testWorld, tmp) => setup(tmp, testWorld),
          (testWorld, tmp, project) =>
            Effect.gen(function* () {
              testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              const standby = yield* warmPersonStandby(project, world.pool, clock);
              const owner = world.state.identities.get("user-fixture");
              if (owner === undefined) throw new Error("no identity for the standby's owner");
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "claude",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              // The session adopts the standby's id: it was claimed.
              expect(session.id).toBe(standby.id);
              world.executor.id = session.id;
              const execsBefore = world.execCalls.length;
              const startedAt = performance.now();
              yield* engine.launch(session.id, ["claude"]);
              const claimMs = performance.now() - startedAt;
              const claimExecs = world.execCalls.length - execsBefore;
              const launched = testWorld.sessions.get(session.id);
              expect(launched?.status).not.toBe("failed");
              expect(launched?.sealantWorkspaceId).toBe(standby.sealantWorkspaceId);
              // Booted as its owner: their logins in their own home, at the standby's create.
              expect(world.homes[0]).toBe(`/home/${STANDBY_OWNER} ${owner.uid}:40000`);
              // The claim names the map the standby booted with, which Core compares.
              expect(world.replanned).toEqual([
                {
                  gid: 40000,
                  worktreeUid: owner.uid,
                  people: [{ id: "user-fixture", uid: owner.uid }],
                },
              ]);
              // Prepare made the launcher's user, a 0700 home, and their saved directory.
              const prepare = world.execCalls.find((argv) =>
                (argv[2] ?? "").includes("mend-layout"),
              );
              expect(prepare?.[2]).toContain(
                `mend_people='${STANDBY_OWNER}:${owner.uid}:user-fixture:`,
              );
              expect(prepare?.[2]).toContain(`chmod 0700 "$p_h"`);
              expect(prepare?.[2]).toContain(`${HARNESS_HOME_MOUNT_PATH}/people`);
              // The agent runs as them, on their own logins: nothing posted to `/root`.
              const users = world.opened.map((opened) => opened.user?.name ?? null);
              expect(users.length).toBeGreaterThan(0);
              expect(users.every((user) => user === STANDBY_OWNER)).toBe(true);
              expect(world.calls.some((call) => call.endsWith(":/root"))).toBe(false);
              // The worktree is person from this launch on, recorded under the standby's launch.
              expect(world.state.worktrees.get(session.worktreeId)?.layout).toBe("person");
              expect(world.state.launches.get(`standby:${standby.id}`)).toMatchObject({
                layout: "person",
                confirmed: true,
              });
              // The claimed standby is the session's: never stopped under it.
              expect(world.stopped).not.toContain(standby.sealantWorkspaceId);
              // The claim path, timed in the engine with fakes: Mend's own work, no platform latency.
              expect(claimMs).toBeLessThan(5_000);
              yield* Effect.logInfo(
                `per-person standby claim · engine time ${claimMs.toFixed(0)} ms · ${claimExecs} execs`,
              );
            }),
          {
            ...world.layers,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );

  it.effect(
    "a person standby claimed by a claude session whose owner has no Claude login is refused before the agent starts, in a join's words (review of mend#671)",
    () =>
      Effect.gen(function* () {
        const world = personStandbyWorld({
          report: { person: true, missing: [] },
          exec: answerLayout(LAYOUT_READY),
        });
        // The owner has no Claude: Core refuses every create naming it (the standby's shell ladder
        // steps past it) and leaves it out of the claim's write into their home.
        const sealantLayer = Layer.effect(
          SealantClient,
          Effect.map(SealantClient, (inner) => ({
            ...inner,
            createWorkspace: (
              options: CreateOptions,
              ...rest: Parameters<typeof inner.createWorkspace> extends [unknown, ...infer R]
                ? R
                : never
            ) =>
              options.credentials?.claude === undefined
                ? inner.createWorkspace(options, ...rest)
                : Effect.fail(
                    new SealantPlatformError({
                      code: "connected-account-missing",
                      status: 404,
                      provider: "claude",
                      message: 'No claude connected account matches "default".',
                      cause: null,
                    }),
                  ),
          })),
        ).pipe(Layer.provide(world.layers.sealantLayer));
        const platform = Layer.effect(
          PersonLayoutPlatform,
          Effect.map(PersonLayoutPlatform, (inner) => ({
            ...inner,
            postCredentials: (
              workspace: Workspace,
              input: Parameters<typeof inner.postCredentials>[1],
            ) =>
              inner.postCredentials(workspace, input).pipe(
                Effect.as({
                  skipped:
                    input.logins.claude === undefined
                      ? []
                      : [
                          {
                            provider: "claude" as const,
                            reason: "connected-account-missing" as const,
                            message: 'No claude connected account matches "default".',
                          },
                        ],
                }),
              ),
          })),
        ).pipe(Layer.provide(personPlatform(world.calls, { person: true })));
        const clock = yield* makePoolClock(world.pool);
        const result = yield* withPreparedEngineEffect(
          (testWorld, tmp) => setup(tmp, testWorld),
          (testWorld, tmp, project) =>
            Effect.gen(function* () {
              testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              const standby = yield* warmPersonStandby(project, world.pool, clock);
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "claude",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              expect(session.id).toBe(standby.id);
              world.executor.id = session.id;
              const refused = yield* engine.launch(session.id, ["claude"]).pipe(Effect.flip);
              return {
                message: refused.message,
                summary: testWorld.sessions.get(session.id)?.summary ?? null,
              };
            }),
          {
            ...world.layers,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
            sealantLayer,
            harnessLayout: { ...world.layers.harnessLayout, platform },
          },
        );
        // The standby's create wrote no Claude, so the claim asked Core for the owner's own and was
        // refused, as a join is; the agent never started signed out.
        expect(result.message).toBe(
          "Connect Claude to start a session here. Connect it in Settings → Connected accounts, or run mend connect claude.",
        );
        expect(result.summary).toContain(
          "launch refused · Connect Claude to start a session here.",
        );
        // Every standby the pool made (the claimed one, and the one warmed in its place) was made
        // without Claude, and so says it holds none.
        expect(world.created[0]?.credentials).toEqual({ codex: true, github: true });
        expect(world.created.every((options) => options.credentials?.claude === undefined)).toBe(
          true,
        );
        expect(world.calls).toContain(`post:user-fixture:/home/${STANDBY_OWNER}`);
        expect(world.opened.filter((options) => options.user?.name === STANDBY_OWNER)).toEqual([]);
      }),
  );

  it.effect(
    "a person standby's claim costs no more execs than a shared standby's, past the person prepare a cold person launch runs too (Performance)",
    () =>
      Effect.gen(function* () {
        const claimOf = (person: boolean) =>
          Effect.gen(function* () {
            const world = personStandbyWorld({
              report: person
                ? { person: true, missing: [] }
                : { person: false, missing: ["sudo-no-new-privileges"] },
              exec: answerLayout(LAYOUT_READY),
            });
            const clock = yield* makePoolClock(world.pool);
            let execs = -1;
            yield* withPreparedEngineEffect(
              (testWorld, tmp) => setup(tmp, testWorld),
              (testWorld, tmp, project) =>
                Effect.gen(function* () {
                  testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
                  const engine = yield* SessionEngine;
                  yield* engine.reconcileHotSessions(project.id);
                  yield* clock.untilReady(
                    () => world.pool.entries.some((entry) => entry.status === "ready"),
                    "a standby",
                  );
                  const standby = world.pool.entries[0];
                  const session = yield* clock.claim(
                    engine.provision({
                      projectId: project.id,
                      harness: "claude",
                      label: null,
                      name: null,
                      ownerUserId: "user-fixture",
                      start: { kind: "base", base: null },
                    }),
                  );
                  expect(session.id).toBe(standby?.id);
                  world.executor.id = session.id;
                  const before = world.execCalls.length;
                  yield* engine.launch(session.id, ["claude"]);
                  execs = world.execCalls.length - before;
                }),
              {
                ...world.layers,
                hotWorkspacesLayer: clock.poolLayer,
                wrapCaptureChannel: clock.wrapCaptureChannel,
              },
            );
            return execs;
          });
        const shared = yield* claimOf(false);
        const person = yield* claimOf(true);
        expect(shared).toBeGreaterThan(0);
        // The person prepare rides the helper's exec (no new exec); its own deliveries replace the
        // shared ones into `/root`, as a cold person launch's do.
        expect(person).toBeLessThanOrEqual(shared);
      }),
  );

  it.effect(
    "another person's launch, the operator's shared, and a worktree another person owns each go cold: the person standby stays ready",
    () =>
      Effect.gen(function* () {
        const world = personStandbyWorld({
          report: { person: true, missing: [] },
          exec: answerLayout(LAYOUT_READY),
        });
        const clock = yield* makePoolClock(world.pool);
        yield* withPreparedEngineEffect(
          (testWorld, tmp) => setup(tmp, testWorld),
          (testWorld, tmp, project) =>
            Effect.gen(function* () {
              testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              const standby = yield* warmPersonStandby(project, world.pool, clock);
              const provision = (
                ownerUserId: string,
                extra: { harnessLayout?: HarnessLayout } = {},
              ) =>
                engine.provision({
                  projectId: project.id,
                  harness: "claude",
                  label: null,
                  name: null,
                  ownerUserId,
                  start: { kind: "base", base: null },
                  ...extra,
                });
              // Maria's fresh worktree: never another person's standby (owner's rule).
              const maria = yield* provision(MARIA);
              expect(maria.id).not.toBe(standby.id);
              // The operator's shared on a fresh worktree of the owner's: a person standby runs per person.
              const shared = yield* provision("user-fixture", { harnessLayout: "shared" });
              expect(shared.id).not.toBe(standby.id);
              // The owner's session in Maria's worktree: its owner map would name the wrong owner.
              const inMarias = yield* engine.provisionSessionIn(maria.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-fixture",
              });
              expect(inMarias.id).not.toBe(standby.id);
              expect(world.pool.entries.find((entry) => entry.id === standby.id)?.status).toBe(
                "ready",
              );
              expect(world.replanned).toEqual([]);
            }),
          {
            ...world.layers,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );

  it.effect(
    "a claimed person standby's decision stands against a no learnt since: its prepare falls back to shared in it with the logins in /root, and the session runs (review 2 of mend#582, N7)",
    () =>
      Effect.gen(function* () {
        const report: { person: boolean | null; missing: ReadonlyArray<string> } = {
          person: true,
          missing: [],
        };
        const world = personStandbyWorld({
          report,
          exec: answerLayout("mend-layout probed\nmend-layout missing no sudo\n"),
        });
        const clock = yield* makePoolClock(world.pool);
        yield* withPreparedEngineEffect(
          (testWorld, tmp) => setup(tmp, testWorld),
          (testWorld, tmp, project) =>
            Effect.gen(function* () {
              testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              const standby = yield* warmPersonStandby(project, world.pool, clock);
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "claude",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              expect(session.id).toBe(standby.id);
              world.executor.id = session.id;
              // Between the claim and its launch, Core learns the image cannot run per person.
              report.person = false;
              report.missing = ["no sudo"];
              yield* engine.launch(session.id, ["claude"]);
              const launched = testWorld.sessions.get(session.id);
              expect(launched?.status).not.toBe("failed");
              expect(launched?.sealantWorkspaceId).toBe(standby.sealantWorkspaceId);
              // Decision 1's fallback, in the standby: the home released, the logins in /root.
              expect(world.calls).toContain(`delete:/home/${STANDBY_OWNER}`);
              expect(world.calls).toContain("post:user-fixture:/root");
              expect(world.opened.every((opened) => opened.user === undefined)).toBe(true);
              expect(world.state.worktrees.get(session.worktreeId)?.layout ?? null).toBeNull();
            }),
          {
            ...world.layers,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );

  it.effect(
    "a person standby whose replan fails ends, and the cold executor that follows decides its own launch: a person record under its own key, the full owner map on its create, and the standby's dotfiles do not hold it up (review of mend#596, S1)",
    () =>
      Effect.gen(function* () {
        let standbyFinal = false;
        let standbyAlias = "";
        let standbyEpoch = 0;
        /** The standby's FINAL, answered complete under its placeholder. */
        const standbyFlushed = yield* Deferred.make<void>();
        const world = personStandbyWorld({
          report: { person: true, missing: [] },
          exec: answerLayout(LAYOUT_READY),
          captureOps: {
            // Exit 76 after its FINAL, released by Core: the workspace reads stopped from then on.
            status: () => (standbyFinal ? "stopped" : "ready"),
            stopAnswer: () => "stopped",
            resourceId: () => "standby-container",
            flush: () =>
              Effect.sync(() => {
                standbyFinal = true;
                Deferred.doneUnsafe(standbyFlushed, Effect.void);
                return flushReport(0, 0, { worktreeId: standbyAlias, epoch: standbyEpoch });
              }),
            replan: () =>
              Effect.fail(
                new SealantPlatformError({
                  code: "replan_refused",
                  status: 503,
                  message: "capture plan.get failed: transport: timeout",
                  cause: null,
                }),
              ),
          },
        });
        const clock = yield* makePoolClock(world.pool);
        yield* withPreparedEngineEffect(
          (testWorld, tmp) => setup(tmp, testWorld),
          (testWorld, tmp, project) =>
            Effect.gen(function* () {
              testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              const standby = yield* warmPersonStandby(project, world.pool, clock);
              standbyAlias = `standby-${standby.id}`;
              standbyEpoch = standby.createdAt.getTime();
              const owner = world.state.identities.get("user-fixture");
              if (owner === undefined) throw new Error("no identity for the standby's owner");
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "claude",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              expect(session.id).toBe(standby.id);
              const createsBefore = world.created.length;
              const launching = yield* engine.launch(session.id, ["claude"]).pipe(Effect.forkChild);
              // The drain's look after the FINAL, one poll on, reads the workspace gone.
              yield* Deferred.await(standbyFlushed);
              yield* TestClock.adjust(world.layers.drainPolicy.pollInterval);
              yield* Fiber.join(launching);
              const launched = testWorld.sessions.get(session.id);
              expect(launched?.status).toBe("running");
              expect(standbyFinal).toBe(true);
              // A cold executor under its own launch, never the standby's.
              const cold = testWorld.executorLaunches.get(session.id)?.launchId ?? "";
              expect(cold).not.toBe(`standby:${standby.id}`);
              expect(cold).not.toBe("");
              // Its layout is decided for its own launch: until its prepare confirmed it, the
              // channel read it from this record, never as a shared executor's.
              expect(world.state.launches.get(cold)).toMatchObject({
                layout: "person",
                confirmed: true,
              });
              // Its create sends the worktree's whole owner map, as any cold person launch does.
              const coldCreate = world.created
                .slice(createsBefore)
                .find(
                  (options) =>
                    options.source?.kind === "capture" && options.source.worktreeId !== undefined,
                );
              expect(coldCreate?.source).toMatchObject({
                ownerMap: {
                  gid: 40000,
                  worktreeUid: owner.uid,
                  people: expect.arrayContaining([{ id: "user-fixture", uid: owner.uid }]),
                },
              });
              const users = world.opened.map((opened) => opened.user?.name ?? null);
              expect(users.length).toBeGreaterThan(0);
              expect(users.every((user) => user === STANDBY_OWNER)).toBe(true);
            }),
          {
            ...world.layers,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
    30_000,
  );

  it.effect(
    "a claimed person standby whose worktree turned person since its claim goes, before anything runs in it, and the launch goes on cold (review of mend#596, N1)",
    () =>
      Effect.gen(function* () {
        const world = personStandbyWorld({
          report: { person: true, missing: [] },
          exec: answerLayout(LAYOUT_READY),
          captureOps: { stopAnswer: () => "stopped", status: () => "ready" },
        });
        const clock = yield* makePoolClock(world.pool);
        yield* withPreparedEngineEffect(
          (testWorld, tmp) => setup(tmp, testWorld),
          (testWorld, tmp, project) =>
            Effect.gen(function* () {
              testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              const standby = yield* warmPersonStandby(project, world.pool, clock);
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "claude",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              expect(session.id).toBe(standby.id);
              const createsBefore = world.created.length;
              // Between the claim and its launch, the worktree is recorded person by another launch:
              // its saved directories may name people the standby's map does not.
              world.state.worktrees.set(session.worktreeId, { layout: "person", requested: null });
              yield* engine.launch(session.id, ["claude"]);
              const launched = testWorld.sessions.get(session.id);
              expect(launched?.status).toBe("running");
              // Never replanned, so nothing was restored under the standby's map; drained instead.
              expect(world.replanned).toEqual([]);
              expect(world.stopped).toContain(standby.sealantWorkspaceId);
              // A cold executor of the worktree's own, with the worktree's owner map.
              expect(
                world.created
                  .slice(createsBefore)
                  .some(
                    (options) =>
                      options.source?.kind === "capture" &&
                      options.source.worktreeId === session.worktreeId &&
                      "ownerMap" in options.source,
                  ),
              ).toBe(true);
              expect(testWorld.executorLaunches.get(session.id)?.launchId).not.toBe(
                `standby:${standby.id}`,
              );
            }),
          {
            ...world.layers,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
    30_000,
  );

  it.effect(
    "keeps the pool as it is while the control plane cannot be asked: the person standby stays ready and nothing is warmed in its place (review of mend#596, N4)",
    () =>
      Effect.gen(function* () {
        let controlPlane: string | null = null;
        const world = personStandbyWorld({
          report: { person: true, missing: [] },
          exec: answerLayout(LAYOUT_READY),
          controlPlane: () => controlPlane,
        });
        const clock = yield* makePoolClock(world.pool);
        yield* withPreparedEngineEffect(
          (testWorld, tmp) => setup(tmp, testWorld),
          (testWorld, tmp, project) =>
            Effect.gen(function* () {
              testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              const standby = yield* warmPersonStandby(project, world.pool, clock);
              const created = world.created.length;
              controlPlane = CONTROL_PLANE_UNREADABLE;
              yield* engine.reconcileHotSessions(project.id);
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.afterPasses(engine.reconcileHotSessions(project.id));
              expect(world.pool.entries.map((entry) => [entry.id, entry.status])).toEqual([
                [standby.id, "ready"],
              ]);
              expect(world.created.length).toBe(created);
              expect(world.stopped).not.toContain(standby.sealantWorkspaceId);
            }),
          {
            ...world.layers,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );

  it.effect(
    "while the control plane cannot be asked, an image Mend knows runs shared still has its shared standby claimed (review of mend#596, N2)",
    () =>
      Effect.gen(function* () {
        let controlPlane: string | null = null;
        const world = personStandbyWorld({
          report: { person: null, missing: [] },
          exec: answerLayout(LAYOUT_READY),
          controlPlane: () => controlPlane,
        });
        const clock = yield* makePoolClock(world.pool);
        yield* withPreparedEngineEffect(
          (testWorld, tmp) => setup(tmp, testWorld),
          (testWorld, tmp, project) =>
            Effect.gen(function* () {
              testWorld.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              // Mend's own record: a prepare found this image cannot run per person.
              world.state.capabilities.set(`digest:sha256:img\u0000docker`, {
                imageKey: "digest:sha256:img",
                runtime: "docker",
                person: false,
                missing: ["no sudo"],
                confirmed: true,
                observedAt: new Date(),
              });
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => world.pool.entries.some((entry) => entry.status === "ready"),
                "a shared standby",
              );
              const standby = world.pool.entries[0];
              expect(standby?.harnessLayout).toBe("shared");
              controlPlane = CONTROL_PLANE_UNREADABLE;
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "claude",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              expect(session.id).toBe(standby?.id);
            }),
          {
            ...world.layers,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
          },
        );
      }),
  );
});
