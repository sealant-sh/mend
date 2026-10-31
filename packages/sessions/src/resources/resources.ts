import {
  type DefinitionVersion,
  type DefinitionWithChoice,
  ProjectsRepo,
  ResourceDefinitionNotFoundError,
  ResourceDefinitionRefusedError,
  type ResourceDefinitionStaleError,
  type ResourceSelectionRefusedError,
  ResourcesRepo,
  SessionsRepo,
  UsersRepo,
  WorktreesRepo,
} from "@mend/db";
import type { ProjectId, ResourceDefinitionId, SessionId, WorktreeId } from "@mend/domain";
import {
  choicesFor,
  PRESET_VERSION_RULE,
  presetDefinition,
  PresetVersion,
  type ProjectTenancy,
  type ResourceAct,
  resourceActRefusal,
  type ResourceActor,
  type ResourceAddInput,
  type ResourceAddOffer,
  type ResourceAdded,
  type ResourceDeclaration,
  resourceDeclarationRefusals,
  type ResourceDefinitionInput,
  type ResourceFileRead,
  type ResourceFileTable,
  ResourceRefusal,
  type ResourceSelectionEntry,
  type ResourceSettingEntry,
  type ResourceSettingsState,
  type ResourcesPage,
  type ResourceSpecDigest,
  type ResourcesStatus,
  resourceSpecDigest,
  resourceStatusLine,
  resourceTableNotices,
  type Viewer,
  type WorktreeChoice,
  withPresetCommand,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";
import { parse as parseToml, TomlError } from "smol-toml";

import { MEND_TOML } from "../recipes.ts";
import { readResourceTables } from "../resource-tables.ts";
import { SessionChannelRegistry } from "../session-channel.ts";
import { stampLabel, WorktreeReads } from "../worktree-reads.ts";
import {
  ImageFailureReason,
  imageRefusalClause,
  imageRefusalLine,
  type ImageResolutionError,
  ResourceImageResolver,
} from "./image-resolver.ts";

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

/** A reader's clock, for the status lines a reply carries. */
export interface ReaderClock {
  readonly now: Date;
  readonly timeZone: string;
}

/**
 * The one owner of a project's resources (ADR 0019, "One module owns it"). Callers hand it an
 * authenticated actor and a project they resolved; every act passes `resourceActRefusal` here.
 */
export class Resources extends Context.Service<
  Resources,
  {
    /** Settings and, when `worktreeId` is set, that worktree's choices and its `mend.toml`. */
    readonly list: (
      project: ResourceProject,
      actor: ResourceActor,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) => Effect.Effect<ResourcesPage, ResourceActRefusedError>;
    /**
     * A request through a session's own socket or channel, decided as the workspace's: a read
     * answers its project's status lines and its worktree's file, never a spec; any change is
     * refused.
     */
    readonly forSession: (
      sessionId: SessionId,
      act: ResourceAct,
      clock: ReaderClock,
    ) => Effect.Effect<ResourcesStatus, ResourceActRefusedError>;
    /**
     * Adds the definition `input` names to settings, or replaces the one they hold under its
     * name, and it is the project's. The image is pinned here, before anything is written. The
     * same spec added by someone who may not replace it is answered as settings hold it, and no
     * registry is asked. Changes are a person's; a workspace has no way to ask for one.
     */
    readonly add: (
      project: ResourceProject,
      viewer: Viewer,
      input: ResourceAddInput,
      clock: ReaderClock,
    ) => Effect.Effect<
      ResourceAdded,
      ResourceActRefusedError | ResourceDefinitionRefusedError | ResourceImageRefusedError
    >;
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
  }
>()("@mend/sessions/Resources") {}

/** A `mend.toml` larger than this is reported unread, never cut. */
const MEND_TOML_MAX_BYTES = 256 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Why `mend.toml` does not parse, by position and the parser's reason alone. The parser's own
 * message quotes the lines around the error, which can hold env values, and a workspace reads
 * this text.
 */
const tomlDiagnostic = (cause: unknown): string => {
  if (!(cause instanceof TomlError)) return `${MEND_TOML} is not valid TOML`;
  const reason = cause.message.replace(/^Invalid TOML document: /, "").split("\n", 1)[0];
  return `${MEND_TOML} is not valid TOML: line ${cause.line}, column ${cause.column} · ${reason}`;
};

const line = (
  definition: ResourceDefinitionInput,
  source: ResourceDeclaration,
  clock: ReaderClock,
) => resourceStatusLine({ kind: "declared", definition, source }, clock);

const decide = (project: ResourceProject, actor: ResourceActor, act: ResourceAct) => {
  const refusal = resourceActRefusal(project, actor, act);
  return refusal === null
    ? Effect.void
    : Effect.fail(new ResourceActRefusedError({ message: refusal }));
};

const WORKSPACE: ResourceActor = { kind: "workspace" };

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

const allows = (project: ResourceProject, actor: ResourceActor, act: ResourceAct) =>
  resourceActRefusal(project, actor, act) === null;

/**
 * Who reads a page, and the worktree it is read for with that worktree's change owner: what every
 * flag on it is decided for, by the same `resourceActRefusal` the acts pass.
 */
interface PageReader {
  readonly project: ResourceProject;
  readonly actor: ResourceActor;
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
  const denied = resourceActRefusal(reader.project, reader.actor, {
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
  allows(reader.project, reader.actor, { kind: "use", changeOwner: reader.worktree.changeOwner });

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

export const ResourcesLive: Layer.Layer<
  Resources,
  never,
  | ResourcesRepo
  | ProjectsRepo
  | SessionsRepo
  | UsersRepo
  | WorktreesRepo
  | WorktreeReads
  | ResourceImageResolver
> = Layer.effect(
  Resources,
  Effect.gen(function* () {
    const repo = yield* ResourcesRepo;
    const projects = yield* ProjectsRepo;
    const sessions = yield* SessionsRepo;
    const users = yield* UsersRepo;
    const worktrees = yield* WorktreesRepo;
    const reads = yield* WorktreeReads;
    const images = yield* ResourceImageResolver;

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
      nameOf: (id: string) => string,
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
        canRemove: allows(reader.project, reader.actor, {
          kind: "remove-definition",
          addedBy: definition.addedBy,
        }),
        canChoose: mayChoose(reader, definition.spec),
        statusLine: line(
          definition.spec,
          {
            kind: "settings",
            addedBy: nameOf(definition.addedBy),
            ...(choice === null ? {} : { choice }),
          },
          clock,
        ),
      };
    };

    const readFile = Effect.fn("Resources.readFile")(function* (
      reader: PageReader,
      settings: SettingsRead,
      worktreeId: WorktreeId,
      clock: ReaderClock,
    ) {
      const read = yield* reads
        .readFile(reader.project.id, worktreeId, MEND_TOML, null, MEND_TOML_MAX_BYTES)
        .pipe(Effect.result);
      if (read._tag === "Failure") {
        return {
          kind: "unavailable",
          worktreeId,
          message: `${MEND_TOML} could not be read`,
        } satisfies ResourceFileRead;
      }
      const { value: file, stamp } = read.success;
      const observed = stampLabel(stamp);
      if (file === null) return { kind: "absent", worktreeId, observed } satisfies ResourceFileRead;
      const unparsed = (message: string): ResourceFileRead => ({
        kind: "unparsed",
        worktreeId,
        observed,
        message,
      });
      if (file.truncated) {
        return unparsed(`${MEND_TOML} is over ${MEND_TOML_MAX_BYTES / 1024} KiB · not read`);
      }
      if (file.binary) return unparsed(`${MEND_TOML} is not text · not read`);
      let parsed: unknown;
      try {
        parsed = parseToml(new TextDecoder().decode(file.bytes));
      } catch (cause) {
        return unparsed(tomlDiagnostic(cause));
      }
      const declared = readResourceTables(isRecord(parsed) ? parsed["resource"] : undefined);
      return {
        kind: "read",
        worktreeId,
        observed,
        tables: declared.tables.map((spec): ResourceFileTable => {
          const digest = resourceSpecDigest(spec);
          return {
            digest,
            spec,
            add: addOffer(reader, settings, spec, digest),
            statusLine: line(
              spec,
              { kind: "file", settings: againstSettings(settings, spec, digest) },
              clock,
            ),
          };
        }),
        refused: declared.refused,
        ignored: declared.ignored,
      } satisfies ResourceFileRead;
    });

    const list = Effect.fn("Resources.list")(function* (
      project: ResourceProject,
      actor: ResourceActor,
      worktreeId: WorktreeId | null,
      clock: ReaderClock,
    ) {
      yield* decide(project, actor, { kind: "read" });
      // A workspace's flags are never read (`statusOf`), so it costs no change-owner query.
      const [owner, definitions, owning] = yield* Effect.all(
        [
          worktreeId === null || actor.kind === "workspace"
            ? Effect.succeed(null)
            : changeOwner(worktreeId),
          repo.listWithChoices(project.id, worktreeId),
          actor.kind === "workspace"
            ? Effect.succeed(new Map<ResourceDefinitionId, number>())
            : repo.ownSelections(project.id),
        ],
        { concurrency: "unbounded" },
      );
      const reader: PageReader = {
        project,
        actor,
        worktree: worktreeId === null ? null : { id: worktreeId, changeOwner: owner },
      };
      const nameOf = yield* namesOf(definitions.map(({ definition }) => definition.addedBy));
      const settings = settingsRead(project.id, definitions, owning);
      const file: ResourceFileRead =
        worktreeId === null
          ? { kind: "not-selected" }
          : yield* readFile(reader, settings, worktreeId, clock);
      return {
        settings: definitions.map((listed) => settingEntry(reader, listed, nameOf, clock)),
        file,
      } satisfies ResourcesPage;
    });

    const forSession = Effect.fn("Resources.forSession")(function* (
      sessionId: SessionId,
      act: ResourceAct,
      clock: ReaderClock,
    ) {
      // The channel exists only for a session Mend holds, in a project it holds.
      const session = yield* sessions.byId(sessionId).pipe(Effect.orDie);
      const project = yield* projects.byId(session.projectId).pipe(Effect.orDie);
      yield* decide(project, WORKSPACE, act);
      return statusOf(yield* list(project, WORKSPACE, session.worktreeId, clock));
    });

    const add = Effect.fn("Resources.add")(function* (
      project: ResourceProject,
      viewer: Viewer,
      input: ResourceAddInput,
      clock: ReaderClock,
    ) {
      const actor: ResourceActor = { kind: "person", viewer };
      yield* decide(project, actor, { kind: "read" });
      const spec =
        input.kind === "preset" ? yield* presetSpec(input) : withPresetCommand(input.spec);
      const [listed, owning] = yield* Effect.all(
        [repo.listWithChoices(project.id, null), repo.ownSelections(project.id)],
        { concurrency: "unbounded" },
      );
      const settings = settingsRead(project.id, listed, owning);
      const held = settings.byName.get(spec.name)?.definition ?? null;
      const answer = (definition: DefinitionWithChoice["definition"], resolvedBy: string | null) =>
        namesOf([definition.addedBy]).pipe(
          Effect.map(
            (nameOf): ResourceAdded => ({
              definition: settingEntry(
                { project, actor, worktree: null },
                { definition, choice: null },
                nameOf,
                clock,
              ),
              resolvedBy,
            }),
          ),
        );
      const replacing = resourceActRefusal(project, actor, {
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
      const actor: ResourceActor = { kind: "person", viewer };
      yield* decide(project, actor, { kind: "read" });
      const held = (yield* repo.listForProject(project.id)).find((each) => each.id === version.id);
      if (held === undefined) return yield* new ResourceDefinitionNotFoundError({ id: version.id });
      yield* decide(project, actor, { kind: "remove-definition", addedBy: held.addedBy });
      const removed = yield* repo.removeIfCurrent(project.id, version);
      return { statusLine: `@${removed.spec.name} · definition removed` };
    });

    const use = Effect.fn("Resources.use")(function* (
      project: ResourceProject,
      viewer: Viewer,
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      mode: WorktreeChoice,
      clock: ReaderClock,
    ) {
      yield* decide(
        project,
        { kind: "person", viewer },
        { kind: "use", changeOwner: yield* changeOwner(worktreeId) },
      );
      const stored = yield* repo.setSelection(
        project.id,
        worktreeId,
        definitionId,
        { mode },
        viewer.userId,
      );
      const listed = (yield* repo.listWithChoices(project.id, worktreeId)).find(
        (each) => each.definition.id === definitionId,
      );
      if (listed === undefined)
        return yield* new ResourceDefinitionNotFoundError({ id: definitionId });
      const nameOf = yield* namesOf([listed.definition.addedBy]);
      return {
        definitionId,
        worktreeId,
        mode: stored.selection.mode,
        revision: stored.selection.revision,
        chosenBy: stored.chosenBy,
        statusLine: line(
          listed.definition.spec,
          {
            kind: "settings",
            addedBy: nameOf(listed.definition.addedBy),
            choice: stored.selection.mode,
          },
          clock,
        ),
      } satisfies ResourceSelectionEntry;
    });

    return { list, forSession, add, remove, use };
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
