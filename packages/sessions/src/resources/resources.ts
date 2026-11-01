import {
  type DefinitionVersion,
  type DefinitionWithChoice,
  OrganizationsRepo,
  ProjectsRepo,
  ResourceDefinitionNotFoundError,
  ResourceDefinitionRefusedError,
  type ResourceDefinitionStaleError,
  type ResourceSelectionRefusedError,
  ResourcesRepo,
  SessionsRepo,
  type StoredResourceDefinition,
  UsersRepo,
  WorktreesRepo,
} from "@mend/db";
import type { ProjectId, ResourceDefinitionId, SessionId, WorktreeId } from "@mend/domain";
import {
  choiceInEffect,
  choicesFor,
  type OwnDatabaseOrigin,
  PRESET_VERSION_RULE,
  presetDefinition,
  PresetVersion,
  type ProjectTenancy,
  type ResourceAct,
  resourceActRefusal,
  ResourceAddInput,
  type ResourceAddOffer,
  type ResourceAdded,
  type ResourceControlled,
  resourceDeclarationRefusals,
  type ResourceDefinitionInput,
  type ResourceEnvAnswer,
  type ResourceFileRead,
  type ResourceFileTable,
  type ResourceInstanceKind,
  resourceInstanceKey,
  ResourceRefusal,
  type ResourceSelectionEntry,
  type ResourceSettingEntry,
  type ResourceSettingsState,
  type ResourcesPage,
  type ResourcesStatus,
  type ResourceSpecDigest,
  resourceSpecDigest,
  resourceStatusLine,
  type ResourceStatusView,
  resourceTableNotices,
  type ResourceUse,
  shellExports,
  type Viewer,
  WORKSPACE_RESOURCE_REFUSAL,
  WorktreeChoice,
  withPresetCommand,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { SessionChannelRegistry } from "../session-channel.ts";
import { WorktreeReads } from "../worktree-reads.ts";
import {
  ImageFailureReason,
  imageRefusalClause,
  imageRefusalLine,
  type ImageResolutionError,
  ResourceImageResolver,
} from "./image-resolver.ts";
import { type InstanceObserved, type ProjectObservation, ResourceRuntime } from "./runtime.ts";
import { readWorktreeTables } from "./worktree-tables.ts";

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

/** Settings hold no resource by this name. */
export class ResourceNameNotFoundError extends Schema.TaggedError<ResourceNameNotFoundError>()(
  "ResourceNameNotFoundError",
  { name: Schema.String },
) {}

/** A worktree resource runs one instance per worktree, so an act on it names the worktree. */
export class ResourceWorktreeNeededError extends Schema.TaggedError<ResourceWorktreeNeededError>()(
  "ResourceWorktreeNeededError",
  { name: Schema.String, message: Schema.String },
) {}

/** A reader's clock, for the status lines a reply carries. */
export interface ReaderClock {
  readonly now: Date;
  readonly timeZone: string;
}

/**
 * The one owner of a project's resources (ADR 0019). Callers hand it a person they authenticated
 * and a project they resolved; every act passes `resourceActRefusal` here. The agent in a session
 * acts as the session's owner (`forSession`).
 */
export class Resources extends Context.Service<
  Resources,
  {
    /** Settings, each with its status line, and when `worktreeId` is set that worktree's file. */
    readonly list: (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) => Effect.Effect<ResourcesPage, ResourceActRefusedError>;
    /**
     * Adds the definition `input` names to settings, or replaces the one they hold under its
     * name, and starts it: a project resource at once, a worktree resource in `worktreeId` when one
     * is named. The image is pinned before anything is written.
     */
    readonly add: (
      project: ResourceProject,
      viewer: Viewer,
      input: ResourceAddInput,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) => Effect.Effect<
      ResourceAdded,
      ResourceActRefusedError | ResourceDefinitionRefusedError | ResourceImageRefusedError
    >;
    /** Removes the definition while it holds the spec read, and archives its instances. */
    readonly remove: (
      project: ResourceProject,
      viewer: Viewer,
      version: DefinitionVersion,
    ) => Effect.Effect<
      { readonly statusLine: string },
      ResourceActRefusedError | ResourceDefinitionNotFoundError | ResourceDefinitionStaleError
    >;
    /** Stores the worktree's choice and answers the row written. */
    readonly use: (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      mode: WorktreeChoice,
      clock: ReaderClock,
    ) => Effect.Effect<
      ResourceSelectionEntry,
      ResourceActRefusedError | ResourceDefinitionNotFoundError | ResourceSelectionRefusedError
    >;
    /** A person's start, which clears a person's stop; `worktreeId` for a worktree resource. */
    readonly start: (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) => Effect.Effect<
      ResourceControlled,
      ResourceActRefusedError | ResourceNameNotFoundError | ResourceWorktreeNeededError
    >;
    /** A person's stop, which holds against every launch until a person starts it. */
    readonly stop: (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) => Effect.Effect<
      ResourceControlled,
      ResourceActRefusedError | ResourceNameNotFoundError | ResourceWorktreeNeededError
    >;
    /** What every process in the worktree is told of its resources now; nothing is started. */
    readonly env: (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      clock: ReaderClock,
    ) => Effect.Effect<ResourceEnvAnswer, ResourceActRefusedError>;
    /**
     * A request through a session's own socket or channel: a read answers its project's status
     * lines, read for the session's owner, and its worktree's file, never a spec; any change is
     * refused.
     */
    readonly forSession: (
      sessionId: SessionId,
      act: ResourceAct,
      clock: ReaderClock,
    ) => Effect.Effect<ResourcesStatus, ResourceActRefusedError>;
  }
>()("@mend/sessions/Resources") {}

const decide = (project: ResourceProject, viewer: Viewer, act: ResourceAct) => {
  const refusal = resourceActRefusal(project, viewer, act);
  return refusal === null
    ? Effect.void
    : Effect.fail(new ResourceActRefusedError({ message: refusal }));
};

const allows = (project: ResourceProject, viewer: Viewer, act: ResourceAct) =>
  resourceActRefusal(project, viewer, act) === null;

/**
 * Who reads a page, and the worktree it is read for with that worktree's change owner: what every
 * flag on it is decided for, by the same `resourceActRefusal` the acts pass.
 */
interface PageReader {
  readonly project: ResourceProject;
  readonly viewer: Viewer;
  readonly worktree: { readonly id: WorktreeId; readonly changeOwner: string | null } | null;
}

/**
 * What settings hold, as one read listed them: each definition by name, and the state the
 * declaration rules decide against (`resourceDeclarationRefusals`).
 */
interface SettingsRead {
  readonly byName: ReadonlyMap<string, DefinitionWithChoice>;
  readonly state: ResourceSettingsState;
}

/** `owning`: how many worktrees hold each definition as `own`, which a new scope or preset would strand. */
const settingsRead = (
  projectId: ProjectId,
  listed: ReadonlyArray<DefinitionWithChoice>,
  owning: ReadonlyMap<ResourceDefinitionId, number>,
): SettingsRead => ({
  byName: new Map(listed.map((each) => [each.definition.spec.name, each])),
  state: {
    projectId,
    definitions: listed.map(({ definition }) => ({
      spec: definition.spec,
      digest: definition.specDigest,
      owning: owning.get(definition.id) ?? 0,
    })),
  },
});

/** How a `mend.toml` table stands against what settings hold under its name. */
const againstSettings = (
  settings: SettingsRead,
  spec: ResourceDefinitionInput,
  digest: ResourceSpecDigest,
) => {
  const held = settings.byName.get(spec.name);
  return held === undefined ? "absent" : held.definition.specDigest === digest ? "same" : "differs";
};

/**
 * Whether the reader may add a `mend.toml` table as it stands, decided in the add route's order:
 * settings holding it already, whose act it is (`resourceActRefusal`), then the rules
 * (`resourceDeclarationRefusals`).
 */
const addOffer = (
  reader: PageReader,
  settings: SettingsRead,
  spec: ResourceDefinitionInput,
  digest: ResourceSpecDigest,
): ResourceAddOffer => {
  const held = settings.byName.get(spec.name)?.definition ?? null;
  if (held?.specDigest === digest) return { kind: "added" };
  const denied = resourceActRefusal(reader.project, reader.viewer, {
    kind: "add",
    replaces: held === null ? null : { addedBy: held.addedBy },
  });
  if (denied !== null) return { kind: "denied", message: denied };
  const refusals = resourceDeclarationRefusals(settings.state, spec);
  return refusals.length > 0 ? { kind: "rejected", refusals } : { kind: "ready" };
};

/** Whether the reader may choose how the read worktree uses `spec`; a worktree resource has no choice. */
const mayChoose = (reader: PageReader, spec: ResourceDefinitionInput) =>
  reader.worktree !== null &&
  choicesFor(spec).length > 0 &&
  allows(reader.project, reader.viewer, { kind: "use", changeOwner: reader.worktree.changeOwner });

const isPresetVersion = Schema.is(PresetVersion);

/** A preset's definition, refused on `version` when the tag names no major. */
const presetSpec = (input: Extract<ResourceAddInput, { readonly kind: "preset" }>) => {
  const { version } = input;
  return isPresetVersion(version)
    ? Effect.succeed(presetDefinition({ ...input, version }))
    : Effect.fail(
        new ResourceDefinitionRefusedError({
          name: input.name,
          refusals: [{ key: "version", message: PRESET_VERSION_RULE }],
        }),
      );
};

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
const viewOf = (input: {
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

/** The page as a workspace may read it: status lines and the file's diagnostics. */
const statusOf = (page: ResourcesPage): ResourcesStatus => {
  const { file } = page;
  return {
    statusLines: page.settings.map((entry) => entry.statusLine),
    file:
      file.kind === "read"
        ? {
            kind: "read",
            observed: file.observed,
            statusLines: file.tables.map((table) => table.statusLine),
            notices: resourceTableNotices(file),
          }
        : file.kind === "absent"
          ? { kind: "absent", observed: file.observed }
          : file.kind === "unavailable"
            ? { kind: "unavailable", message: file.message }
            : file.kind === "unparsed"
              ? { kind: "unparsed", observed: file.observed, message: file.message }
              : { kind: "not-selected" },
  };
};

export const ResourcesLive: Layer.Layer<
  Resources,
  never,
  | ResourcesRepo
  | ProjectsRepo
  | SessionsRepo
  | UsersRepo
  | WorktreesRepo
  | OrganizationsRepo
  | WorktreeReads
  | ResourceImageResolver
  | ResourceRuntime
> = Layer.effect(
  Resources,
  Effect.gen(function* () {
    const repo = yield* ResourcesRepo;
    const projects = yield* ProjectsRepo;
    const sessions = yield* SessionsRepo;
    const users = yield* UsersRepo;
    const worktrees = yield* WorktreesRepo;
    const organizations = yield* OrganizationsRepo;
    const reads = yield* WorktreeReads;
    const images = yield* ResourceImageResolver;
    const runtime = yield* ResourceRuntime;

    /** Display names by account id, in one query; an id with no account reads as itself. */
    const namesOf = (ids: ReadonlyArray<string>) =>
      users.byIds(ids).pipe(
        Effect.map((found) => {
          const names = new Map(found.map((user) => [user.id, user.name]));
          return (id: string) => names.get(id) ?? id;
        }),
      );

    const changeOwner = (worktreeId: WorktreeId) => worktrees.changeOwnerOf(worktreeId);

    const settingEntry = (
      reader: PageReader,
      listed: DefinitionWithChoice,
      shown: { readonly view: ResourceStatusView; readonly instance: ResourceInstanceKind },
      clock: ReaderClock,
    ): ResourceSettingEntry => {
      const { definition, choice } = listed;
      return {
        id: definition.id,
        digest: definition.specDigest,
        spec: definition.spec,
        image: definition.image,
        addedBy: definition.addedBy,
        choice,
        canRemove: allows(reader.project, reader.viewer, {
          kind: "remove-definition",
          addedBy: definition.addedBy,
        }),
        canChoose: mayChoose(reader, definition.spec),
        instance: shown.instance,
        statusLine: resourceStatusLine(shown.view, clock),
      };
    };

    const readFile = Effect.fn("Resources.readFile")(function* (
      reader: PageReader,
      settings: SettingsRead,
      worktreeId: WorktreeId,
      clock: ReaderClock,
    ) {
      const read = yield* readWorktreeTables(reads, reader.project.id, worktreeId);
      switch (read.kind) {
        case "unavailable":
          return {
            kind: "unavailable",
            worktreeId,
            message: read.message,
          } satisfies ResourceFileRead;
        case "absent":
          return { kind: "absent", worktreeId, observed: read.observed } satisfies ResourceFileRead;
        case "unparsed":
          return {
            kind: "unparsed",
            worktreeId,
            observed: read.observed,
            message: read.message,
          } satisfies ResourceFileRead;
        case "read":
          return {
            kind: "read",
            worktreeId,
            observed: read.observed,
            tables: read.tables.map((spec): ResourceFileTable => {
              const digest = resourceSpecDigest(spec);
              return {
                digest,
                spec,
                add: addOffer(reader, settings, spec, digest),
                statusLine: resourceStatusLine(
                  {
                    kind: "declared",
                    definition: spec,
                    source: { kind: "file", settings: againstSettings(settings, spec, digest) },
                  },
                  clock,
                ),
              };
            }),
            refused: read.refused,
            ignored: read.ignored,
          } satisfies ResourceFileRead;
      }
    });

    /** Each definition's view for a read: one call to Sealant, and none when there is nothing. */
    const viewsFor = Effect.fn("Resources.viewsFor")(function* (
      listed: ReadonlyArray<DefinitionWithChoice>,
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) {
      const [observation, owns, nameOf] = yield* Effect.all(
        [
          listed.length === 0 ? Effect.succeed(null) : runtime.observe(projectId),
          worktreeId === null
            ? Effect.succeed(new Map<ResourceDefinitionId, OwnDatabaseOrigin>())
            : repo.ownDatabases(worktreeId),
          namesOf(listed.map(({ definition }) => definition.addedBy)),
        ],
        { concurrency: "unbounded" },
      );
      const lookup = lookupIn(observation, clock.now);
      return (each: DefinitionWithChoice) =>
        viewOf({
          definition: each.definition,
          choice: each.choice,
          worktreeId,
          owns,
          observation,
          lookup,
          addedBy: nameOf(each.definition.addedBy),
        });
    });

    const list = Effect.fn("Resources.list")(function* (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      const [owner, definitions, owning] = yield* Effect.all(
        [
          worktreeId === null ? Effect.succeed(null) : changeOwner(worktreeId),
          repo.listWithChoices(project.id, worktreeId),
          repo.ownSelections(project.id),
        ],
        { concurrency: "unbounded" },
      );
      const reader: PageReader = {
        project,
        viewer,
        worktree: worktreeId === null ? null : { id: worktreeId, changeOwner: owner },
      };
      const shownOf = yield* viewsFor(definitions, project.id, worktreeId, clock);
      const settings = settingsRead(project.id, definitions, owning);
      const file: ResourceFileRead =
        worktreeId === null
          ? { kind: "not-selected" }
          : yield* readFile(reader, settings, worktreeId, clock);
      return {
        settings: definitions.map((listed) => settingEntry(reader, listed, shownOf(listed), clock)),
        file,
      } satisfies ResourcesPage;
    });

    const add = Effect.fn("Resources.add")(function* (
      project: ResourceProject,
      viewer: Viewer,
      input: ResourceAddInput,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      const spec =
        input.kind === "preset" ? yield* presetSpec(input) : withPresetCommand(input.spec);
      const [listed, owning] = yield* Effect.all(
        [repo.listWithChoices(project.id, null), repo.ownSelections(project.id)],
        { concurrency: "unbounded" },
      );
      const settings = settingsRead(project.id, listed, owning);
      const held = settings.byName.get(spec.name)?.definition ?? null;
      const reader: PageReader = { project, viewer, worktree: null };
      const answer = (definition: StoredResourceDefinition, resolvedBy: string | null) =>
        Effect.gen(function* () {
          // Adding is running: a project resource starts now, a worktree resource in the worktree
          // the add came from.
          const started =
            definition.spec.scope === "project" || worktreeId !== null
              ? yield* runtime.start(definition, worktreeId)
              : null;
          const nameOf = yield* namesOf([definition.addedBy]);
          const listedNow: DefinitionWithChoice = { definition, choice: null };
          const shown = viewOf({
            definition,
            choice: null,
            worktreeId: definition.spec.scope === "worktree" ? worktreeId : null,
            owns: new Map(),
            observation: null,
            lookup: () => started ?? { instance: { kind: "not-started" }, observedAt: clock.now },
            addedBy: nameOf(definition.addedBy),
          });
          return {
            definition: settingEntry(reader, listedNow, shown, clock),
            resolvedBy,
          } satisfies ResourceAdded;
        });
      const replacing = resourceActRefusal(project, viewer, {
        kind: "add",
        replaces: held === null ? null : { addedBy: held.addedBy },
      });
      if (replacing !== null) {
        // The same spec again is settings as they are; only its adder or a manager repins it.
        if (held?.specDigest === resourceSpecDigest(spec)) return yield* answer(held, null);
        return yield* new ResourceActRefusedError({ message: replacing });
      }
      // Every refusal that needs no registry comes before one is asked; the repo decides them
      // again under its locks.
      const refusals = resourceDeclarationRefusals(settings.state, spec);
      if (refusals.length > 0) {
        return yield* new ResourceDefinitionRefusedError({ name: spec.name, refusals });
      }
      const image = yield* images.resolve(spec.image).pipe(
        Effect.mapError(
          (error: ImageResolutionError) =>
            new ResourceImageRefusedError({
              name: spec.name,
              refusal: { key: "image", message: imageRefusalClause(error) },
              reason: error.reason,
              message: imageRefusalLine(spec.name, error),
            }),
        ),
      );
      const stored = yield* repo.declare(
        project.id,
        { spec, imageDigest: image.digest },
        viewer.userId,
      );
      return yield* answer(stored, image.resolvedBy);
    });

    const remove = Effect.fn("Resources.remove")(function* (
      project: ResourceProject,
      viewer: Viewer,
      version: DefinitionVersion,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      const held = (yield* repo.listForProject(project.id)).find((each) => each.id === version.id);
      if (held === undefined) return yield* new ResourceDefinitionNotFoundError({ id: version.id });
      yield* decide(project, viewer, { kind: "remove-definition", addedBy: held.addedBy });
      const removed = yield* repo.removeIfCurrent(project.id, version);
      yield* runtime.archive(removed);
      return {
        statusLine: `@${removed.spec.name} · definition removed · its volumes are kept`,
      };
    });

    const use = Effect.fn("Resources.use")(function* (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      mode: WorktreeChoice,
      clock: ReaderClock,
    ) {
      yield* decide(project, viewer, { kind: "use", changeOwner: yield* changeOwner(worktreeId) });
      const stored = yield* repo.setSelection(
        project.id,
        worktreeId,
        definitionId,
        mode,
        viewer.userId,
      );
      const listed = (yield* repo.listWithChoices(project.id, worktreeId)).find(
        (each) => each.definition.id === definitionId,
      );
      if (listed === undefined)
        return yield* new ResourceDefinitionNotFoundError({ id: definitionId });
      const shownOf = yield* viewsFor([listed], project.id, worktreeId, clock);
      return {
        definitionId,
        worktreeId,
        mode: stored.mode,
        chosenBy: stored.chosenBy,
        statusLine: resourceStatusLine(shownOf(listed).view, clock),
      } satisfies ResourceSelectionEntry;
    });

    /** The definition settings hold under `name`, and the worktree an act on it reaches. */
    const target = Effect.fn("Resources.target")(function* (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      worktreeId: WorktreeId | null,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      const definition = yield* repo.byName(project.id, name);
      if (definition === null) return yield* new ResourceNameNotFoundError({ name });
      if (definition.spec.scope === "worktree" && worktreeId === null) {
        return yield* new ResourceWorktreeNeededError({
          name,
          message: `@${name} runs one instance per worktree · name the worktree: --worktree <w>`,
        });
      }
      return definition;
    });

    /** A start's or stop's answer: the instance as it stands, read for the worktree acted in. */
    const controlled = (
      definition: StoredResourceDefinition,
      worktreeId: WorktreeId | null,
      seen: InstanceObserved,
      clock: ReaderClock,
    ) =>
      Effect.gen(function* () {
        const nameOf = yield* namesOf([definition.addedBy]);
        const reachedFrom = definition.spec.scope === "worktree" ? worktreeId : null;
        const shown = viewOf({
          definition,
          choice: "shared",
          worktreeId: reachedFrom,
          owns: new Map(),
          observation: null,
          lookup: () => seen,
          addedBy: nameOf(definition.addedBy),
        });
        return {
          instance: seen.instance.kind,
          statusLine: resourceStatusLine(shown.view, clock),
        } satisfies ResourceControlled;
      });

    const start = Effect.fn("Resources.start")(function* (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) {
      const definition = yield* target(project, viewer, name, worktreeId);
      return yield* controlled(
        definition,
        worktreeId,
        yield* runtime.start(definition, worktreeId),
        clock,
      );
    });

    const stop = Effect.fn("Resources.stop")(function* (
      project: ResourceProject,
      viewer: Viewer,
      name: string,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) {
      const definition = yield* target(project, viewer, name, worktreeId);
      const by = (yield* namesOf([viewer.userId]))(viewer.userId);
      return yield* controlled(
        definition,
        worktreeId,
        yield* runtime.stop(definition, worktreeId, by),
        clock,
      );
    });

    const env = Effect.fn("Resources.env")(function* (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      clock: ReaderClock,
    ) {
      yield* decide(project, viewer, { kind: "read" });
      const answer = yield* runtime.envOf(project.id, worktreeId);
      const definitions = yield* repo.listForProject(project.id);
      return {
        env: answer.env,
        exports: shellExports(answer.env),
        statusLines: answer.left.flatMap(({ resource, names }) => {
          const definition = definitions.find((each) => each.spec.name === resource);
          return definition === undefined
            ? []
            : [resourceStatusLine({ kind: "env-left", definition: definition.spec, names }, clock)];
        }),
      } satisfies ResourceEnvAnswer;
    });

    const forSession = Effect.fn("Resources.forSession")(function* (
      sessionId: SessionId,
      act: ResourceAct,
      clock: ReaderClock,
    ) {
      // The channel exists only for a session Mend holds, in a project it holds.
      const session = yield* sessions.byId(sessionId).pipe(Effect.orDie);
      const project = yield* projects.byId(session.projectId).pipe(Effect.orDie);
      if (act.kind !== "read") {
        return yield* new ResourceActRefusedError({ message: WORKSPACE_RESOURCE_REFUSAL });
      }
      // A workspace reads what its session's owner sees.
      const owner = session.ownerUserId;
      const membership = owner === null ? null : yield* organizations.membershipOf(owner);
      if (owner === null || membership === null) {
        return yield* new ResourceActRefusedError({
          message: "this session's owner is no longer a member of its organization",
        });
      }
      const viewer: Viewer = {
        userId: owner,
        organizationId: membership.organization.id,
        role: membership.role,
      };
      return statusOf(yield* list(project, viewer, session.worktreeId, clock));
    });

    return { list, add, remove, use, start, stop, env, forSession };
  }),
);

/** Serves `Resources.forSession` to every session's socket and channel while it is up. */
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
