import {
  OrganizationsRepo,
  ProjectsRepo,
  ResourceLoadsRepo,
  ResourcesRepo,
  SessionsRepo,
  type StoredResourceDefinition,
  type StoredResourceLoad,
  WorktreesRepo,
} from "@mend/db";
import { type ProjectId, ResourceLoadId, type SessionId, type WorktreeId } from "@mend/domain";
import {
  choiceInEffect,
  loadIsLive,
  ownDatabaseName,
  parsePullUrl,
  type PullUrl,
  resourceActRefusal,
  type ResourceLoadAnswer,
  type ResourceLoadSource,
  resourceInstanceKey,
  resourceScopeKey,
  resourceStatusLine,
  scrubLoadMessage,
  SHARED_DATABASE,
  type Viewer,
} from "@mend/domain/workbench";
import { ResourceScopes, type ResourceScope } from "@mend/sealant";
import { Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect";
import * as Context from "effect/Context";

import {
  allowLoadTargetArgv,
  discardLoadArgv,
  installLoadArgv,
  LOAD_DIR_ARGV,
  LOAD_TIMEOUT_MS,
  loadNames,
  loadSizeArgv,
  observeLoadArgv,
  pullLoadArgv,
  removeIncomingArgv,
  restoreLoadArgv,
  saveLoadArgv,
  stageLoadArgv,
} from "./load-ops.ts";
import type { ReaderClock, ResourceProject } from "./resources.ts";
import { ResourceRuntime } from "./runtime.ts";

/** A load could not start or be read; no source URL or provider cause can escape this error. */
export class ResourceLoadRefused extends Schema.TaggedError<ResourceLoadRefused>()(
  "ResourceLoadRefused",
  { message: Schema.String },
) {}
const refused = (message: string) => new ResourceLoadRefused({ message });
export interface BeginResourceLoad {
  readonly name: string;
  readonly worktreeId: WorktreeId | null;
  readonly target: "shared" | "own" | null;
  readonly source: ResourceLoadSource;
}

/** Streams and recovery belong to Mend's lifetime, never the request which began them. */
export class ResourceLoads extends Context.Service<
  ResourceLoads,
  {
    readonly begin: (
      project: ResourceProject,
      viewer: Viewer,
      input: BeginResourceLoad,
      clock: ReaderClock,
    ) => Effect.Effect<ResourceLoadAnswer, ResourceLoadRefused>;
    readonly read: (
      project: ResourceProject,
      viewer: Viewer,
      id: ResourceLoadId,
      clock: ReaderClock,
    ) => Effect.Effect<ResourceLoadAnswer, ResourceLoadRefused>;
    readonly feed: (
      project: ResourceProject,
      viewer: Viewer,
      id: ResourceLoadId,
      body: Stream.Stream<Uint8Array, unknown>,
      clock: ReaderClock,
    ) => Effect.Effect<ResourceLoadAnswer, ResourceLoadRefused>;
    readonly session: (id: SessionId) => Effect.Effect<
      {
        readonly project: ResourceProject;
        readonly viewer: Viewer;
        readonly worktreeId: WorktreeId;
      },
      ResourceLoadRefused
    >;
    readonly recover: Effect.Effect<void>;
  }
>()("@mend/sessions/ResourceLoads") {}

const answer = (
  row: StoredResourceLoad,
  definition: StoredResourceDefinition,
  clock: ReaderClock,
): ResourceLoadAnswer => ({
  id: row.id,
  phase: row.phase,
  bytesDone: row.bytesDone,
  bytesTotal: row.bytesTotal,
  statusLine: resourceStatusLine(
    {
      kind: "load",
      definition: definition.spec,
      target: row.target,
      phase: row.phase,
      label: row.label,
      bytesDone: row.bytesDone,
      bytesTotal: row.bytesTotal,
      savedAt: row.savedAt,
      message: row.message,
    },
    clock,
  ),
});

type Needs =
  | ResourceLoadsRepo
  | ResourcesRepo
  | ResourceScopes
  | ResourceRuntime
  | WorktreesRepo
  | SessionsRepo
  | ProjectsRepo
  | OrganizationsRepo;
export const ResourceLoadsLive: Layer.Layer<ResourceLoads, never, Needs> = Layer.effect(
  ResourceLoads,
  Effect.gen(function* () {
    const rows = yield* ResourceLoadsRepo;
    const definitions = yield* ResourcesRepo;
    const scopes = yield* ResourceScopes;
    const runtime = yield* ResourceRuntime;
    const worktrees = yield* WorktreesRepo;
    const sessions = yield* SessionsRepo;
    const projects = yield* ProjectsRepo;
    const organizations = yield* OrganizationsRepo;
    const lifetime = yield* Effect.scope;
    const feeding = new Set<ResourceLoadId>();

    const scopeOf = (projectId: ProjectId) =>
      scopes
        .of(resourceScopeKey(projectId))
        .pipe(Effect.mapError(() => refused("the resource server could not be reached")));
    const exec = (
      scope: ResourceScope,
      row: StoredResourceLoad,
      argv: ReadonlyArray<string>,
      stdin?: AsyncIterable<Uint8Array>,
      user = "postgres",
    ) =>
      scope
        .exec(row.instanceKey, {
          argv,
          user,
          timeoutMs: LOAD_TIMEOUT_MS,
          ...(stdin === undefined ? {} : { stdin }),
        })
        .pipe(
          // Exec diagnostics can contain source data, so only this operation's words leave it.
          Effect.mapError(() => refused("the resource command could not finish")),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(refused("the resource command failed")),
          ),
        );
    const next = (
      row: StoredResourceLoad,
      phase: StoredResourceLoad["phase"],
      patch?: { readonly message?: string; readonly savedPath?: string; readonly savedAt?: Date },
    ) => rows.advance(row, phase, patch).pipe(Effect.as({ ...row, ...patch, phase }));

    const authorized = (
      project: ResourceProject,
      viewer: Viewer,
      id: ResourceLoadId,
      writing: boolean,
    ) =>
      Effect.gen(function* () {
        if (resourceActRefusal(project, viewer, { kind: "read" }) !== null)
          return yield* refused("resource load not found");
        const row = yield* rows.get(id);
        if (row === null || row.projectId !== project.id)
          return yield* refused("resource load not found");
        if (writing && row.startedBy !== viewer.userId)
          return yield* refused("only the person who started this upload may send its bytes");
        const definition =
          (yield* definitions.listForProject(project.id)).find((d) => d.id === row.definitionId) ??
          null;
        if (definition === null) return yield* refused("resource load not found");
        if (writing && row.target === "own" && row.worktreeId !== null) {
          const denial = resourceActRefusal(project, viewer, {
            kind: "use",
            changeOwner: yield* worktrees.changeOwnerOf(row.worktreeId),
          });
          if (denial !== null) return yield* refused(denial);
        }
        return { row, definition };
      });

    /** Errors before installation may discard only the temp; saving errors keep the old database. */
    const failBeforeInstall = (scope: ResourceScope, row: StoredResourceLoad, message: string) =>
      Effect.gen(function* () {
        yield* exec(scope, row, discardLoadArgv(loadNames(row.database, row.id))).pipe(
          Effect.ignore,
        );
        yield* next(row, "failed", { message });
      });

    const save = (scope: ResourceScope, row: StoredResourceLoad) =>
      Effect.gen(function* () {
        const names = loadNames(row.database, row.id);
        const present = yield* exec(scope, row, observeLoadArgv(names));
        const saving = row;
        if (row.savedPath === null && present.split("\n").includes(names.prev)) {
          return yield* refused("previous data is kept; the dump destination needs recovery");
        }
        if (saving.savedPath !== null)
          yield* exec(scope, saving, saveLoadArgv(names, saving.savedPath));
        yield* exec(scope, saving, removeIncomingArgv(names));
        if (
          saving.target === "own" &&
          saving.worktreeId !== null &&
          saving.database !== SHARED_DATABASE
        ) {
          yield* definitions.recordOwnDatabase(saving.worktreeId, saving.definitionId, "loaded");
        }
        yield* next(saving, "done");
      });

    const installAndSave = (scope: ResourceScope, row: StoredResourceLoad) =>
      Effect.gen(function* () {
        const names = loadNames(row.database, row.id);
        yield* exec(scope, row, installLoadArgv(names));
        const present = yield* exec(scope, row, observeLoadArgv(names));
        const savedAt = new Date();
        const stamp = savedAt.toISOString().replace(/[-:.]/g, "");
        const saving = yield* next(
          row,
          "saving",
          present.split("\n").includes(names.prev)
            ? { savedPath: `/mend/dumps/${row.database}-${stamp}.dump`, savedAt }
            : undefined,
        );
        yield* save(scope, saving);
      });

    const restore = (scope: ResourceScope, row: StoredResourceLoad) =>
      Effect.gen(function* () {
        const restored = yield* exec(
          scope,
          row,
          restoreLoadArgv(loadNames(row.database, row.id)),
        ).pipe(Effect.result);
        if (restored._tag === "Failure")
          return yield* failBeforeInstall(scope, row, "the dump could not be restored");
        const installing = yield* next(row, "installing");
        yield* installAndSave(scope, installing);
      });

    /** Retry installation/save failures from observed names, without dropping previous data. */
    const recoverOne = (row: StoredResourceLoad) =>
      Effect.gen(function* () {
        const scope = yield* scopeOf(row.projectId);
        const names = loadNames(row.database, row.id);
        if (row.phase === "saving") return yield* save(scope, row);
        const present = (yield* exec(scope, row, observeLoadArgv(names))).split("\n");
        if (row.phase === "installing") {
          if (present.includes(names.prev) || !present.includes(names.temp))
            return yield* installAndSave(scope, row);
          if (!present.includes(names.target)) return yield* installAndSave(scope, row);
          yield* exec(scope, row, allowLoadTargetArgv(names));
        }
        yield* failBeforeInstall(scope, row, "interrupted by a Mend restart");
      });
    const finish = (id: ResourceLoadId) =>
      Effect.gen(function* () {
        const row = yield* rows.get(id);
        if (row === null || !loadIsLive(row.phase)) return;
        const scope = yield* scopeOf(row.projectId);
        yield* restore(scope, row);
      });
    const supervise = (id: ResourceLoadId, run: Effect.Effect<void, ResourceLoadRefused>) =>
      run.pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            const row = yield* rows.get(id);
            if (row === null || !loadIsLive(row.phase)) return;
            if (row.phase === "installing" || row.phase === "saving") {
              // Keep the target locked to this load. Retry without exposing provider diagnostics.
              yield* Effect.sleep("2 seconds");
              yield* recoverOne(row);
            } else
              yield* failBeforeInstall(
                yield* scopeOf(row.projectId),
                row,
                "the source could not be staged",
              );
          }),
        ),
        Effect.catch(() =>
          Effect.logWarning("resource load paused; previous data is kept; recovery will retry"),
        ),
        Effect.forkIn(lifetime),
        Effect.asVoid,
      );

    const begin: ResourceLoads["Service"]["begin"] = (project, viewer, input, clock) =>
      Effect.gen(function* () {
        const denied = resourceActRefusal(project, viewer, { kind: "read" });
        if (denied !== null) return yield* refused(denied);
        const definition = yield* definitions.byName(project.id, input.name);
        if (definition === null) return yield* refused("no resource by this name");
        if (definition.spec.preset !== "postgres")
          return yield* refused("loads replace a Postgres database; this resource is not Postgres");
        if (input.worktreeId !== null) {
          const wt = yield* worktrees
            .byId(input.worktreeId)
            .pipe(Effect.mapError(() => refused("worktree not found")));
          if (wt.projectId !== project.id) return yield* refused("worktree not found");
        }
        const choice =
          input.worktreeId === null
            ? "shared"
            : choiceInEffect(
                definition.spec,
                (yield* definitions.listWithChoices(project.id, input.worktreeId)).find(
                  (d) => d.definition.id === definition.id,
                )?.choice ?? null,
              );
        const target =
          definition.spec.scope === "worktree"
            ? "own"
            : (input.target ?? (choice === "own" ? "own" : "shared"));
        if ((target === "own" || definition.spec.scope === "worktree") && input.worktreeId === null)
          return yield* refused("name the worktree whose database to load: --worktree <w>");
        if (target === "own" && input.worktreeId !== null) {
          const denial = resourceActRefusal(project, viewer, {
            kind: "use",
            changeOwner: yield* worktrees.changeOwnerOf(input.worktreeId),
          });
          if (denial !== null) return yield* refused(denial);
        }
        let pull: PullUrl | null = null;
        if (input.source.kind === "pull") {
          const parsed = parsePullUrl(input.source.url);
          if (!parsed.ok) return yield* refused(parsed.message);
          pull = parsed.value;
        }
        const started = yield* runtime.start(definition, input.worktreeId);
        if (started.instance.kind !== "running")
          return yield* refused("the Postgres server is not running");
        const row: StoredResourceLoad = {
          id: ResourceLoadId.make(crypto.randomUUID()),
          projectId: project.id,
          definitionId: definition.id,
          worktreeId: input.worktreeId,
          instanceKey: resourceInstanceKey(
            definition.id,
            definition.spec.scope === "worktree" ? input.worktreeId : null,
          ),
          database:
            target === "own" && definition.spec.scope === "project" && input.worktreeId !== null
              ? ownDatabaseName(input.worktreeId)
              : SHARED_DATABASE,
          target,
          label:
            pull?.label ??
            (input.source.kind === "upload"
              ? scrubLoadMessage(input.source.label).slice(0, 200)
              : "database"),
          startedBy: viewer.userId,
          phase: pull === null ? "receiving" : "pulling",
          bytesDone: 0,
          bytesTotal: input.source.kind === "upload" ? input.source.bytesTotal : null,
          savedPath: null,
          savedAt: null,
          message: null,
          createdAt: clock.now,
        };
        yield* rows.begin(row).pipe(Effect.mapError((error) => refused(error.message)));
        if (pull !== null) {
          const source = pull;
          yield* supervise(
            row.id,
            Effect.gen(function* () {
              const scope = yield* scopeOf(row.projectId);
              const names = loadNames(row.database, row.id);
              yield* exec(scope, row, LOAD_DIR_ARGV, undefined, "root");
              const progress = yield* Effect.gen(function* () {
                while (true) {
                  const size = yield* exec(scope, row, loadSizeArgv(names));
                  yield* rows.progress(row.id, Number(size.trim()) || 0);
                  yield* Effect.sleep("1 second");
                }
              }).pipe(Effect.forkChild);
              yield* exec(
                scope,
                row,
                pullLoadArgv(names, source.connection),
                Stream.toAsyncIterable(
                  Stream.make(new TextEncoder().encode(`${Redacted.value(source.password)}\n`)),
                ),
              ).pipe(Effect.ensuring(Fiber.interrupt(progress)));
              yield* rows.progress(
                row.id,
                Number((yield* exec(scope, row, loadSizeArgv(names))).trim()) || 0,
              );
              yield* next(row, "restoring");
              yield* finish(row.id);
            }),
          );
        }
        return answer(row, definition, clock);
      });

    return ResourceLoads.of({
      begin,
      read: (project, viewer, id, clock) =>
        authorized(project, viewer, id, false).pipe(
          Effect.map(({ row, definition }) => answer(row, definition, clock)),
        ),
      feed: (project, viewer, id, body, clock) =>
        Effect.gen(function* () {
          const { row, definition } = yield* authorized(project, viewer, id, true);
          if (row.phase !== "receiving" || feeding.has(id))
            return yield* refused("this upload is not waiting for bytes");
          feeding.add(id);
          const run = Effect.gen(function* () {
            const scope = yield* scopeOf(row.projectId);
            yield* exec(scope, row, LOAD_DIR_ARGV, undefined, "root");
            let bytes = 0;
            let last = 0;
            const stream = body.pipe(
              Stream.tap((chunk) =>
                Effect.gen(function* () {
                  bytes += chunk.length;
                  if (bytes > 20 * 1024 ** 3)
                    return yield* refused("a load may receive at most 20 GiB");
                  if (row.bytesTotal !== null && bytes > row.bytesTotal)
                    return yield* refused("the upload is larger than declared");
                  if (Date.now() - last > 1000) {
                    last = Date.now();
                    yield* rows.progress(id, bytes);
                  }
                }),
              ),
            );
            const staged = yield* exec(
              scope,
              row,
              stageLoadArgv(loadNames(row.database, id)),
              Stream.toAsyncIterable(stream),
            ).pipe(Effect.result);
            if (
              staged._tag === "Failure" ||
              (row.bytesTotal !== null && bytes !== row.bytesTotal)
            ) {
              yield* failBeforeInstall(scope, row, "the upload did not finish");
              return yield* refused("the upload did not finish; the database was not changed");
            }
            yield* rows.progress(id, bytes);
            return yield* Effect.gen(function* () {
              const restoring = yield* next({ ...row, bytesDone: bytes }, "restoring");
              yield* supervise(id, finish(id));
              return answer(restoring, definition, clock);
            }).pipe(Effect.uninterruptible);
          });
          return yield* run.pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                const current = yield* rows.get(id);
                if (current?.phase === "receiving")
                  yield* failBeforeInstall(
                    yield* scopeOf(current.projectId),
                    current,
                    "the upload did not finish",
                  );
              }).pipe(Effect.ignore),
            ),
            Effect.ensuring(Effect.sync(() => feeding.delete(id))),
          );
        }),
      session: (id) =>
        Effect.gen(function* () {
          const session = yield* sessions
            .byId(id)
            .pipe(Effect.mapError(() => refused("session not found")));
          const project = yield* projects
            .byId(session.projectId)
            .pipe(Effect.mapError(() => refused("project not found")));
          const owner = session.ownerUserId;
          const membership = owner === null ? null : yield* organizations.membershipOf(owner);
          if (owner === null || membership === null || session.worktreeId === null)
            return yield* refused("this session has no member owner or worktree");
          return {
            project,
            viewer: {
              userId: owner,
              organizationId: membership.organization.id,
              role: membership.role,
            },
            worktreeId: session.worktreeId,
          };
        }),
      recover: Effect.gen(function* () {
        for (const row of yield* rows.live())
          yield* recoverOne(row).pipe(
            Effect.catch(() =>
              Effect.logWarning("resource load recovery paused; previous data is kept"),
            ),
          );
      }),
    });
  }),
);
