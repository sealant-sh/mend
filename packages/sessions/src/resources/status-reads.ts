import {
  type DefinitionWithChoice,
  ResourcesRepo,
  ResourceLoadsRepo,
  type StoredResourceDefinition,
  UsersRepo,
} from "@mend/db";
import type { ProjectId, ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  choiceInEffect,
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
} from "@mend/domain/workbench";
import { Clock, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import type { ReaderClock } from "./resources.ts";
import { type InstanceObserved, type ProjectObservation, ResourceRuntime } from "./runtime.ts";

/** A workspace note needs env names only. This read never resolves or returns env values. */
export interface WorktreeResourceStatus {
  readonly statusLine: string;
  readonly envNames: ReadonlyArray<string>;
}

type Shown = { readonly view: ResourceStatusView; readonly instance: ResourceInstanceKind };

/** Resource observations shared by settings, session DTOs and workspace notes, without engine actions. */
export class ResourceStatusReads extends Context.Service<
  ResourceStatusReads,
  {
    /** Builds the views Resources uses for its settings entries. */
    readonly viewsFor: (
      listed: ReadonlyArray<DefinitionWithChoice>,
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) => Effect.Effect<(each: DefinitionWithChoice) => Shown>;
    /** Trusted read: the caller has already resolved a visible session or owns its launch. */
    readonly forWorktree: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ) => Effect.Effect<ReadonlyArray<WorktreeResourceStatus>>;
  }
>()("@mend/sessions/ResourceStatusReads") {}

/** An engine with no resource definitions, used by isolated engine tests. */
export const ResourceStatusReadsNone: Layer.Layer<ResourceStatusReads> = Layer.succeed(
  ResourceStatusReads,
  {
    viewsFor: () => Effect.die("no resource definitions in this composition"),
    forWorktree: () => Effect.succeed([]),
  },
);

/** How a read looks one instance up: what Sealant observed, or why it could not. */
type Lookup = (key: string) => InstanceObserved;

const lookupIn =
  (observation: ProjectObservation | null, now: Date): Lookup =>
  (key) => {
    if (observation === null) return { instance: { kind: "not-started" }, observedAt: now };
    if (observation.kind === "unobserved")
      return { instance: observation.instance, observedAt: now };
    return observation.byKey.get(key) ?? { instance: { kind: "not-started" }, observedAt: now };
  };

/** A worktree resource's instances read for the project: how many run. */
const runningOf = (observation: ProjectObservation | null, definitionId: ResourceDefinitionId) =>
  observation?.kind !== "observed"
    ? 0
    : [...observation.byKey].filter(
        ([key, seen]) => key.startsWith(`${definitionId}@`) && seen.instance.kind === "running",
      ).length;

/**
 * The status view of one definition for one read: the worktree's use of it and the instance that
 * use reaches, or the project's when no worktree is read.
 */
export const resourceViewOf = (input: {
  readonly definition: StoredResourceDefinition;
  readonly choice: WorktreeChoice | null;
  readonly worktreeId: WorktreeId | null;
  readonly owns: ReadonlyMap<ResourceDefinitionId, OwnDatabaseOrigin>;
  readonly observation: ProjectObservation | null;
  readonly lookup: Lookup;
  readonly addedBy: string;
}): { readonly view: ResourceStatusView; readonly instance: ResourceInstanceKind } => {
  const { definition, worktreeId, lookup } = input;
  const spec = definition.spec;
  if (worktreeId === null) {
    if (spec.scope === "worktree") {
      return {
        view: {
          kind: "observed",
          definition: spec,
          use: { kind: "project", addedBy: input.addedBy },
          instance: { kind: "per-worktree", running: runningOf(input.observation, definition.id) },
          observedAt: lookup(definition.id).observedAt,
        },
        instance: "none",
      };
    }
    const seen = lookup(resourceInstanceKey(definition.id, null));
    return {
      view: {
        kind: "observed",
        definition: spec,
        use: { kind: "project", addedBy: input.addedBy },
        instance: seen.instance,
        observedAt: seen.observedAt,
      },
      instance: seen.instance.kind,
    };
  }
  const mode = spec.scope === "worktree" ? "worktree" : choiceInEffect(spec, input.choice);
  const use: ResourceUse =
    mode === "worktree"
      ? { kind: "worktree" }
      : mode === "own"
        ? { kind: "own", origin: input.owns.get(definition.id) ?? null }
        : mode === "shared"
          ? { kind: "shared" }
          : { kind: "off" };
  const seen = lookup(resourceInstanceKey(definition.id, mode === "worktree" ? worktreeId : null));
  return {
    view: {
      kind: "observed",
      definition: spec,
      use,
      instance: seen.instance,
      observedAt: seen.observedAt,
    },
    instance: use.kind === "off" ? "none" : seen.instance.kind,
  };
};

