import { type DefinitionWithChoice, ResourcesRepo, ResourceLoadsRepo } from "@mend/db";
import type { ProjectId, ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  loadIsLive,
  type OwnDatabaseOrigin,
  type ResourceInstanceKind,
  resourceInstanceKey,
  resourceStatusLine,
  type ResourceStatusView,
  type ResourceUse,
  type WorktreeChoice,
  ownDatabaseName,
  SHARED_DATABASE,
  resourceBindings,
  resourceEnvNames,
  resourceEnvPrefix,
  imageReference,
} from "@mend/domain/workbench";
import { Clock, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import type { ReaderClock } from "./resources.ts";
import { type InstanceObserved, type ProjectObservation, ResourceRuntime } from "./runtime.ts";
import { ResourceTableReads, tablesOf } from "./worktree-tables.ts";

/** A note reads names and observations only, never env values. */
export interface WorktreeResourceStatus {
  readonly statusLine: string;
  readonly envNames: ReadonlyArray<string>;
  readonly available?: {
    readonly name: string;
    readonly kind: string;
    readonly level: "project" | "worktree";
    readonly urlName: string;
  };
  readonly postgresName?: string;
}
type Shown = { readonly view: ResourceStatusView; readonly instance: ResourceInstanceKind };
/** Shared observations for project pages, sessions and workspace notes. */
export class ResourceStatusReads extends Context.Service<
  ResourceStatusReads,
  {
    readonly viewsFor: (
      listed: ReadonlyArray<DefinitionWithChoice>,
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) => Effect.Effect<(each: DefinitionWithChoice) => Shown>;
    readonly forWorktree: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ) => Effect.Effect<ReadonlyArray<WorktreeResourceStatus>>;
  }
>()("@mend/sessions/ResourceStatusReads") {}
/** No resource observations for isolated engine compositions. */
export const ResourceStatusReadsNone: Layer.Layer<ResourceStatusReads> = Layer.succeed(
  ResourceStatusReads,
  {
    viewsFor: () => Effect.die("no resources in this composition"),
    forWorktree: () => Effect.succeed([]),
  },
);
type Lookup = (key: string) => InstanceObserved;
const lookupIn =
  (observation: ProjectObservation | null, now: Date): Lookup =>
  (key) =>
    observation?.kind === "unobserved"
      ? { instance: observation.instance, observedAt: now }
      : (observation?.byKey.get(key) ?? { instance: { kind: "not-started" }, observedAt: now });

/** A remembered instance's status for the selected level, or its own level on the project page. */
export const resourceViewOf = (input: {
  readonly definition: DefinitionWithChoice["definition"];
  readonly choice: WorktreeChoice;
  readonly worktreeId: WorktreeId | null;
  readonly owns: ReadonlyMap<ResourceDefinitionId, OwnDatabaseOrigin>;
  readonly lookup: Lookup;
  readonly addedBy: string;
}): Shown => {
  const { definition, worktreeId } = input;
  const level =
    worktreeId === null
      ? definition.worktreeId === null
        ? "project"
        : "worktree"
      : input.choice === "worktree"
        ? "worktree"
        : "project";
  const postgresOwn =
    definition.spec.preset === "postgres" && level === "worktree" && definition.worktreeId === null;
  const use: ResourceUse =
    input.choice === "off" && worktreeId !== null
      ? { kind: "off" }
      : postgresOwn
        ? { kind: "own", origin: input.owns.get(definition.id) ?? null }
        : definition.spec.preset === "postgres"
          ? level === "worktree"
            ? { kind: "own", origin: null, available: true }
            : { kind: "shared" }
          : { kind: "worktree" };
  const key = resourceInstanceKey(
    definition.id,
    level === "project" || postgresOwn ? null : (worktreeId ?? definition.worktreeId),
  );
  const seen =
    postgresOwn && !input.owns.has(definition.id)
      ? { instance: { kind: "not-started" as const }, observedAt: input.lookup(key).observedAt }
      : input.lookup(key);
  return {
    view: {
      kind: "observed",
      definition: definition.spec,
      level,
      use,
      instance: seen.instance,
      observedAt: seen.observedAt,
    },
    instance: use.kind === "off" ? "none" : seen.instance.kind,
  };
};

