import {
  ResourceArchivesRepo,
  ProjectEnvironmentRepo,
  ProjectSecretsRepo,
  ResourcesRepo,
  SessionsRepo,
  type StoredResourceInstance,
} from "@mend/db";
import type { ProjectId, ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  ownDatabaseName,
  baseDatabaseName,
  worktreeDatabaseName,
  type ResourceBinding,
  type ServiceDependency,
  type ResourceDependencyStopped,
  resourceDependenciesOf,
  serviceResourceEnv,
  resourceBindings,
  type ResourceEnvLeft,
  type ResourceInstanceObservation,
  resourceInstanceKey,
  resourceInstanceSpec,
  RESOURCE_IDLE_STOP_SECONDS,
  resourceProcessEnv,
  resourceScopeKey,
  reachAliases,
  type ResourceStatusView,
  SHARED_DATABASE,
} from "@mend/domain/workbench";
import {
  ResourceScopes,
  type ResourceScope,
  type ScopeInstance,
  type SealantPlatformError,
  unsupportedRuntimeOf,
} from "@mend/sealant";
import { Clock, Config, Duration, Effect, Fiber, Layer, Option, Schema, Semaphore } from "effect";
import * as Context from "effect/Context";

import { WorktreeReads } from "../worktree-reads.ts";
import {
  DUMPS_READY_ARGV,
  dumpPath,
  OWN_DATABASE_TIMEOUT_MS,
  ownDatabaseArgv,
  ownDatabaseOutcome,
  resetArgv,
  resetOutcome,
} from "./postgres-ops.ts";
import {
  removalDumpName,
  saveRemovalDump,
  removalDatabaseArgv,
  removalExecFailure,
} from "./removal-postgres.ts";
import { readWorktreeTables, tablesOf } from "./worktree-tables.ts";

/**
 * Runs a project's resources on Sealant and answers what every process in a worktree is told of
 * them (ADR 0019, amendment of 2026-11-01). The engine calls `prepare` before each process it
 * opens; `Resources` calls the rest for a person's acts and reads.
 */

/** What Sealant observed of one instance, and when. */
export interface InstanceObserved {
  readonly instance: ResourceInstanceObservation;
  readonly observedAt: Date;
}

/** A process about to open in a worktree's workspace, and whose launch it is. */
export interface PrepareInput {
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  readonly workspaceId: string;
  /** The person opening the process. */
  readonly launcher: string;
  readonly service?: string;
  readonly dependencies?: ReadonlyArray<ServiceDependency>;
  readonly recipeEnv?: Readonly<Record<string, string>>;
}

/** The env the process gets, and what a launch says about it (the "starts without it" lines). */
export interface Prepared {
  readonly env: Readonly<Record<string, string>>;
  readonly views: ReadonlyArray<ResourceStatusView>;
  readonly recipeEnv?: Readonly<Record<string, string>>;
  readonly refusal?: string;
  readonly resourceStopped?: { readonly name: string; readonly by: string };
  readonly notReady?: ReadonlyArray<string>;
}

/** Instances observed in a project, by Sealant key, or why none could be. */
export type ProjectObservation =
  | { readonly kind: "observed"; readonly byKey: ReadonlyMap<string, InstanceObserved> }
  | { readonly kind: "unobserved"; readonly instance: ResourceInstanceObservation };

