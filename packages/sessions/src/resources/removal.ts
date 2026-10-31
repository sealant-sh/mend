import { ResourceArchivesRepo, ResourcesRepo, type StoredResourceDefinition } from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import {
  type ArchivedResourceVolume,
  mergeArchivedVolumes,
  ownDatabaseName,
  type Project,
  resourceInstanceKey,
  resourceInstanceSpec,
  resourceScopeKey,
  resourceStatusLine,
} from "@mend/domain/workbench";
import {
  ResourceScopes,
  type ScopeExecResult,
  type ResourceScope,
  type SealantPlatformError,
} from "@mend/sealant";
import { Clock, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { DUMPS_READY_ARGV, OWN_DATABASE_TIMEOUT_MS } from "./postgres-ops.ts";
import { removalDatabaseArgv, removalDumpName } from "./removal-postgres.ts";

/** Removal keeps the store when resource preservation did not finish. */
export class ResourceRemovalRefused extends Schema.TaggedError<ResourceRemovalRefused>()(
  "ResourceRemovalRefused",
  { message: Schema.String },
) {}

/** Preserves resource data under the caller's removal fence, before any store deletion. */
export class ResourceRemoval extends Context.Service<
  ResourceRemoval,
  {
    /** Checks every dump before dropping any own database, then archives worktree instances. */
    readonly worktree: (
      project: Project,
      worktreeId: WorktreeId,
    ) => Effect.Effect<ReadonlyArray<string>, ResourceRemovalRefused>;
    /** Saves an archive inventory and archives the whole scope before allowing purge. */
    readonly project: (
      project: Project,
    ) => Effect.Effect<ReadonlyArray<string>, ResourceRemovalRefused>;
  }
>()("@mend/sessions/ResourceRemoval") {}

const execFailure = (result: ScopeExecResult): string | null =>
  result.timedOut
    ? "the command reached its time limit"
    : result.exitCode === 0
      ? null
      : `exit ${result.exitCode ?? "none"} · ${result.stderr.trim().split("\n").at(-1) || "the command failed"}`;

const make: Effect.Effect<
  ResourceRemoval["Service"],
  never,
  ResourcesRepo | ResourceArchivesRepo | ResourceScopes
> = Effect.gen(function* () {
  const repo = yield* ResourcesRepo;
  const archives = yield* ResourceArchivesRepo;
  const scopes = yield* ResourceScopes;
  const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms)));

  const worktree = Effect.fn("ResourceRemoval.worktree")(function* (
    project: Project,
    worktreeId: WorktreeId,
  ) {
    const definitions = yield* repo.listForProject(project.id);
    const held = yield* repo.ownDatabaseRemovals(worktreeId);
    if (definitions.length === 0 && held.length === 0) return [];
    const client = yield* scopes
      .of(resourceScopeKey(project.id))
      .pipe(
        Effect.mapError(
          (error) =>
            new ResourceRemovalRefused({ message: `resources · not removed · ${error.message}` }),
        ),
      );
    const at = yield* now;
    const clock = { now: at, timeZone: "UTC" };
    const started = new Set<string>();
    const lines: Array<string> = [];

    const databaseCommand = (
      definition: StoredResourceDefinition,
      run: (
        scope: ResourceScope,
        key: string,
      ) => Effect.Effect<void, ResourceRemovalRefused | SealantPlatformError>,
    ) => {
      const key = resourceInstanceKey(definition.id, null);
      const refused = (reason: string) =>
        new ResourceRemovalRefused({
          message: resourceStatusLine(
            {
              kind: "removal-refused",
              definition: definition.spec,
              database: ownDatabaseName(worktreeId),
              reason,
            },
            clock,
          ),
        });
      return Effect.gen(function* () {
        const previous = yield* client.get(key);
        if (previous?.state.kind !== "running") {
          const instance = yield* client.up(
            key,
            resourceInstanceSpec({
              definition: definition.spec,
              image: definition.image,
              worktreeId: null,
            }),
            "person",
          );
          if (instance.state.kind !== "running")
            return yield* refused(`removal could not start its server · ${instance.state.kind}`);
          started.add(key);
        }
        yield* run(client, key);
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) => Effect.fail(refused(error.message))),
      );
    };

    // Reserve all paths durably. A restart reuses a completed dump; a partial file is overwritten.
    for (const row of held) {
      if (row.removedAt !== null) continue;
      yield* repo.reserveRemovalDump(
        worktreeId,
        row.definitionId,
        removalDumpName(ownDatabaseName(worktreeId), at),
        at,
      );
    }
    const planned = yield* repo.ownDatabaseRemovals(worktreeId);
    for (const row of planned) {
      if (row.removedAt !== null) continue;
      const definition = definitions.find((def) => def.id === row.definitionId);
      if (definition === undefined || row.dumpName === null || row.dumpAt === null) {
        return yield* new ResourceRemovalRefused({
          message: `database ${ownDatabaseName(worktreeId)} · not removed · its definition or reserved dump is missing`,
        });
      }
      const dumpName = row.dumpName;
      yield* databaseCommand(definition, (scope, key) =>
        Effect.gen(function* () {
          const ready = execFailure(
            yield* scope.exec(key, { argv: DUMPS_READY_ARGV, user: "root", timeoutMs: 30_000 }),
          );
          if (ready !== null)
            return yield* new ResourceRemovalRefused({
              message: resourceStatusLine(
                {
                  kind: "removal-refused",
                  definition: definition.spec,
                  database: ownDatabaseName(worktreeId),
                  reason: `dumps volume · ${ready}`,
                },
                clock,
              ),
            });
          const saved = yield* scope
            .exec(key, {
              argv: removalDatabaseArgv("save", ownDatabaseName(worktreeId), dumpName),
              user: "postgres",
              timeoutMs: OWN_DATABASE_TIMEOUT_MS,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ResourceRemovalRefused({
                    message: resourceStatusLine(
                      {
                        kind: "removal-refused",
                        definition: definition.spec,
                        database: ownDatabaseName(worktreeId),
                        reason: error.message,
                      },
                      clock,
                    ),
                  }),
              ),
            );
          const failure = execFailure(saved);
          if (failure !== null)
            return yield* new ResourceRemovalRefused({
              message: resourceStatusLine(
                {
                  kind: "removal-refused",
                  definition: definition.spec,
                  database: ownDatabaseName(worktreeId),
                  reason: `dump or dump check failed · ${failure}`,
                },
                clock,
              ),
            });
          yield* repo.checkRemovalDump(worktreeId, definition.id, at);
        }),
      );
    }
    // No drop is reachable until every database has a checked dump recorded.
    for (const row of planned) {
      const definition = definitions.find((def) => def.id === row.definitionId);
      if (definition === undefined || row.dumpName === null || row.dumpAt === null) continue;
      if (row.removedAt === null) {
        const dumpName = row.dumpName;
        yield* databaseCommand(definition, (scope, key) =>
          Effect.gen(function* () {
            const result = yield* scope.exec(key, {
              argv: removalDatabaseArgv("drop", ownDatabaseName(worktreeId), dumpName),
              user: "postgres",
              timeoutMs: OWN_DATABASE_TIMEOUT_MS,
            });
            const failure = execFailure(result);
            if (failure !== null)
              return yield* new ResourceRemovalRefused({
                message: resourceStatusLine(
                  {
                    kind: "removal-refused",
                    definition: definition.spec,
                    database: ownDatabaseName(worktreeId),
                    reason: `checked dump kept · ${failure}`,
                  },
                  clock,
                ),
              });
            yield* repo.removeOwnDatabase(worktreeId, definition.id, yield* now);
          }),
        );
      }
      lines.push(
        resourceStatusLine(
          {
            kind: "own-removed",
            definition: definition.spec,
            savedAt: row.dumpAt,
            startedForRemoval: started.has(resourceInstanceKey(definition.id, null)),
          },
          clock,
        ),
      );
    }
    const instances = yield* client.list().pipe(
      Effect.mapError(
        (error) =>
          new ResourceRemovalRefused({
            message: `worktree resources · not removed · ${error.message}`,
          }),
      ),
    );
    for (const instance of instances.filter((each) => each.worktreeKey === worktreeId)) {
      yield* client.archive(instance.key).pipe(
        Effect.mapError(
          (error) =>
            new ResourceRemovalRefused({
              message: `@${instance.alias} · not archived · ${error.message}`,
            }),
        ),
      );
      const definition = definitions.find(
        (def) => resourceInstanceKey(def.id, worktreeId) === instance.key,
      );
      if (definition !== undefined)
        lines.push(resourceStatusLine({ kind: "archived", definition: definition.spec }, clock));
    }
    return lines;
  });

  const archiveProject = Effect.fn("ResourceRemoval.project")(function* (project: Project) {
    let stored = yield* archives.byProject(project.id);
    if (stored?.complete === true) return ["resources · archived · volumes kept"];
    return yield* Effect.gen(function* () {
      const client = yield* scopes.of(resourceScopeKey(project.id));
      const at = yield* now;
      if (stored === null) {
        const instances = [...(yield* client.list()), ...(yield* client.list(true))];
        const volumes = instances.flatMap((instance) =>
          instance.volumes.map(
            (volume): ArchivedResourceVolume => ({
              ...volume,
              instanceKey: instance.key,
              resourceName: instance.alias,
              bytes: null,
            }),
          ),
        );
        yield* archives.begin({
          projectId: project.id,
          organizationId: project.organizationId,
          projectName: project.name,
          createdByUserId: project.createdByUserId,
          archivedAt: at,
          volumes: mergeArchivedVolumes([], volumes),
        });
        stored = yield* archives.byProject(project.id);
      }
      if (stored === null) return yield* Effect.die("resource archive inventory was not stored");
      const names = new Map(
        stored.archive.volumes.map((volume) => [volume.instanceKey, volume.resourceName]),
      );
      const measured = (yield* client.archiveScope()).map(
        (volume): ArchivedResourceVolume => ({
          ...volume,
          resourceName: names.get(volume.instanceKey) ?? volume.instanceKey,
        }),
      );
      yield* archives.finish(project.id, mergeArchivedVolumes(stored.archive.volumes, measured));
      const definitions = yield* repo.listForProject(project.id);
      return definitions.map((definition) =>
        resourceStatusLine(
          { kind: "archived", definition: definition.spec },
          { now: at, timeZone: "UTC" },
        ),
      );
    }).pipe(
      Effect.catchTag("SealantPlatformError", (error) =>
        Effect.fail(
          new ResourceRemovalRefused({ message: `resources · not archived · ${error.message}` }),
        ),
      ),
    );
  });
  return { worktree, project: archiveProject };
});

/** Resource preservation shares the server's database and public SDK scope adapter. */
export const ResourceRemovalLive: Layer.Layer<
  ResourceRemoval,
  never,
  ResourcesRepo | ResourceArchivesRepo | ResourceScopes
> = Layer.effect(ResourceRemoval, make);
