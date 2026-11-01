import {
  ProjectEnvironmentRepo,
  ProjectSecretsRepo,
  ResourcesRepo,
  type StoredResourceDefinition,
} from "@mend/db";
import type { ProjectId, ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  boundDatabase,
  ownDatabaseName,
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
  resourceSpecDigest,
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
import { Cause, Config, Duration, Effect, Fiber, Layer, Option, Schema, Semaphore } from "effect";
import * as Context from "effect/Context";

import { WorktreeReads } from "../worktree-reads.ts";
import { ResourceImageResolver } from "./image-resolver.ts";
import {
  DUMPS_READY_ARGV,
  dumpPath,
  OWN_DATABASE_TIMEOUT_MS,
  ownDatabaseArgv,
  ownDatabaseOutcome,
  resetArgv,
  resetOutcome,
} from "./postgres-ops.ts";
import { readWorktreeTables, tablesOf } from "./worktree-tables.ts";

/**
 * Runs a project's resources on Sealant and answers what every process in a worktree is told of
 * them (ADR 0019, amendment of 2026-10-31). The engine calls `prepare` before each process it
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
  /** The person the launch is for: a `mend.toml` table this adds to settings is theirs. */
  readonly launcher: string;
  readonly dependencies?: ReadonlyArray<ServiceDependency>;
  readonly recipeEnv?: Readonly<Record<string, string>>;
}

/** The env the process gets, and what a launch says about it (the "starts without it" lines). */
export interface Prepared {
  readonly env: Readonly<Record<string, string>>;
  readonly views: ReadonlyArray<ResourceStatusView>;
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
     * Before a process opens in a worktree: adds the names its `mend.toml` declares that settings
     * lack, links the workspace, starts what the worktree uses and makes its own databases, all
     * bounded (`PREPARE_BOUND`), and answers the env from the rows. A slow or failed start never
     * fails the launch: the env is the same, and a view says the process starts without it.
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
      definition: StoredResourceDefinition,
      worktreeId: WorktreeId | null,
    ) => Effect.Effect<InstanceObserved>;
    /** A person's stop, which holds against every launch until a person starts it. */
    readonly stop: (
      definition: StoredResourceDefinition,
      worktreeId: WorktreeId | null,
      by: string,
    ) => Effect.Effect<InstanceObserved>;
    /** Every instance of the project as Sealant observed it, in one call. */
    readonly observe: (projectId: ProjectId) => Effect.Effect<ProjectObservation>;
    /** Archives every instance of a definition: containers go, volumes stay. */
    readonly archive: (definition: StoredResourceDefinition) => Effect.Effect<void>;
    /**
     * Saves a Postgres database as a dump in its dumps volume, checks the dump reads back, then
     * makes it again: empty, or an own database copied from shared when shared has tables. The
     * instance must be running; a person's stop is never overridden for it.
     */
    readonly reset: (input: {
      readonly definition: StoredResourceDefinition;
      readonly worktreeId: WorktreeId;
      /** `own` is the worktree's own database on the project's server; `shared` is `app`. */
      readonly target: "shared" | "own";
      readonly at: Date;
    }) => Effect.Effect<ResetOutcome>;
  }
>()("@mend/sessions/ResourceRuntime") {}

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
  archive: () => Effect.void,
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

/** The instance key a binding reaches. */
const keyOf = (
  definition: StoredResourceDefinition,
  binding: ResourceBinding,
  worktreeId: WorktreeId,
) => resourceInstanceKey(definition.id, binding.mode === "worktree" ? worktreeId : null);

const specOf = (
  definition: StoredResourceDefinition,
  worktreeId: WorktreeId | null,
  idleStopAfterSeconds: number,
) =>
  resourceInstanceSpec({
    definition: definition.spec,
    image: definition.image,
    worktreeId: definition.spec.scope === "worktree" ? worktreeId : null,
    idleStopAfterSeconds,
  });