export class ResourceRuntime extends Context.Service<
  ResourceRuntime,
  {
    /**
     * Links only the selected remembered instances and wakes observed idle stops with their
     * remembered specs. Never performs a first start or creates an own database. Bounded
     * preparation answers env from the rows, with observations beside unavailable instances.
     */
    readonly prepare: (input: PrepareInput) => Effect.Effect<Prepared>;
    /** Read only: whether a person stopped one of this Service's required resources. */
    readonly stoppedDependency: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      dependencies: ReadonlyArray<ServiceDependency>,
    ) => Effect.Effect<ResourceDependencyStopped | null>;
    /** The env a worktree's processes get now, from the rows alone; nothing is started. */
    readonly envOf: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ) => Effect.Effect<{
      readonly env: Readonly<Record<string, string>>;
      readonly left: ReadonlyArray<ResourceEnvLeft>;
    }>;
    /** A person's start: clears a person's stop. Bounded; the start goes on past the bound. */
    readonly start: (
      definition: StoredResourceInstance,
      worktreeId: WorktreeId | null,
    ) => Effect.Effect<InstanceObserved>;
    /** A person's stop, which holds against every launch until a person starts it. */
    readonly stop: (
      definition: StoredResourceInstance,
      worktreeId: WorktreeId | null,
      by: string,
    ) => Effect.Effect<InstanceObserved>;
    /** Ensure an own database only for an explicit worktree start, never at launch. */
    readonly ensureOwnDatabase: (
      definition: StoredResourceInstance,
      worktreeId: WorktreeId,
    ) => Effect.Effect<string | null>;
    /** Creates or preserves and drops the base copy's database on an already running project server. */
    readonly baseDatabase: (
      definition: StoredResourceInstance,
      worktreeId: WorktreeId,
      options: { readonly empty: boolean; readonly drop: boolean },
    ) => Effect.Effect<string | null>;
    /** Reconcile reach for every live workspace after starts or choices change. */
    readonly relink: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<string>>;
    /** Every instance of the project as Sealant observed it, in one call. */
    readonly observe: (projectId: ProjectId) => Effect.Effect<ProjectObservation>;
    /** Saves all active own and base databases before archiving this instance; volumes stay. */
    readonly archive: (definition: StoredResourceInstance) => Effect.Effect<ArchiveOutcome>;
    /**
     * Saves a Postgres database as a dump in its dumps volume, checks the dump reads back, then
     * makes it again: empty, or an own database copied from shared when shared has tables. The
     * instance must be running; a person's stop is never overridden for it.
     */
    readonly reset: (input: {
      readonly definition: StoredResourceInstance;
      readonly worktreeId: WorktreeId;
      /** `own` is the worktree's own database on the project's server; `shared` is `app`. */
      readonly target: "shared" | "own";
      readonly at: Date;
    }) => Effect.Effect<ResetOutcome>;
  }
>()("@mend/sessions/ResourceRuntime") {}

/** Whether archiving finished, and whether saving own databases needed to start the server. */
export type ArchiveOutcome =
  | { readonly kind: "archived"; readonly startedForArchive: boolean }
  | { readonly kind: "failed"; readonly message: string };

/** What a reset did, or why it did not. */
export type ResetOutcome =
  | {
      readonly kind: "reset";
      readonly origin: "empty" | "copied";
      /** When the previous data was saved as a dump; null when there was none to save. */
      readonly savedAt: Date | null;
    }
  | { readonly kind: "not-running"; readonly instance: ResourceInstanceObservation }
  | { readonly kind: "failed"; readonly message: string };

/** How long a launch waits on its resources before it opens without them. */
export const PREPARE_BOUND = Duration.seconds(30);

/** A runtime that runs nothing: every process gets no resource env. For tests and tools. */
export const ResourceRuntimeNone: Layer.Layer<ResourceRuntime> = Layer.succeed(ResourceRuntime, {
  prepare: () => Effect.succeed({ env: {}, views: [] }),
  stoppedDependency: () => Effect.succeed(null),
  envOf: () => Effect.succeed({ env: {}, left: [] }),
  start: () => Effect.succeed(unobserved("no runtime runs resources here")),
  stop: () => Effect.succeed(unobserved("no runtime runs resources here")),
  observe: () =>
    Effect.succeed({
      kind: "unobserved",
      instance: { kind: "not-observed", message: "no runtime runs resources here" },
    }),
  archive: () => Effect.succeed({ kind: "archived", startedForArchive: false }),
  ensureOwnDatabase: () => Effect.succeed(null),
  baseDatabase: () => Effect.succeed("no runtime runs resources here"),
  relink: () => Effect.succeed([]),
  reset: () => Effect.succeed({ kind: "failed", message: "no runtime runs resources here" }),
});

const unobserved = (message: string): InstanceObserved => ({
  instance: { kind: "not-observed", message },
  observedAt: new Date(),
});

