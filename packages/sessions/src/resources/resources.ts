import {
  OrganizationsRepo,
  ProjectsRepo,
  ResourcesRepo,
  SessionsRepo,
  type StoredResourceInstance,
  type StoredResourceIdentity,
  UsersRepo,
  WorktreesRepo,
  ResourceDefinitionRefusedError,
} from "@mend/db";
import type { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  ResourceRefusal,
  type ProjectTenancy,
  type ResourceAct,
  resourceActRefusal,
  type ResourceControlled,
  type ResourceEnvAnswer,
  type ResourceFileRead,
  type ResourceFileTable,
  type ResourceSelectionEntry,
  type ResourceSessionAnswer,
  type ResourceSettingEntry,
  type ResourcesPage,
  resourceSpecDigest,
  resourceStatusLine,
  resourceTableNotices,
  resourceListEntries,
  shellExports,
  type Viewer,
  type WorktreeChoice,
  type ResourceLevel,
  type ResourceStartOptions,
  type ResourceStopOptions,
  type ResourceStarted,
  resourceDefinitionRefusals,
  envCollisionRefusals,
  changesWhatOwnIs,
  resourceBindings,
  choiceInEffect,
  resourceEnvPrefix,
  changedResourceEnvNames,
  resourceSwitchMessage,
  resourcePositionals,
  resourceLevelFlag,
  resourceLevelHint,
  resourceChoiceOf,
  type ResourceAddRequest,
  type ResourceAdded,
  resourceAdditionOf,
  resourceAdditionDefinition,
  resourceAddedLines,
  resourceTableToml,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { SessionChannelRegistry } from "../session-channel.ts";
import { WorktreeReads } from "../worktree-reads.ts";
import { ResourceTableWrites } from "./append-table.ts";
import {
  ImageFailureReason,
  imageRefusalClause,
  imageRefusalLine,
  type ImageResolutionError,
  ResourceImageResolver,
} from "./image-resolver.ts";
import { type InstanceObserved, ResourceRuntime } from "./runtime.ts";
import { WorktreeServiceRestarts } from "./service-restarts.ts";
import { ResourceStatusReads } from "./status-reads.ts";
import { ResourceTableReads, readDefaultBranchTables, tablesOf } from "./worktree-tables.ts";

/** A project as the resource rules read it. */
export type ResourceProject = ProjectTenancy & { readonly id: ProjectId };

/** The act was refused, in the words `resourceActRefusal` gives. */
export class ResourceActRefusedError extends Schema.TaggedError<ResourceActRefusedError>()(
  "ResourceActRefusedError",
  { message: Schema.String },
) {}

/**
 * The image could not be pinned: `message` is the line, `@db · image postgres:17 · … · not
 * added`, and `refusal` its `image` key with the clause after it.
 */
export class ResourceImageRefusedError extends Schema.TaggedError<ResourceImageRefusedError>()(
  "ResourceImageRefusedError",
  {
    name: Schema.String,
    refusal: ResourceRefusal,
    message: Schema.String,
    reason: ImageFailureReason,
  },
) {}

/** Mend remembers no resource by this name. */
export class ResourceNameNotFoundError extends Schema.TaggedError<ResourceNameNotFoundError>()(
  "ResourceNameNotFoundError",
  { name: Schema.String },
) {}

/** A worktree resource runs one instance per worktree, so an act on it names the worktree. */
export class ResourceWorktreeNeededError extends Schema.TaggedError<ResourceWorktreeNeededError>()(
  "ResourceWorktreeNeededError",
  { name: Schema.String, message: Schema.String },
) {}

/** A reset that did not happen, in a status line's words. */
export class ResourceNotResetError extends Schema.TaggedError<ResourceNotResetError>()(
  "ResourceNotResetError",
  { name: Schema.String, message: Schema.String },
) {}

/** A reader's clock, for the status lines a reply carries. */
export interface ReaderClock {
  readonly now: Date;
  readonly timeZone: string;
}

/** Resource operations authenticated at their common application boundary. */
export class Resources extends Context.Service<
  Resources,
  {
    readonly add: (
      project: ResourceProject,
      viewer: Viewer,
      request: ResourceAddRequest,
    ) => Effect.Effect<ResourceAdded, ResourceActRefusedError | ResourceDefinitionRefusedError>;
    readonly list: (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
      allInstances?: boolean,
    ) => Effect.Effect<ResourcesPage, ResourceActRefusedError>;
    readonly remove: (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      options: { readonly level: ResourceLevel; readonly worktreeId: WorktreeId | null },
    ) => Effect.Effect<
      { readonly statusLine: string },
      ResourceActRefusedError | ResourceNameNotFoundError
    >;
    readonly use: (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      name: string,
      mode: WorktreeChoice,
      clock: ReaderClock,
      except?: SessionId,
    ) => Effect.Effect<ResourceSelectionEntry, ResourceActRefusedError | ResourceNameNotFoundError>;
    readonly reset: (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      worktreeId: WorktreeId,
      target: "shared" | "own" | null,
      clock: ReaderClock,
    ) => Effect.Effect<
      { readonly statusLine: string },
      ResourceActRefusedError | ResourceNameNotFoundError | ResourceNotResetError
    >;
    readonly start: (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      options: ResourceStartOptions,
      clock: ReaderClock,
      except?: SessionId,
    ) => Effect.Effect<
      ResourceStarted,
      ResourceActRefusedError | ResourceDefinitionRefusedError | ResourceImageRefusedError
    >;
    readonly stop: (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      options: ResourceStopOptions,
      clock: ReaderClock,
    ) => Effect.Effect<ResourceControlled, ResourceActRefusedError | ResourceNameNotFoundError>;
    readonly env: (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      clock: ReaderClock,
    ) => Effect.Effect<ResourceEnvAnswer, ResourceActRefusedError>;
    readonly forSession: (
      sessionId: SessionId,
      argv: ReadonlyArray<string>,
      clock: ReaderClock,
    ) => Effect.Effect<ResourceSessionAnswer, { readonly message: string }>;
  }
>()("@mend/sessions/Resources") {}

const refused = (message: string) => new ResourceActRefusedError({ message });
const decide = (project: ResourceProject, viewer: Viewer, act: ResourceAct) => {
  const refusal = resourceActRefusal(project, viewer, act);
  return refusal === null ? Effect.void : Effect.fail(refused(refusal));
};
const pageLines = (page: ResourcesPage): ReadonlyArray<string> => [
  ...resourceListEntries(page).flatMap((entry) => [
    entry.statusLine,
    ...entry.instances.map((instance) => `  ${instance.statusLine}`),
  ]),
  ...(page.file.kind === "read"
    ? resourceTableNotices(page.file)
    : page.file.kind === "unavailable" || page.file.kind === "unparsed"
      ? [page.file.message]
      : []),
];
const flagOf = (args: ReadonlyArray<string>, flag: string): string | null => {
  const at = args.indexOf(flag);
  const value = at === -1 ? undefined : args[at + 1];
  return value === undefined || value.startsWith("--") ? null : value;
};
const SESSION_USAGE =
  "mend resource list · add <name> --preset <p> --version <v> or --image <ref> --port name=port[/udp] · start <name> --project|--worktree [--restart] · stop <name> [--project|--worktree] · use <name> project|worktree|off · remove <name> --project|--worktree · reset <name> [--target shared|own] · load <name> · env";

const controlled = (
  definition: StoredResourceInstance,
  level: ResourceLevel,
  seen: InstanceObserved,
  clock: ReaderClock,
  message: string | null = null,
): ResourceControlled => ({
  instance: seen.instance.kind,
  statusLine: resourceStatusLine(
    {
      kind: "observed",
      definition: definition.spec,
      level,
      use:
        definition.spec.preset === "postgres"
          ? level === "worktree"
            ? { kind: "own", origin: null, available: true }
            : { kind: "shared" }
          : { kind: "worktree" },
      instance: seen.instance,
      observedAt: seen.observedAt,
    },
    clock,
  ),
  message,
});
/** Start reads the chosen worktree; the page reads the default branch beside remembered instances. */
export const ResourcesLive: Layer.Layer<
  Resources,
  never,
  | ResourceTableWrites
  | ResourcesRepo
  | ProjectsRepo
  | SessionsRepo
  | WorktreesRepo
  | OrganizationsRepo
  | WorktreeReads
  | ResourceTableReads
  | ResourceImageResolver
  | ResourceRuntime
  | WorktreeServiceRestarts
  | ResourceStatusReads
  | UsersRepo
> = Layer.effect(
  Resources,
  Effect.gen(function* () {
    const writes = yield* ResourceTableWrites;
    const repo = yield* ResourcesRepo;
    const projects = yield* ProjectsRepo;
    const sessions = yield* SessionsRepo;
    const worktrees = yield* WorktreesRepo;
    const organizations = yield* OrganizationsRepo;
    const reads = yield* WorktreeReads;
    const tableReads = yield* ResourceTableReads;
    const images = yield* ResourceImageResolver;
    const runtime = yield* ResourceRuntime;
    const restarts = yield* WorktreeServiceRestarts;
    const status = yield* ResourceStatusReads;
    const users = yield* UsersRepo;
    /** A person's name as the status line says who stopped an instance; the id when unknown. */
    const nameOf = (id: string) =>
      users.byIds([id]).pipe(Effect.map((found) => found[0]?.name ?? id));
    const checkedWorktree = (project: ResourceProject, worktreeId: WorktreeId) =>
      worktrees.byId(worktreeId).pipe(
        Effect.mapError(() => refused("worktree not found")),
        Effect.flatMap((worktree) =>
          worktree.projectId === project.id
            ? Effect.succeed(worktree)
            : Effect.fail(refused("worktree not found")),
        ),
      );
    const mayChoose = (project: ResourceProject, viewer: Viewer, worktreeId: WorktreeId) =>
      worktrees
        .changeOwnerOf(worktreeId)
        .pipe(
          Effect.flatMap((changeOwner) => decide(project, viewer, { kind: "use", changeOwner })),
        );
    const instanceAt = (projectId: ProjectId, name: string, worktreeId: WorktreeId | null) =>
      repo
        .listForProject(projectId)
        .pipe(
          Effect.map(
            (instances) =>
              instances.find((row) => row.spec.name === name && row.worktreeId === worktreeId) ??
              null,
          ),
        );
    const named = (projectId: ProjectId, name: string) =>
      repo
        .byName(projectId, name)
        .pipe(
          Effect.flatMap((row) =>
            row === null
              ? Effect.fail(new ResourceNameNotFoundError({ name }))
              : Effect.succeed(row),
          ),
        );
    const effective = (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      resourceId: StoredResourceInstance["id"],
    ) =>
      repo
        .bindingRows(projectId, worktreeId)
        .pipe(
          Effect.map((rows) =>
            choiceInEffect(
              rows.selections.find((row) => row.resourceId === resourceId)?.mode ?? null,
              rows.usesProjectResources,
            ),
          ),
        );
    const applyChoice = Effect.fn("Resources.applyChoice")(function* (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      definition: Pick<StoredResourceIdentity, "id" | "name">,
      mode: WorktreeChoice,
      from: WorktreeChoice,
      beforeEnv: Readonly<Record<string, string>>,
      except: SessionId | null,
    ) {
      const selection = yield* repo
        .setSelection(project.id, worktreeId, definition.id, mode, viewer.userId)
        .pipe(
          Effect.mapError((error) =>
            refused(
              error._tag === "ResourceSelectionRefusedError"
                ? error.refusal.message
                : "resource is gone",
            ),
          ),
        );
      const linked = yield* runtime.relink(project.id);
      if (from === mode)
        return { selection, message: linked.length === 0 ? null : linked.join("\n") };
      const afterEnv = (yield* runtime.envOf(project.id, worktreeId)).env;
      const prefix = resourceEnvPrefix(definition.name);
      const changed = changedResourceEnvNames(beforeEnv, afterEnv, prefix).filter((name) =>
        name.startsWith(prefix),
      );
      const services = yield* restarts.restart(worktreeId, viewer.userId);
      const message = resourceSwitchMessage({
        name: definition.name,
        from,
        to: mode,
        changed,
        services,
      });
      const failed = yield* restarts.tell(worktreeId, viewer.userId, message, except);
      return { selection, message: [message, ...linked, ...failed].join("\n") };
    });

    const add = Effect.fn("Resources.add")(function* (
      project: ResourceProject,
      viewer: Viewer,
      request: ResourceAddRequest,
    ) {
      yield* decide(project, viewer, { kind: "add", replaces: null });
      const worktree =
        request.worktreeId === null ? null : yield* checkedWorktree(project, request.worktreeId);
      const spec = resourceAdditionDefinition(request.definition);
      const refusals = resourceDefinitionRefusals(spec);
      if (refusals.length > 0)
        return yield* new ResourceDefinitionRefusedError({ name: spec.name, refusals });
      const table = resourceTableToml(spec);
      const result =
        worktree === null
          ? { kind: "unreachable" as const, reason: "this project has no selected worktree", table }
          : yield* writes.appendResourceTable({
              projectId: project.id,
              worktreeId: worktree.id,
              name: spec.name,
              table,
            });
      switch (result.kind) {
        case "written":
          return {
            ...result,
            table,
            worktree: worktree?.name ?? "",
            statusLine: `@${spec.name} · added to ${result.path} in ${worktree?.name ?? ""} · start it: mend resource start ${spec.name} --project or --worktree`,
          } satisfies ResourceAdded;
        case "declared":
          return {
            ...result,
            table,
            statusLine: `@${spec.name} · already declared in ${result.path}`,
          } satisfies ResourceAdded;
        case "unparsed":
          return { ...result, table, statusLine: result.message } satisfies ResourceAdded;
        case "unreachable":
          return {
            ...result,
            table,
            statusLine: `@${spec.name} · ${result.reason} · add this table to .mend/mend.toml yourself:`,
          } satisfies ResourceAdded;
      }
    });

    const list = Effect.fn("Resources.list")(function* (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
      allInstances = false,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      if (worktreeId !== null) yield* checkedWorktree(project, worktreeId);
      const listed = yield* repo.listWithChoices(project.id, allInstances ? null : worktreeId);
      const shown = yield* status.viewsFor(
        listed,
        project.id,
        allInstances ? null : worktreeId,
        clock,
      );
      const owner = worktreeId === null ? null : yield* worktrees.changeOwnerOf(worktreeId);
      const choices =
        allInstances && worktreeId !== null
          ? yield* repo.bindingRows(project.id, worktreeId)
          : null;
      let settings = listed.map(
        (row): ResourceSettingEntry => ({
          id: row.definition.id,
          digest: row.definition.specDigest,
          spec: row.definition.spec,
          image: row.definition.image,
          addedBy: row.definition.startedBy,
          level:
            allInstances || worktreeId === null
              ? row.definition.worktreeId === null
                ? "project"
                : "worktree"
              : row.choice === "worktree"
                ? "worktree"
                : "project",
          worktreeId: row.definition.worktreeId,
          choice:
            choices === null
              ? row.choice
              : choiceInEffect(
                  choices.selections.find((selection) => selection.resourceId === row.definition.id)
                    ?.mode ?? null,
                  choices.usesProjectResources,
                ),
          canRemove:
            resourceActRefusal(project, viewer, {
              kind: "remove-definition",
              addedBy: row.definition.startedBy,
            }) === null,
          canChoose:
            worktreeId !== null &&
            resourceActRefusal(project, viewer, { kind: "use", changeOwner: owner }) === null,
          canLoadOwn: worktreeId !== null && owner === viewer.userId,
          instance: shown(row).instance,
          statusLine: resourceStatusLine(shown(row).view, clock),
        }),
      );
      let file: ResourceFileRead = { kind: "not-selected" };
      if (allInstances || worktreeId !== null) {
        const read =
          allInstances || worktreeId === null
            ? yield* readDefaultBranchTables(reads, project.id)
            : yield* tableReads.forWorktree(project.id, worktreeId);
        file =
          read.kind === "read"
            ? {
                ...read,
                worktreeId: allInstances ? null : worktreeId,
                tables: read.tables.map(
                  (spec): ResourceFileTable => ({
                    spec,
                    digest: resourceSpecDigest(spec),
                    statusLine: resourceStatusLine({ kind: "defined", definition: spec }, clock),
                  }),
                ),
              }
            : { ...read, worktreeId: allInstances ? null : worktreeId };
        const selected =
          worktreeId === null
            ? null
            : allInstances
              ? yield* tableReads.forWorktree(project.id, worktreeId)
              : read;
        if (selected?.kind === "read")
          settings = settings.map((entry) => {
            const requested = selected.tables.find((spec) => spec.name === entry.spec.name);
            return requested === undefined || resourceSpecDigest(requested) === entry.digest
              ? entry
              : {
                  ...entry,
                  statusLine: resourceStatusLine(
                    entry.level === "worktree" &&
                      entry.spec.preset === "postgres" &&
                      entry.worktreeId === null
                      ? { kind: "own-on-differing-server", definition: entry.spec, requested }
                      : { kind: "definition-differs", definition: entry.spec, level: entry.level },
                    clock,
                  ),
                };
          });
      }
      return { settings, file } satisfies ResourcesPage;
    });

    const use = Effect.fn("Resources.use")(function* (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      name: string,
      mode: WorktreeChoice,
      clock: ReaderClock,
      except?: SessionId,
    ) {
      yield* checkedWorktree(project, worktreeId);
      yield* mayChoose(project, viewer, worktreeId);
      const definition = (yield* repo.listIdentities(project.id)).find((row) => row.name === name);
      if (definition === undefined) return yield* new ResourceNameNotFoundError({ name });
      const rows = yield* repo.bindingRows(project.id, worktreeId);
      const candidate = resourceBindings({
        ...rows,
        selections: [
          ...rows.selections.filter((row) => row.resourceId !== definition.id),
          { resourceId: definition.id, mode },
        ],
      }).find((row) => row.resourceId === definition.id);
      if (mode !== "off" && candidate === undefined)
        return yield* refused(
          mode === "worktree" &&
            rows.instances.some(
              (row) => row.resourceId === definition.id && row.spec.preset === "postgres",
            )
            ? `@${name} · no own database yet · mend resource start ${name} --worktree`
            : `@${name} · no ${mode} instance yet · mend resource start ${name} --${mode}`,
        );
      const from = yield* effective(project.id, worktreeId, definition.id);
      const before = (yield* runtime.envOf(project.id, worktreeId)).env;
      const answer = yield* applyChoice(
        project,
        viewer,
        worktreeId,
        definition,
        mode,
        from,
        before,
        except ?? null,
      );
      return {
        definitionId: definition.id,
        worktreeId,
        mode,
        chosenBy: answer.selection.chosenBy,
        statusLine: answer.message ?? `@${name} · ${mode}`,
        message: answer.message,
      } satisfies ResourceSelectionEntry;
    });

    const start = Effect.fn("Resources.start")(function* (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      options: ResourceStartOptions,
      clock: ReaderClock,
      except?: SessionId,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      yield* checkedWorktree(project, options.worktreeId);
      if (options.level === "worktree") yield* mayChoose(project, viewer, options.worktreeId);
      const read = yield* tableReads.forWorktree(project.id, options.worktreeId);
      if (read.kind === "unavailable" || read.kind === "unparsed")
        return yield* refused(read.message);
      if (read.kind === "read") {
        const refusals = read.refused.filter(
          (entry) => entry.key === `resource.${name}` || entry.key.startsWith(`resource.${name}.`),
        );
        if (refusals.length > 0)
          return yield* new ResourceDefinitionRefusedError({
            name,
            refusals: refusals.map((entry) => ({
              key: entry.key
                .replace(`resource.${name}.`, "")
                .replace(`resource.${name}`, "definition"),
              message: entry.message,
            })),
          });
      }
      const tables = tablesOf(read);
      const requested = tables.find((spec) => spec.name === name);
      const all = yield* repo.listForProject(project.id);
      const projectServer = all.find((row) => row.spec.name === name && row.worktreeId === null);
      // Migrated worktree Postgres containers retain their key and data until explicitly removed.
      const legacy = all.find(
        (row) =>
          row.spec.name === name &&
          row.worktreeId === options.worktreeId &&
          row.spec.preset === "postgres",
      );
      const postgresOwn =
        options.level === "worktree" &&
        legacy === undefined &&
        (requested === undefined
          ? projectServer?.spec.preset === "postgres"
          : requested.preset === "postgres");
      if (postgresOwn && projectServer !== undefined && projectServer.spec.preset !== "postgres")
        return yield* refused(
          `@${name} · the project instance is not Postgres · mend resource start ${name} --project --restart`,
        );
      if (
        requested === undefined &&
        postgresOwn &&
        projectServer !== undefined &&
        !(yield* repo.ownDatabases(options.worktreeId)).has(projectServer.id)
      )
        return yield* refused(`no [resource.${name}] in this worktree's .mend/mend.toml`);
      const targetWorktree = options.level === "project" || postgresOwn ? null : options.worktreeId;
      let held =
        all.find((row) => row.spec.name === name && row.worktreeId === targetWorktree) ?? null;
      if (requested === undefined && held === null) {
        return yield* refused(`no [resource.${name}] in this worktree's .mend/mend.toml`);
      }
      const spec = requested ?? held?.spec;
      if (spec === undefined)
        return yield* Effect.die("start has neither a file nor remembered spec");
      const refusals = [
        ...resourceDefinitionRefusals(spec),
        ...envCollisionRefusals([
          ...all.filter((row) => row.spec.name !== name).map((row) => row.spec),
          ...tables.filter(
            (table) => table.name !== name && !all.some((row) => row.spec.name === table.name),
          ),
          spec,
        ])
          .filter((entry) => entry.resource === name)
          .map((entry) => entry.refusal),
      ];
      if (refusals.length > 0) return yield* new ResourceDefinitionRefusedError({ name, refusals });
      const differs =
        requested !== undefined &&
        held !== null &&
        held.specDigest !== resourceSpecDigest(requested);
      if (
        held !== null &&
        differs &&
        !postgresOwn &&
        changesWhatOwnIs(held.spec, spec) &&
        (yield* repo.ownSelections(project.id)).has(held.id)
      )
        return yield* refused(
          `@${name} · cannot change the Postgres preset while worktrees hold own databases`,
        );
      if (held !== null && differs && !postgresOwn && !options.restart) {
        const using: Array<{ id: WorktreeId; name: string }> = [];
        for (const worktree of yield* worktrees.listForProject(project.id)) {
          if (options.level === "worktree" && worktree.id !== options.worktreeId) continue;
          const rows = yield* repo.bindingRows(project.id, worktree.id);
          const binding = resourceBindings(rows).find((row) => row.resourceId === held?.id);
          if (
            (binding !== undefined &&
              (options.level === "project" ? binding.instanceKey === held.id : true)) ||
            (options.level === "project" &&
              held.spec.preset === "postgres" &&
              rows.ownDatabases.has(held.id))
          )
            using.push({ id: worktree.id, name: worktree.name });
        }
        return {
          kind: "needs-restart",
          statusLine: resourceStatusLine(
            { kind: "definition-differs", definition: spec, level: options.level },
            clock,
          ),
          hint: `mend resource start ${name} --${options.level} --restart`,
          worktrees: using,
        } satisfies ResourceStarted;
      }
      const before = (yield* runtime.envOf(project.id, options.worktreeId)).env;
      const identity = yield* repo.ensureIdentity(project.id, name);
      const from = yield* effective(project.id, options.worktreeId, identity.id);
      const notes: string[] = [];
      if (held === null || (differs && !postgresOwn)) {
        const image = yield* images.resolve(spec.image).pipe(
          Effect.mapError(
            (error: ImageResolutionError) =>
              new ResourceImageRefusedError({
                name,
                refusal: { key: "image", message: imageRefusalClause(error) },
                reason: error.reason,
                message: imageRefusalLine(name, error),
              }),
          ),
        );
        held = yield* repo.remember(
          project.id,
          identity.id,
          targetWorktree,
          spec,
          image.digest,
          viewer.userId,
        );
        if (postgresOwn) notes.push("started the project server for it");
      }
      const seen = yield* runtime.start(held, held.worktreeId);
      if (requested === undefined)
        notes.push("not in this worktree's .mend/mend.toml · started as it last ran");
      if (postgresOwn && requested !== undefined && differs)
        notes.push(
          resourceStatusLine(
            { kind: "own-on-differing-server", definition: held.spec, requested },
            clock,
          ),
        );
      if (options.level === "worktree") {
        if (postgresOwn) {
          if (seen.instance.kind !== "running")
            return yield* refused(
              `@${name} · the project server is not running · own database not made`,
            );
          const failure = yield* runtime.ensureOwnDatabase(held, options.worktreeId);
          if (failure !== null)
            return yield* refused(`@${name} · own database not made · ${failure}`);
        }
        const switched = yield* applyChoice(
          project,
          viewer,
          options.worktreeId,
          identity,
          "worktree",
          from,
          before,
          except ?? null,
        );
        if (switched.message !== null) notes.push(switched.message);
      } else notes.push(...(yield* runtime.relink(project.id)));
      const answer = controlled(
        held,
        options.level,
        seen,
        clock,
        notes.length === 0 ? null : notes.join("\n"),
      );
      return { kind: "started", ...answer } satisfies ResourceStarted;
    });

    const stop = Effect.fn("Resources.stop")(function* (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      options: ResourceStopOptions,
      clock: ReaderClock,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      if (options.worktreeId !== null) yield* checkedWorktree(project, options.worktreeId);
      else if (options.level !== "project")
        return yield* refused("name the worktree: --worktree-id <w>");
      const any = yield* named(project.id, name);
      const choice =
        options.level ??
        (options.worktreeId === null
          ? "project"
          : yield* effective(project.id, options.worktreeId, any.id));
      if (choice === "off")
        return yield* refused(
          `@${name} · off for this worktree · choose --project or --worktree to stop an instance`,
        );
      const ownInstance = yield* instanceAt(project.id, name, options.worktreeId);
      const postgresOwn =
        choice === "worktree" && ownInstance === null && any.spec.preset === "postgres";
      const definition = yield* instanceAt(
        project.id,
        name,
        choice === "project" || postgresOwn ? null : options.worktreeId,
      );
      if (definition === null) return yield* refused(`@${name} · no ${choice} instance`);
      return controlled(
        definition,
        choice,
        yield* runtime.stop(definition, definition.worktreeId, yield* nameOf(viewer.userId)),
        clock,
        postgresOwn ? "stops the project server, which every worktree on it uses" : null,
      );
    });
    const remove = Effect.fn("Resources.remove")(function* (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      options: { readonly level: ResourceLevel; readonly worktreeId: WorktreeId | null },
    ) {
      if (options.worktreeId !== null) yield* checkedWorktree(project, options.worktreeId);
      else if (options.level !== "project")
        return yield* refused("name the worktree: --worktree-id <w>");
      const any = yield* named(project.id, name);
      const ownInstance = yield* instanceAt(project.id, name, options.worktreeId);
      if (
        options.level === "worktree" &&
        ownInstance === null &&
        any.spec.preset === "postgres" &&
        any.worktreeId === null
      )
        return yield* refused(
          `@${name} · own databases are kept · use reset or remove the worktree`,
        );
      const definition = yield* instanceAt(
        project.id,
        name,
        options.level === "project" ? null : options.worktreeId,
      );
      if (definition === null) return yield* refused(`@${name} · no ${options.level} instance`);
      yield* decide(project, viewer, { kind: "remove-definition", addedBy: definition.startedBy });
      const archived = yield* runtime.archive(definition);
      if (archived.kind === "failed")
        return yield* refused(`@${name} · not archived · ${archived.message}`);
      yield* repo.removeInstance(definition.id, definition.worktreeId);
      const failures = yield* runtime.relink(project.id);
      return {
        statusLine: [
          `@${name} · ${options.level} · archived · volumes kept${archived.startedForArchive ? " · archive started its server" : ""}`,
          ...failures,
        ].join("\n"),
      };
    });
    const reset = Effect.fn("Resources.reset")(function* (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      worktreeId: WorktreeId,
      asked: "shared" | "own" | null,
      clock: ReaderClock,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      yield* checkedWorktree(project, worktreeId);
      const definition = yield* named(project.id, name);
      if (definition.spec.preset !== "postgres")
        return yield* new ResourceNotResetError({
          name,
          message: `@${name} · a reset saves and empties a Postgres database, and @${name} is not one`,
        });
      const mode = yield* effective(project.id, worktreeId, definition.id);
      const target = asked ?? (mode === "worktree" ? "own" : "shared");
      if (target === "own") yield* mayChoose(project, viewer, worktreeId);
      const outcome = yield* runtime.reset({ definition, worktreeId, target, at: clock.now });
      if (outcome.kind !== "reset")
        return yield* new ResourceNotResetError({
          name,
          message: `@${name} · not reset · ${outcome.kind === "failed" ? outcome.message : outcome.instance.kind}`,
        });
      return {
        statusLine: resourceStatusLine(
          {
            kind: "reset",
            definition: definition.spec,
            target,
            origin: outcome.origin,
            savedAt: outcome.savedAt,
          },
          clock,
        ),
      };
    });
    const env = Effect.fn("Resources.env")(function* (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      clock: ReaderClock,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      yield* checkedWorktree(project, worktreeId);
      const answer = yield* runtime.envOf(project.id, worktreeId);
      const definitions = yield* repo.listForProject(project.id);
      return {
        env: answer.env,
        exports: shellExports(answer.env),
        statusLines: answer.left.flatMap(({ resource, names }) => {
          const definition = definitions.find((row) => row.spec.name === resource);
          return definition === undefined
            ? []
            : [resourceStatusLine({ kind: "env-left", definition: definition.spec, names }, clock)];
        }),
      } satisfies ResourceEnvAnswer;
    });
    const forSession = Effect.fn("Resources.forSession")(function* (
      sessionId: SessionId,
      argv: ReadonlyArray<string>,
      clock: ReaderClock,
    ) {
      const session = yield* sessions.byId(sessionId).pipe(Effect.orDie);
      const project = yield* projects.byId(session.projectId).pipe(Effect.orDie);
      const owner = session.ownerUserId;
      const membership = owner === null ? null : yield* organizations.membershipOf(owner);
      if (owner === null || membership === null)
        return yield* refused("this session's owner is no longer a member of its organization");
      const viewer: Viewer = {
        userId: owner,
        organizationId: membership.organization.id,
        role: membership.role,
      };
      const [verb = "list", ...rest] = argv;
      const [name, second = ""] = resourcePositionals(rest);
      const level = resourceLevelFlag(rest);
      const worktreeId = session.worktreeId;
      const answer = Effect.gen(function* () {
        if (rest.includes("--project") && rest.includes("--worktree"))
          return yield* refused("choose one level: --project or --worktree");
        if (verb === "add") {
          const input = resourceAdditionOf(rest);
          if (!input.ok) return yield* refused(input.message);
          return {
            lines: resourceAddedLines(
              yield* add(project, viewer, { worktreeId, definition: input.definition }),
            ),
          };
        }
        if (verb === "list")
          return { lines: pageLines(yield* list(project, viewer, worktreeId, clock)) };
        if (verb === "env") {
          const current = yield* env(project, viewer, worktreeId, clock);
          return { lines: [...current.exports, ...current.statusLines.map((line) => `# ${line}`)] };
        }
        if (name === undefined)
          return yield* refused(`name the resource: mend resource ${verb} db`);
        switch (verb) {
          case "start": {
            if (level === null) return yield* refused(resourceLevelHint(name));
            const done = yield* start(
              project,
              viewer,
              name,
              { level, worktreeId, restart: rest.includes("--restart") },
              clock,
              sessionId,
            );
            return {
              lines:
                done.kind === "needs-restart"
                  ? [done.statusLine, ...done.worktrees.map((row) => row.name), done.hint]
                  : [done.statusLine, ...(done.message === null ? [] : done.message.split("\n"))],
            };
          }
          case "stop": {
            const done = yield* stop(
              project,
              viewer,
              name,
              { worktreeId, ...(level === null ? {} : { level }) },
              clock,
            );
            return {
              lines: [done.statusLine, ...(done.message === null ? [] : done.message.split("\n"))],
            };
          }
          case "remove": {
            if (level === null)
              return yield* refused(
                `choose a level: mend resource remove ${name} --project or --worktree`,
              );
            return {
              lines: [(yield* remove(project, viewer, name, { level, worktreeId })).statusLine],
            };
          }
          case "use": {
            const mode = resourceChoiceOf(second);
            if (mode === null)
              return yield* refused(
                `name a choice: mend resource use ${name} project|worktree|off`,
              );
            return {
              lines: (yield* use(
                project,
                viewer,
                worktreeId,
                name,
                mode,
                clock,
                sessionId,
              )).statusLine.split("\n"),
            };
          }
          case "reset": {
            const target = flagOf(rest, "--target");
            if (target !== null && target !== "shared" && target !== "own")
              return yield* refused("--target is shared or own");
            return {
              lines: [(yield* reset(project, viewer, name, worktreeId, target, clock)).statusLine],
            };
          }
          default:
            return yield* refused(`unknown resource command "${verb}" · ${SESSION_USAGE}`);
        }
      });
      return yield* answer.pipe(
        Effect.mapError((error): { readonly message: string } =>
          error._tag === "ResourceDefinitionRefusedError"
            ? {
                message: error.refusals
                  .map((refusal) => `@${error.name} · ${refusal.key} ${refusal.message}`)
                  .join("\n"),
              }
            : error._tag === "ResourceNameNotFoundError"
              ? { message: `no @${error.name} in this project · mend resource list shows them` }
              : { message: error.message },
        ),
      );
    });
    return { add, list, remove, use, reset, start, stop, env, forSession };
  }),
);

/** Serve the helper through its authenticated session channel. */
export const ResourcesChannelLive: Layer.Layer<never, never, Resources | SessionChannelRegistry> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const resources = yield* Resources;
      const registry = yield* SessionChannelRegistry;
      yield* Effect.acquireRelease(
        Effect.sync(() => registry.serveResources(resources.forSession)),
        () => Effect.sync(() => registry.serveResources(undefined)),
      );
    }),
  );