type RuntimeNeeds =
  | ResourcesRepo
  | ProjectEnvironmentRepo
  | ProjectSecretsRepo
  | WorktreeReads
  | ResourceImageResolver
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
      const environment = yield* ProjectEnvironmentRepo;
      const secrets = yield* ProjectSecretsRepo;
      const reads = yield* WorktreeReads;
      const images = yield* ResourceImageResolver;
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
        const listed = yield* repo.listWithChoices(projectId, worktreeId);
        const byName = new Map(listed.map(({ definition }) => [definition.spec.name, definition]));
        return resourceBindings(
          listed.map(({ definition, choice }) => ({ spec: definition.spec, choice })),
        ).flatMap((binding) => {
          const definition = byName.get(binding.definition.name);
          return definition === undefined ? [] : [{ binding, definition }];
        });
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

      /**
       * Adds each `[resource.*]` table of the worktree's `mend.toml` whose name settings lack, as
       * the launcher; a name settings hold is never replaced, and one held otherwise is said.
       */
      const adoptTables = Effect.fn("ResourceRuntime.adoptTables")(function* (input: PrepareInput) {
        const tables = tablesOf(
          yield* readWorktreeTables(reads, input.projectId, input.worktreeId),
        );
        if (tables.length === 0) return [];
        const held = new Map(
          (yield* repo.listForProject(input.projectId)).map((definition) => [
            definition.spec.name,
            definition,
          ]),
        );
        const views: Array<ResourceStatusView> = [];
        for (const spec of tables) {
          const existing = held.get(spec.name);
          if (existing !== undefined) {
            if (existing.specDigest !== resourceSpecDigest(spec)) {
              views.push({ kind: "file-kept", definition: spec });
            }
            continue;
          }
          const added = yield* images.resolve(spec.image).pipe(
            Effect.flatMap((image) =>
              repo.declare(input.projectId, { spec, imageDigest: image.digest }, input.launcher),
            ),
            Effect.result,
          );
          if (added._tag === "Failure") {
            yield* Effect.logWarning("resources: a .mend/mend.toml table was not added").pipe(
              Effect.annotateLogs({ resource: spec.name, reason: added.failure._tag }),
            );
          }
        }
        return views;
      });

      /** Makes the worktree's own database on its server once, and records how it began. */
      const ensureOwnDatabase = Effect.fn("ResourceRuntime.ensureOwnDatabase")(function* (
        client: ResourceScope,
        key: string,
        definitionId: ResourceDefinitionId,
        worktreeId: WorktreeId,
      ) {
        const own = ownDatabaseName(worktreeId);
        return yield* gateOf(`${key}/${own}`).withPermits(1)(
          Effect.gen(function* () {
            if ((yield* repo.ownDatabases(worktreeId)).has(definitionId)) return null;
            const result = yield* client.exec(key, {
              argv: ownDatabaseArgv(own),
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
            if (outcome !== "exists")
              yield* repo.recordOwnDatabase(worktreeId, definitionId, outcome);
            return null;
          }),
        );
      });

      /** Starts one bound instance for a launch, and makes its own database; what to say, if anything. */
      const convergeOne = (
        client: ResourceScope,
        definition: StoredResourceDefinition,
        binding: ResourceBinding,
        worktreeId: WorktreeId,
      ): Effect.Effect<ResourceStatusView | null> =>
        Effect.gen(function* () {
          const key = keyOf(definition, binding, worktreeId);
          const instance = yield* client.up(
            key,
            specOf(definition, worktreeId, idleStopAfterSeconds),
            "use",
          );
          const observation = observationOf(instance);
          if (observation.kind !== "running") {
            return {
              kind: "launched-without",
              definition: definition.spec,
              instance: observation,
            } satisfies ResourceStatusView;
          }
          if (binding.mode !== "own" || boundDatabase(binding, worktreeId) === null) return null;
          const failed = yield* ensureOwnDatabase(client, key, definition.id, worktreeId);
          return failed === null
            ? null
            : ({
                kind: "own-not-made",
                definition: definition.spec,
                message: failed,
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
        const fileViews = yield* adoptTables(input).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("resources: .mend/mend.toml tables not read").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as([]),
            ),
          ),
        );
        const [bound, names] = yield* Effect.all(
          [bindingsOf(input.projectId, input.worktreeId), projectEnvNames(input.projectId)],
          { concurrency: "unbounded" },
        );
        const mapped = serviceResourceEnv({
          dependencies: input.dependencies ?? [],
          definitions: (yield* repo.listWithChoices(input.projectId, input.worktreeId)).map(
            ({ definition, choice }) => ({ spec: definition.spec, choice }),
          ),
          worktreeId: input.worktreeId,
          projectEnvNames: names,
          recipeEnv: input.recipeEnv ?? {},
        });
        if (mapped.refusal !== null)
          return { env: {}, views: fileViews, refusal: mapped.refusal } satisfies Prepared;
        const { env: processEnv, left } = resourceProcessEnv({
          bindings: bound.map(({ binding }) => binding),
          worktreeId: input.worktreeId,
          projectEnvNames: names,
        });
        const env = { ...processEnv, ...mapped.env };
        const leftViews = left.flatMap(
          ({ resource, names: kept }): ReadonlyArray<ResourceStatusView> => {
            const definition = bound.find(({ binding }) => binding.definition.name === resource);
            return definition === undefined
              ? []
              : [{ kind: "env-left", definition: definition.binding.definition, names: kept }];
          },
        );
        if (bound.length === 0)
          return { env, views: [...fileViews, ...leftViews] } satisfies Prepared;

        // What each bound instance answered, as it answers: a launch past the bound says the rest
        // are still starting, and their starts go on in Mend's lifetime.
        const answered = new Map<string, ResourceStatusView | null>();
        const converge = Effect.gen(function* () {
          const client = yield* scopeOf(input.projectId);
          yield* client.link(input.workspaceId, input.worktreeId);
          yield* Effect.forEach(
            bound,
            ({ binding, definition }) =>
              convergeOne(client, definition, binding, input.worktreeId).pipe(
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
              views: [...fileViews, ...runViews, ...leftViews],
              refusal: `@${view.definition.name} stopped by ${view.instance.reason.by}`,
              resourceStopped: { name: view.definition.name, by: view.instance.reason.by },
            } satisfies Prepared;
          }
          notReady.push(`@${view.definition.name} not ready`);
        }
        return {
          env,
          views: [...fileViews, ...runViews, ...leftViews],
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
        definition: StoredResourceDefinition,
        worktreeId: WorktreeId | null,
      ) {
        const key = resourceInstanceKey(
          definition.id,
          definition.spec.scope === "worktree" ? worktreeId : null,
        );
        return yield* bounded(
          asObserved(
            scopeOf(definition.projectId).pipe(
              Effect.flatMap((client) =>
                client.up(key, specOf(definition, worktreeId, idleStopAfterSeconds), "person"),
              ),
            ),
          ),
        );
      });

      const stop = Effect.fn("ResourceRuntime.stop")(function* (
        definition: StoredResourceDefinition,
        worktreeId: WorktreeId | null,
        by: string,
      ) {
        const key = resourceInstanceKey(
          definition.id,
          definition.spec.scope === "worktree" ? worktreeId : null,
        );
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
        definition: StoredResourceDefinition,
      ) {
        yield* scopeOf(definition.projectId).pipe(
          Effect.flatMap((client) =>
            client.list().pipe(
              Effect.flatMap((instances) =>
                Effect.forEach(
                  instances.filter(
                    (instance) =>
                      instance.key === definition.id ||
                      instance.key.startsWith(`${definition.id}@`),
                  ),
                  (instance) => client.archive(instance.key),
                  { discard: true },
                ),
              ),
            ),
          ),
          Effect.catch((error: SealantPlatformError) =>
            Effect.logWarning("resources: a removed definition's instances were not archived").pipe(
              Effect.annotateLogs({ definitionId: definition.id, error: error.message }),
            ),
          ),
        );
      });

      const reset = Effect.fn("ResourceRuntime.reset")(function* (input: {
        readonly definition: StoredResourceDefinition;
        readonly worktreeId: WorktreeId;
        readonly target: "shared" | "own";
        readonly at: Date;
      }) {
        const { definition, worktreeId, target, at } = input;
        const worktreeScoped = definition.spec.scope === "worktree";
        const key = resourceInstanceKey(definition.id, worktreeScoped ? worktreeId : null);
        const database =
          target === "own" && !worktreeScoped ? ownDatabaseName(worktreeId) : SHARED_DATABASE;
        const run = Effect.gen(function* () {
          const client = yield* scopeOf(definition.projectId);
          const instance = yield* client.up(
            key,
            specOf(definition, worktreeId, idleStopAfterSeconds),
            "use",
          );
          const observation = observationOf(instance);
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
          const instance = seen.byKey.get(keyOf(definition, binding, worktreeId))?.instance;
          if (instance?.kind === "stopped" && instance.reason.kind === "person")
            return { name: definition.spec.name, by: instance.reason.by };
        }
        return null;
      });
      return { prepare, envOf, stoppedDependency, start, stop, observe, archive, reset };
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