/** What Sealant's instance state says, in the status line's terms. */
export const observationOf = (instance: ScopeInstance): ResourceInstanceObservation => {
  const state = instance.state;
  switch (state.kind) {
    case "not-started":
    case "starting":
    case "running":
    case "exited":
      return { kind: state.kind };
    case "stopped":
      return { kind: "stopped", reason: state.reason };
    case "failed":
      return { kind: "failed", message: state.message };
    case "archived":
      return { kind: "not-started" };
  }
};

/** A failure to reach Sealant, in the status line's terms. */
export const failureObservation = (error: SealantPlatformError): ResourceInstanceObservation => {
  const runtime = unsupportedRuntimeOf(error);
  return runtime === null
    ? { kind: "not-observed", message: error.message }
    : { kind: "unsupported", runtime };
};

const observed = (instance: ScopeInstance): InstanceObserved => ({
  instance: observationOf(instance),
  observedAt: instance.observedAt,
});

const specOf = (
  definition: StoredResourceInstance,
  worktreeId: WorktreeId | null,
  idleStopAfterSeconds: number,
) =>
  resourceInstanceSpec({
    definition: definition.spec,
    image: definition.image,
    worktreeId,
    idleStopAfterSeconds,
  });

type RuntimeNeeds =
  | ResourcesRepo
  | ResourceArchivesRepo
  | ProjectEnvironmentRepo
  | ProjectSecretsRepo
  | WorktreeReads
  | SessionsRepo
  | ResourceScopes;

