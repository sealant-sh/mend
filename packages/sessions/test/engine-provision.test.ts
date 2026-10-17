import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SessionRepositoriesRepoMemory,
  InstanceRolesRepo,
  SessionChannelTokensRepoMemory,
  harnessLayoutsRepoMemory,
} from "@mend/db";
import {
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Session, SessionProcess, SessionRun } from "@mend/domain/workbench";
import { PersonLayoutPlatformNone, SealantPlatformError } from "@mend/sealant";
import {
  CaptureRuntimeOff,
  HarnessStateNotFoundError,
  SessionEngine,
  SessionEngineLive,
  SessionRepositoryLocalLive,
  WorkspaceGitHooks,
  WorkspaceGitHooksLive,
  WorkspaceHostUserNamespacesUnobserved,
} from "@mend/sessions";
import {
  Store,
  StoreConfig,
  DeploymentConfigColocated,
  harnessHomePathOf,
  processStatePathOf,
} from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { HarnessLayoutConfigShared } from "../src/harness-layout-steps.ts";
import { HARNESS_UPDATES_OFF_ENV, NO_PAGER_ENV } from "../src/harness-seeds.ts";
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
  agentLoginsLayerOf,
  foldersEmptyLayer,
  gitAuthorStubLayer,
  gitOpsStubLayer,
  hotWorkspacesEmptyLayer,
  makeWorld,
  mendKeysStubLayer,
  now,
  organizationsLayer,
  piProfilesLayerOf,
  projectClusterBindingsLayer,
  projectEnvironmentLayer,
  projectLinksEmptyLayer,
  projectMountsEmptyLayer,
  projectRecipesEmptyLayer,
  projectSecretsLayer,
  projectsLayer,
  protocolHostStubLayer,
  referencesEmptyLayer,
  sealantDeadLayer,
  sealantLaunchLayer,
  secretCipherStubLayer,
  secretFilesLayerOf,
  serviceHostStubLayer,
  serviceStateLayer,
  sessionProcessesLayer,
  sessionRunsLayer,
  sessionSocketStubLayer,
  sessionsLayer,
  settingsLayer,
  setup,
  skillsStubLayer,
  sourcePolicyLayer,
  testDrainPolicy,
  userDotfilesStubLayer,
  withEngine,
  withPreparedEngineEffect,
  worktreesLayer,
} from "./engine/fixture.ts";

const bigintSafe = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;
describe("SessionEngine", () => {
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
          agentLoginsLayerOf(),
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