/** Reads stored choices and Core observations without starting or changing a resource. */
export const ResourceStatusReadsLive: Layer.Layer<
  ResourceStatusReads,
  never,
  ResourcesRepo | ResourceLoadsRepo | UsersRepo | ResourceRuntime
> = Layer.effect(
  ResourceStatusReads,
  Effect.gen(function* () {
    const repo = yield* ResourcesRepo;
    const loads = yield* ResourceLoadsRepo;
    const users = yield* UsersRepo;
    const runtime = yield* ResourceRuntime;
    const namesOf = (ids: ReadonlyArray<string>) =>
      users.byIds(ids).pipe(
        Effect.map((found) => {
          const names = new Map(found.map((user) => [user.id, user.name]));
          return (id: string) => names.get(id) ?? id;
        }),
      );
    /** Each definition's view for a read: one call to Sealant, and none when there is nothing. */
    const viewsFor = Effect.fn("Resources.viewsFor")(function* (
      listed: ReadonlyArray<DefinitionWithChoice>,
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) {
      const [observation, owns, nameOf, latestLoads] = yield* Effect.all(
        [
          listed.length === 0 ? Effect.succeed(null) : runtime.observe(projectId),
          worktreeId === null
            ? Effect.succeed(new Map<ResourceDefinitionId, OwnDatabaseOrigin>())
            : repo.ownDatabases(worktreeId),
          namesOf(listed.map(({ definition }) => definition.addedBy)),
          loads.latest(projectId),
        ],
        { concurrency: "unbounded" },
      );
      const lookup = lookupIn(observation, clock.now);
      return (each: DefinitionWithChoice) => {
        const shown = resourceViewOf({
          definition: each.definition,
          choice: each.choice,
          worktreeId,
          owns,
          observation,
          lookup,
          addedBy: nameOf(each.definition.addedBy),
        });
        const mode =
          worktreeId === null ? "shared" : choiceInEffect(each.definition.spec, each.choice);
        const database =
          mode === "own" && worktreeId !== null ? ownDatabaseName(worktreeId) : SHARED_DATABASE;
        const instanceKey = resourceInstanceKey(
          each.definition.id,
          each.definition.spec.scope === "worktree" ? worktreeId : null,
        );
        const load =
          mode === "off"
            ? undefined
            : // Only a load in progress speaks for the resource. A finished one said its result to
              // whoever ran it; from then on the line is what the runtime observes.
              latestLoads.find(
                (row) =>
                  row.instanceKey === instanceKey &&
                  row.database === database &&
                  loadIsLive(row.phase),
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
              } satisfies ResourceStatusView,
            };
      };
    });

    const forWorktree = Effect.fn("ResourceStatusReads.forWorktree")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ) {
      const listed = yield* repo.listWithChoices(projectId, worktreeId);
      if (listed.length === 0) return [];
      // Session lines have no reader zone. UTC makes absolute origin/load times identical across
      // clients and notes; the server's Effect clock also owns every relative observation age.
      const clock = { now: new Date(yield* Clock.currentTimeMillis), timeZone: "UTC" };
      const shownOf = yield* viewsFor(listed, projectId, worktreeId, clock);
      const bindings = resourceBindings(
        listed.map((each) => ({ spec: each.definition.spec, choice: each.choice })),
      );
      const names = resourceEnvNames(bindings);
      return listed.map((each) => ({
        statusLine: resourceStatusLine(shownOf(each).view, clock),
        envNames: names.get(each.definition.spec.name) ?? [],
      }));
    });
    return { viewsFor, forWorktree };
  }),
);