/** The runtime, waiting `waitFor` for a launch's resources before it opens without them. */
export const resourceRuntimeLayer = (
  waitFor: Duration.Duration,
  idleStopAfterSeconds = RESOURCE_IDLE_STOP_SECONDS,
): Layer.Layer<ResourceRuntime, never, RuntimeNeeds> =>
  Layer.effect(
    ResourceRuntime,
    Effect.gen(function* () {
      const repo = yield* ResourcesRepo;
      const archives = yield* ResourceArchivesRepo;
      const environment = yield* ProjectEnvironmentRepo;
      const secrets = yield* ProjectSecretsRepo;
      const reads = yield* WorktreeReads;
      const sessions = yield* SessionsRepo;
      const scopes = yield* ResourceScopes;
      // Starts and copies outlive the launch that asked for them.
      const scope = yield* Effect.scope;
      // One own database is made at a time per worktree and server: two launches at once wait.
      const making = new Map<string, Semaphore.Semaphore>();
      const gateOf = (key: string) => {
        const known = making.get(key);
        if (known !== undefined) return known;
        const made = Semaphore.makeUnsafe(1);
        making.set(key, made);
        return made;
      };

      const scopeOf = (projectId: ProjectId) => scopes.of(resourceScopeKey(projectId));

      /** Names the project's env and secrets set, which its resources leave as they are. */
      const projectEnvNames = (projectId: ProjectId) =>
        Effect.all(
          [
            environment.snapshot(projectId).pipe(
              Effect.map((snapshot) => snapshot.variables.map((variable) => variable.name)),
              Effect.orElseSucceed(() => []),
            ),
            secrets.snapshot(projectId).pipe(
              Effect.map((snapshot) => snapshot.secrets.map((secret) => secret.name)),
              Effect.orElseSucceed(() => []),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([names, secretNames]) => new Set([...names, ...secretNames])));

      const bindingsOf = Effect.fn("ResourceRuntime.bindingsOf")(function* (
        projectId: ProjectId,
        worktreeId: WorktreeId,
      ) {
        const rows = yield* repo.bindingRows(projectId, worktreeId);
        const instances = yield* repo.listForProject(projectId);
        return resourceBindings(rows).flatMap((binding) => {
          const definition = instances.find(
            (row) =>
              row.id === binding.resourceId &&
              resourceInstanceKey(row.id, row.worktreeId) === binding.instanceKey,
          );
          return definition === undefined ? [] : [{ binding, definition }];
        });
      });

      const relink = Effect.fn("ResourceRuntime.relink")(function* (projectId: ProjectId) {
        const failures: string[] = [];
        const client = yield* scopeOf(projectId).pipe(Effect.result);
        if (client._tag === "Failure") return [client.failure.message];
        const linked = new Set<string>();
        for (const session of yield* sessions.listForProject(projectId)) {
          const workspaceId = session.sealantWorkspaceId;
          if (
            workspaceId === null ||
            linked.has(workspaceId) ||
            !["starting", "running", "waiting", "idle"].includes(session.status)
          )
            continue;
          linked.add(workspaceId);
          const bindings = resourceBindings(yield* repo.bindingRows(projectId, session.worktreeId));
          const answer = yield* client.success
            .link(workspaceId, session.worktreeId, reachAliases(bindings))
            .pipe(Effect.result);
          if (answer._tag === "Failure")
            failures.push(
              `could not link ${session.label ?? session.id}: ${answer.failure.message}`,
            );
        }
        return failures;
      });

      const envOf = Effect.fn("ResourceRuntime.envOf")(function* (
        projectId: ProjectId,
        worktreeId: WorktreeId,
      ) {
        const [bound, names] = yield* Effect.all(
          [bindingsOf(projectId, worktreeId), projectEnvNames(projectId)],
          { concurrency: "unbounded" },
        );
        return resourceProcessEnv({
          bindings: bound.map(({ binding }) => binding),
          worktreeId,
          projectEnvNames: names,
        });
      });

      /** Makes the tracked worktree database once and records how it began. */
      const makeOwnDatabase = Effect.fn("ResourceRuntime.ensureOwnDatabase")(function* (
        client: ResourceScope,
        key: string,
        definitionId: ResourceDefinitionId,
        worktreeId: WorktreeId,
        purpose: "own" | "base" = "own",
        empty = false,
      ) {
        const own = worktreeDatabaseName(worktreeId, purpose);
        return yield* gateOf(`${key}/${own}`).withPermits(1)(
          Effect.gen(function* () {
            if ((yield* repo.ownDatabases(worktreeId, purpose)).has(definitionId)) return null;
            const result = yield* client.exec(key, {
              argv: ownDatabaseArgv(own, empty),
              user: "postgres",
              timeoutMs: OWN_DATABASE_TIMEOUT_MS,
            });
            const outcome = result.exitCode === 0 ? ownDatabaseOutcome(result.stdout) : null;
            if (outcome === null) {
              const tail = result.stderr.trim().split("\n").at(-1) ?? "";
              return result.timedOut
                ? "the copy ran past its time limit"
                : `exit ${result.exitCode ?? "none"}${tail === "" ? "" : ` · ${tail}`}`;
            }
            // One that exists already but has no row was made before its row: how it began is unknown.
            yield* repo.recordOwnDatabase(
              worktreeId,
              definitionId,
              outcome === "exists" ? "empty" : outcome,
              purpose,
            );
            return null;
          }),
        );
      });

      /** Wakes an observed idle stop using the remembered spec; never creates an instance. */
      const convergeOne = (
        client: ResourceScope,
        definition: StoredResourceInstance,
        binding: ResourceBinding,
      ): Effect.Effect<ResourceStatusView | null> =>
        Effect.gen(function* () {
          const key = binding.instanceKey;
          const existing = yield* client.get(key);
          const instance =
            existing?.state.kind === "stopped" && existing.state.reason.kind === "idle"
              ? yield* client.up(
                  key,
                  specOf(definition, definition.worktreeId, idleStopAfterSeconds),
                  "use",
                )
              : existing;
          const observation =
            instance === null ? { kind: "not-started" as const } : observationOf(instance);
          return observation.kind === "running"
            ? null
            : ({
                kind: "launched-without",
                definition: definition.spec,
                instance: observation,
              } satisfies ResourceStatusView);
        }).pipe(
          Effect.catch((error: SealantPlatformError) =>
            Effect.succeed<ResourceStatusView>({
              kind: "launched-without",
              definition: definition.spec,
              instance: failureObservation(error),
            }),
          ),
        );

      const prepare = Effect.fn("ResourceRuntime.prepare")(function* (input: PrepareInput) {
        const [bound, names] = yield* Effect.all(
          [bindingsOf(input.projectId, input.worktreeId), projectEnvNames(input.projectId)],
          { concurrency: "unbounded" },
        );
        const bindings = bound.map(({ binding }) => binding);
        const { env: processEnv, left } = resourceProcessEnv({
          bindings,
          worktreeId: input.worktreeId,
          projectEnvNames: names,
        });
        const instances = yield* repo.listForProject(input.projectId);
        const remembered = instances.map((row) => row.spec);
        const file =
          input.service === undefined
            ? []
            : tablesOf(yield* readWorktreeTables(reads, input.projectId, input.worktreeId));
        const mapped = serviceResourceEnv({
          service: input.service ?? "process",
          dependencies: input.dependencies ?? [],
          definitions: [...remembered, ...file],
          bindings,
          projectEnvNames: names,
          resourceEnv: processEnv,
          recipeEnv: input.recipeEnv ?? {},
        });
        if (mapped.refusal !== null)
          return { env: {}, views: [], refusal: mapped.refusal } satisfies Prepared;
        const env = { ...processEnv, ...mapped.env };
        const leftViews = left.flatMap(
          ({ resource, names: kept }): ReadonlyArray<ResourceStatusView> => {
            const definition = bound.find(({ binding }) => binding.definition.name === resource);
            return definition === undefined
              ? []
              : [{ kind: "env-left", definition: definition.binding.definition, names: kept }];
          },
        );
        // A project that never started a resource has nothing to reach: no Sealant call at launch.
        if (instances.length === 0)
          return { env, recipeEnv: mapped.env, views: leftViews, notReady: [] } satisfies Prepared;

        // What each bound instance answered, as it answers: a launch past the bound says the rest
        // are still starting, and their starts go on in Mend's lifetime.
        const answered = new Map<string, ResourceStatusView | null>();
        const converge = Effect.gen(function* () {
          const client = yield* scopeOf(input.projectId);
          yield* client.link(input.workspaceId, input.worktreeId, reachAliases(bindings));
          yield* Effect.forEach(
            bound,
            ({ binding, definition }) =>
              convergeOne(client, definition, binding).pipe(
                Effect.tap((view) => Effect.sync(() => answered.set(definition.spec.name, view))),
              ),
            { concurrency: "unbounded", discard: true },
          );
        }).pipe(
          Effect.catch((error: SealantPlatformError) =>
            Effect.sync(() => {
              for (const { definition } of bound) {
                answered.set(definition.spec.name, {
                  kind: "launched-without",
                  definition: definition.spec,
                  instance: failureObservation(error),
                });
              }
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(converge, scope);
        yield* Fiber.join(fiber).pipe(Effect.timeoutOption(waitFor));
        const runViews = bound.flatMap(({ definition }): ReadonlyArray<ResourceStatusView> => {
          const view = answered.get(definition.spec.name);
          if (view === undefined) {
            return [
              {
                kind: "launched-without",
                definition: definition.spec,
                instance: { kind: "starting" },
              },
            ];
          }
          return view === null ? [] : [view];
        });
        const required = new Set(
          resourceDependenciesOf(input.dependencies ?? []).map((each) => each.name),
        );
        const notReady: string[] = [];
        for (const view of runViews) {
          if (view.kind !== "launched-without" || !required.has(view.definition.name)) continue;
          if (view.instance.kind === "stopped" && view.instance.reason.kind === "person") {
            return {
              env,
              views: [...runViews, ...leftViews],
              refusal: `@${view.definition.name} stopped by ${view.instance.reason.by}`,
              resourceStopped: { name: view.definition.name, by: view.instance.reason.by },
            } satisfies Prepared;
          }
          notReady.push(`@${view.definition.name} not ready`);
        }
        return {
          env,
          recipeEnv: mapped.env,
          views: [...runViews, ...leftViews],
          notReady,
        } satisfies Prepared;
      });

      const bounded = (work: Effect.Effect<InstanceObserved>) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(work, scope);
          const answer = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(waitFor));
          return Option.getOrElse(answer, () => ({
            instance: { kind: "starting" } satisfies ResourceInstanceObservation,
            observedAt: new Date(),
          }));
        });

      const asObserved = (effect: Effect.Effect<ScopeInstance, SealantPlatformError>) =>
        effect.pipe(
          Effect.map(observed),
          Effect.catch((error: SealantPlatformError) =>
            Effect.succeed({ instance: failureObservation(error), observedAt: new Date() }),
          ),
        );

      const start = Effect.fn("ResourceRuntime.start")(function* (
        definition: StoredResourceInstance,
        _worktreeId: WorktreeId | null,
      ) {
        const key = resourceInstanceKey(definition.id, definition.worktreeId);
        return yield* bounded(
          asObserved(
            scopeOf(definition.projectId).pipe(
              Effect.flatMap((client) =>
                client.up(
                  key,
                  specOf(definition, definition.worktreeId, idleStopAfterSeconds),
                  "person",
                ),
              ),
            ),
          ),
        );
      });

      const stop = Effect.fn("ResourceRuntime.stop")(function* (
        definition: StoredResourceInstance,
        worktreeId: WorktreeId | null,
        by: string,
      ) {
        const key = resourceInstanceKey(definition.id, definition.worktreeId);
        return yield* asObserved(
          scopeOf(definition.projectId).pipe(Effect.flatMap((client) => client.stop(key, by))),
        );
      });

      const observe = Effect.fn("ResourceRuntime.observe")(function* (projectId: ProjectId) {
        return yield* scopeOf(projectId).pipe(
          Effect.flatMap((client) => client.list()),
          Effect.map(
            (instances): ProjectObservation => ({
              kind: "observed",
              byKey: new Map(instances.map((instance) => [instance.key, observed(instance)])),
            }),
          ),
          Effect.catch((error: SealantPlatformError) =>
            Effect.succeed<ProjectObservation>({
              kind: "unobserved",
              instance: failureObservation(error),
            }),
          ),
        );
      });

      const archive = Effect.fn("ResourceRuntime.archive")(function* (
        definition: StoredResourceInstance,
      ) {
        let startedForArchive = false;
        const own =
          definition.worktreeId === null && definition.spec.preset === "postgres"
            ? yield* repo.ownDatabasesForResource(definition.id)
            : [];
        let preserving = own.length > 0;
        return yield* Effect.gen(function* () {
          const client = yield* scopeOf(definition.projectId);
          const key = resourceInstanceKey(definition.id, definition.worktreeId);
          if (own.length > 0) {
            const at = new Date(yield* Clock.currentTimeMillis);
            const previous = yield* client.get(key);
            if (previous?.state.kind !== "running") {
              // Only a stopped server is started for preservation. Do not replace any other state.
              if (previous?.state.kind !== "stopped")
                return {
                  kind: "failed" as const,
                  message: `could not save the own databases of ${own.map((row) => row.worktreeName).join(", ")} · server is ${previous?.state.kind ?? "missing"} · nothing archived or dropped · volumes kept`,
                };
              const instance = yield* client.up(
                key,
                specOf(definition, null, idleStopAfterSeconds),
                "person",
              );
              if (instance.state.kind !== "running")
                return {
                  kind: "failed" as const,
                  message: `could not save the own databases of ${own.map((row) => row.worktreeName).join(", ")} · archive could not start its server · ${instance.state.kind} · nothing archived or dropped · volumes kept`,
                };
              startedForArchive = true;
            }
            const failures: Array<{ readonly name: string; readonly reason: string }> = [];
            for (const row of own) {
              const dumpName = removalDumpName(
                worktreeDatabaseName(row.worktreeId, row.purpose),
                at,
              );
              // Refresh even a previously checked dump: a refused archive left this database live.
              yield* repo.reserveRemovalDump(
                row.worktreeId,
                definition.id,
                dumpName,
                at,
                true,
                row.purpose,
              );
              const result = yield* saveRemovalDump(
                client,
                key,
                row.worktreeId,
                dumpName,
                true,
                row.purpose,
              ).pipe(Effect.result);
              if (result._tag === "Failure")
                failures.push({ name: row.worktreeName, reason: result.failure.message });
              else yield* repo.checkRemovalDump(row.worktreeId, definition.id, at, row.purpose);
            }
            if (failures.length > 0)
              return {
                kind: "failed" as const,
                message: `could not save the own databases of ${failures.map((row) => row.name).join(", ")} · ${failures.map((row) => `${row.name}: ${row.reason}`).join("; ")} · nothing archived or dropped · volumes kept${startedForArchive ? " · archive started its server" : ""}`,
              };
          }
          preserving = false;
          const volumes = yield* client.archive(key);
          yield* archives.rememberVolumes(
            definition.projectId,
            volumes.map((volume) => ({ ...volume, resourceName: definition.spec.name })),
          );
          return { kind: "archived" as const, startedForArchive };
        }).pipe(
          Effect.catch((error: SealantPlatformError) =>
            Effect.succeed({
              kind: "failed" as const,
              message: preserving
                ? `could not save the own databases of ${own.map((row) => row.worktreeName).join(", ")} · ${error.message} · nothing archived or dropped · volumes kept${startedForArchive ? " · archive started its server" : ""}`
                : error.message,
            }),
          ),
        );
      });

      const ensureOwnDatabase = (definition: StoredResourceInstance, worktreeId: WorktreeId) =>
        scopeOf(definition.projectId).pipe(
          Effect.flatMap((client) =>
            makeOwnDatabase(
              client,
              resourceInstanceKey(definition.id, null),
              definition.id,
              worktreeId,
            ),
          ),
          Effect.catch((error: SealantPlatformError) => Effect.succeed(error.message)),
        );

      const baseDatabase = Effect.fn("ResourceRuntime.baseDatabase")(function* (
        definition: StoredResourceInstance,
        worktreeId: WorktreeId,
        options: { readonly empty: boolean; readonly drop: boolean },
      ) {
        return yield* Effect.gen(function* () {
          const client = yield* scopeOf(definition.projectId);
          const key = resourceInstanceKey(definition.id, null);
          const instance = yield* client.get(key);
          if (instance?.state.kind !== "running")
            return `project resource is ${instance?.state.kind ?? "not started"} · mend resource start ${definition.spec.name} --project`;
          if (!options.drop)
            return yield* makeOwnDatabase(
              client,
              key,
              definition.id,
              worktreeId,
              "base",
              options.empty,
            );
          const database = baseDatabaseName(worktreeId);
          return yield* gateOf(`${key}/${database}`).withPermits(1)(
            Effect.gen(function* () {
              const row = (yield* repo.ownDatabaseRemovals(worktreeId)).find(
                (each) => each.definitionId === definition.id && each.purpose === "base",
              );
              if (row === undefined || row.removedAt !== null) return null;
              const at = new Date(yield* Clock.currentTimeMillis);
              yield* repo.reserveRemovalDump(
                worktreeId,
                definition.id,
                removalDumpName(database, at),
                at,
                false,
                "base",
              );
              const reserved = (yield* repo.ownDatabaseRemovals(worktreeId)).find(
                (each) => each.definitionId === definition.id && each.purpose === "base",
              );
              if (reserved?.dumpName === null || reserved?.dumpName === undefined)
                return "the removal dump was not reserved";
              const dumpName = reserved.dumpName;
              const saved = yield* saveRemovalDump(
                client,
                key,
                worktreeId,
                dumpName,
                false,
                "base",
              ).pipe(Effect.result);
              if (saved._tag === "Failure") return saved.failure.message;
              yield* repo.checkRemovalDump(worktreeId, definition.id, at, "base");
              const result = yield* client.exec(key, {
                argv: removalDatabaseArgv("drop", database, dumpName),
                user: "postgres",
                timeoutMs: OWN_DATABASE_TIMEOUT_MS,
              });
              const failure = removalExecFailure(result);
              if (failure !== null) return `checked dump kept · ${failure}`;
              yield* repo.removeOwnDatabase(worktreeId, definition.id, at, "base");
              return null;
            }),
          );
        }).pipe(Effect.catch((error: SealantPlatformError) => Effect.succeed(error.message)));
      });

      const reset = Effect.fn("ResourceRuntime.reset")(function* (input: {
        readonly definition: StoredResourceInstance;
        readonly worktreeId: WorktreeId;
        readonly target: "shared" | "own";
        readonly at: Date;
      }) {
        const { definition, worktreeId, target, at } = input;
        const worktreeScoped = definition.worktreeId !== null;
        const key = resourceInstanceKey(definition.id, worktreeScoped ? worktreeId : null);
        const database =
          target === "own" && !worktreeScoped ? ownDatabaseName(worktreeId) : SHARED_DATABASE;
        const run = Effect.gen(function* () {
          const client = yield* scopeOf(definition.projectId);
          const existing = yield* client.get(key);
          const instance =
            existing?.state.kind === "stopped" && existing.state.reason.kind === "idle"
              ? yield* client.up(
                  key,
                  specOf(definition, definition.worktreeId, idleStopAfterSeconds),
                  "use",
                )
              : existing;
          const observation =
            instance === null ? { kind: "not-started" as const } : observationOf(instance);
          if (observation.kind !== "running") {
            return { kind: "not-running", instance: observation } satisfies ResetOutcome;
          }
          return yield* gateOf(`${key}/${database}`).withPermits(1)(
            Effect.gen(function* () {
              const ready = yield* client.exec(key, {
                argv: DUMPS_READY_ARGV,
                user: "root",
                timeoutMs: 30_000,
              });
              if (ready.exitCode !== 0) {
                return {
                  kind: "failed",
                  message: "the dumps volume could not be readied",
                } satisfies ResetOutcome;
              }
              const result = yield* client.exec(key, {
                argv: resetArgv({
                  database,
                  copy: database !== SHARED_DATABASE,
                  file: dumpPath(database, at),
                }),
                user: "postgres",
                timeoutMs: OWN_DATABASE_TIMEOUT_MS,
              });
              const outcome = result.exitCode === 0 ? resetOutcome(result.stdout) : null;
              if (outcome === null) {
                const tail = result.stderr.trim().split("\n").at(-1) ?? "";
                return {
                  kind: "failed",
                  message: result.timedOut
                    ? "the reset ran past its time limit"
                    : `exit ${result.exitCode ?? "none"}${tail === "" ? "" : ` · ${tail}`}`,
                } satisfies ResetOutcome;
              }
              if (database !== SHARED_DATABASE) {
                yield* repo.recordOwnDatabase(worktreeId, definition.id, outcome.origin);
              }
              return {
                kind: "reset",
                origin: outcome.origin,
                savedAt: outcome.saved ? at : null,
              } satisfies ResetOutcome;
            }),
          );
        });
        return yield* run.pipe(
          Effect.catch((error: SealantPlatformError) =>
            Effect.succeed<ResetOutcome>({ kind: "failed", message: error.message }),
          ),
        );
      });

      const stoppedDependency = Effect.fn("ResourceRuntime.stoppedDependency")(function* (
        projectId: ProjectId,
        worktreeId: WorktreeId,
        dependencies: ReadonlyArray<ServiceDependency>,
      ) {
        const required = new Set(resourceDependenciesOf(dependencies).map((each) => each.name));
        if (required.size === 0) return null;
        const seen = yield* observe(projectId);
        if (seen.kind !== "observed") return null;
        for (const { binding, definition } of yield* bindingsOf(projectId, worktreeId)) {
          if (!required.has(definition.spec.name)) continue;
          const instance = seen.byKey.get(binding.instanceKey)?.instance;
          if (instance?.kind === "stopped" && instance.reason.kind === "person")
            return { name: definition.spec.name, by: instance.reason.by };
        }
        return null;
      });
      return {
        prepare,
        envOf,
        stoppedDependency,
        start,
        stop,
        observe,
        archive,
        reset,
        ensureOwnDatabase,
        baseDatabase,
        relink,
      };
    }),
  );

/** The operator's idle bound, in seconds; instances keep their data when it elapses. */
export const ResourceRuntimeLive: Layer.Layer<ResourceRuntime, Config.ConfigError, RuntimeNeeds> =
  Layer.unwrap(
    Effect.gen(function* () {
      const seconds = yield* Config.schema(
        Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))),
        "MEND_RESOURCE_IDLE_STOP_SECONDS",
      ).pipe(Config.withDefault(RESOURCE_IDLE_STOP_SECONDS));
      return resourceRuntimeLayer(PREPARE_BOUND, seconds);
    }),
  );