/** Reads rows and Core without creating or starting an instance. */
export const ResourceStatusReadsLive: Layer.Layer<
  ResourceStatusReads,
  never,
  ResourcesRepo | ResourceLoadsRepo | ResourceRuntime | ResourceTableReads
> = Layer.effect(
  ResourceStatusReads,
  Effect.gen(function* () {
    const repo = yield* ResourcesRepo;
    const loads = yield* ResourceLoadsRepo;
    const runtime = yield* ResourceRuntime;
    const reads = yield* ResourceTableReads;
    const viewsFor = Effect.fn("ResourceStatusReads.viewsFor")(function* (
      listed: ReadonlyArray<DefinitionWithChoice>,
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) {
      const [observation, owns, latestLoads] = yield* Effect.all(
        [
          listed.length === 0 ? Effect.succeed(null) : runtime.observe(projectId),
          worktreeId === null
            ? Effect.succeed(new Map<ResourceDefinitionId, OwnDatabaseOrigin>())
            : repo.ownDatabases(worktreeId),
          loads.latest(projectId),
        ],
        { concurrency: "unbounded" },
      );
      const lookup = lookupIn(observation, clock.now);
      return (each: DefinitionWithChoice): Shown => {
        const shown = resourceViewOf({
          definition: each.definition,
          choice: each.choice,
          worktreeId,
          owns,
          lookup,
          addedBy: each.definition.startedBy,
        });
        const database =
          each.choice === "worktree" && worktreeId !== null && each.definition.worktreeId === null
            ? ownDatabaseName(worktreeId)
            : SHARED_DATABASE;
        const key = resourceInstanceKey(each.definition.id, each.definition.worktreeId);
        const load =
          each.choice === "off"
            ? undefined
            : latestLoads.find(
                (row) =>
                  row.instanceKey === key && row.database === database && loadIsLive(row.phase),
              );
        return load === undefined
          ? shown
          : {
              instance: shown.instance,
              view: {
                kind: "load",
                definition: each.definition.spec,
                target: load.target,
                phase: load.phase,
                label: load.label,
                bytesDone: load.bytesDone,
                bytesTotal: load.bytesTotal,
                savedAt: load.savedAt,
                message: load.message,
              },
            };
      };
    });
    const forWorktree = Effect.fn("ResourceStatusReads.forWorktree")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ) {
      const listed = yield* repo.listWithChoices(projectId, worktreeId);
      const file = tablesOf(yield* reads.forWorktree(projectId, worktreeId));
      const postgres = [...file, ...listed.map((row) => row.definition.spec)].find(
        (spec) => spec.preset === "postgres",
      )?.name;
      const clock = { now: new Date(yield* Clock.currentTimeMillis), timeZone: "UTC" };
      const shownOf = yield* viewsFor(listed, projectId, worktreeId, clock);
      const bindings = resourceBindings(yield* repo.bindingRows(projectId, worktreeId));
      const names = resourceEnvNames(bindings);
      const result: WorktreeResourceStatus[] = listed.map((each) => {
        const spec = each.definition.spec;
        const binding = bindings.find((row) => row.resourceId === each.definition.id);
        const kind =
          spec.preset === "postgres"
            ? "Postgres"
            : spec.preset === "redis"
              ? "Redis"
              : spec.preset === "mysql"
                ? "MySQL"
                : (imageReference(spec.image).repository.split("/").at(-1) ?? spec.image);
        return {
          statusLine: resourceStatusLine(shownOf(each).view, clock),
          envNames: names.get(spec.name) ?? [],
          ...(binding === undefined
            ? {}
            : {
                available: {
                  name: spec.name,
                  kind,
                  level: binding.level,
                  urlName: `${resourceEnvPrefix(spec.name)}URL`,
                },
              }),
          ...(postgres === undefined ? {} : { postgresName: postgres }),
        };
      });
      const declaredPostgres = file.find((spec) => spec.name === postgres);
      if (result.length === 0 && declaredPostgres !== undefined)
        result.push({
          statusLine: resourceStatusLine({ kind: "defined", definition: declaredPostgres }, clock),
          envNames: [],
          postgresName: declaredPostgres.name,
        });
      return result;
    });
    return { viewsFor, forWorktree };
  }),
);
