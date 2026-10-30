import {
  type Adopted,
  type ApprovalTarget,
  type DefinitionWithApproval,
  type DefinitionVersion,
  ProjectsRepo,
  type ResourceApproval,
  type ResourceApprovalsByTarget,
  ResourceDefinitionNotFoundError,
  ResourceDefinitionRefusedError,
  type ResourceDefinitionStaleError,
  type ResourceSelectionRefusedError,
  ResourcesRepo,
  SessionsRepo,
  UsersRepo,
  WorktreesRepo,
} from "@mend/db";
import type {
  ProjectId,
  ResourceDefinitionId,
  ResourceProposalId,
  SessionId,
  WorktreeId,
} from "@mend/domain";
import {
  choicesFor,
  imageDigestOf,
  PRESET_VERSION_RULE,
  presetDefinition,
  withPresetCommand,
  PresetVersion,
  type ProjectTenancy,
  type ResourceAct,
  resourceActRefusal,
  type ResourceActor,
  type ResourceApprovalFor,
  type ResourceApprovalOffer,
  resourceApprovalRefusals,
  type ResourceApprovalRequest,
  type ResourceApprovalSource,
  type ResourceApproved,
  type ResourceDeclaration,
  type ResourceDeclaredApproval,
  type ResourceDefinitionInput,
  type ResourceFileRead,
  type ResourceApprovalOffers,
  type ResourceApprovals,
  type ResourceProposalEntry,
  type ResourceProposalInput,
  resourceProposalNotices,
  ResourceRefusal,
  type ResourceSelectionEntry,
  type ResourceSettingEntry,
  type ResourceSettingsState,
  type ResourcesPage,
  type ResourceSpecDigest,
  type ResourcesStatus,
  resourceSpecDigest,
  resourceStatusLine,
  type Viewer,
  type WorktreeChoice,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";
import { parse as parseToml, TomlError } from "smol-toml";

import { MEND_TOML } from "../recipes.ts";
import { readResourceProposals } from "../resource-proposals.ts";
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

export class ResourceProposalNotFoundError extends Schema.TaggedError<ResourceProposalNotFoundError>()(
  "ResourceProposalNotFoundError",
  { id: Schema.String },
) {}

/** What the approver read is not what is there now, so nothing was written. */
export class ResourceStaleReadError extends Schema.TaggedError<ResourceStaleReadError>()(
  "ResourceStaleReadError",
  { message: Schema.String },
) {}

/**
 * The image could not be pinned: `message` is the line, `@db · image postgres:17 · … · not
 * approved`, and `refusal` its `image` key with the clause after it.
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
    /**
     * Settings, proposals and, when `worktreeId` is set, that worktree's `mend.toml`, whose
     * worktree approvals the settings' lines then read (decision G4).
     */
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
    /** Changes are a person's; a workspace has no way to ask for one. */
    readonly propose: (
      project: ResourceProject,
      viewer: Viewer,
      input: ResourceProposalInput,
      clock: ReaderClock,
    ) => Effect.Effect<
      ResourceProposalEntry,
      ResourceActRefusedError | ResourceDefinitionRefusedError
    >;
    readonly withdraw: (
      project: ResourceProject,
      viewer: Viewer,
      id: ResourceProposalId,
    ) => Effect.Effect<
      { readonly statusLine: string },
      ResourceActRefusedError | ResourceProposalNotFoundError
    >;
    readonly remove: (
      project: ResourceProject,
      viewer: Viewer,
      version: DefinitionVersion,
    ) => Effect.Effect<
      { readonly statusLine: string },
      ResourceActRefusedError | ResourceDefinitionNotFoundError | ResourceDefinitionStaleError
    >;
    /**
     * Approves the spec the approver read, by its digest, adopting a proposal or a `mend.toml`
     * table into settings in the same write. The image is pinned here, before anything is written;
     * an approval already made for the spec and target is answered without asking a registry.
     */
    readonly approve: (
      project: ResourceProject,
      viewer: Viewer,
      request: ResourceApprovalRequest,
      clock: ReaderClock,
    ) => Effect.Effect<
      ResourceApproved,
      | ResourceActRefusedError
      | ResourceProposalNotFoundError
      | ResourceDefinitionNotFoundError
      | ResourceStaleReadError
      | ResourceDefinitionRefusedError
      | ResourceImageRefusedError
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
    statusLines: [...page.settings, ...page.proposals].map((entry) => entry.statusLine),
    file:
      file.kind === "read"
        ? {
            kind: "read",
            observed: file.observed,
            statusLines: file.proposals.map((proposal) => proposal.statusLine),
            notices: resourceProposalNotices(file),
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
 * What settings hold, as one read listed them: each definition by name, with its approvals, and
 * the state the approval rules decide against (`resourceApprovalRefusals`).
 */
interface SettingsRead {
  readonly byName: ReadonlyMap<string, DefinitionWithApproval>;
  readonly state: ResourceSettingsState;
}

/** `owning`: how many worktrees hold each definition as `own`, which a new scope or preset would strand. */
const settingsRead = (
  projectId: ProjectId,
  listed: ReadonlyArray<DefinitionWithApproval>,
  owning: ReadonlyMap<ResourceDefinitionId, number>,
): SettingsRead => ({
  byName: new Map(listed.map((each) => [each.definition.spec.name, each])),
  state: {
    projectId,
    definitions: listed.map(({ definition, approvals }) => ({
      spec: definition.spec,
      digest: definition.specDigest,
      projectImage: approvals.project === null ? null : imageDigestOf(approvals.project.spec.image),
      owning: owning.get(definition.id) ?? 0,
    })),
  },
});

const versionOf = ({ definition }: DefinitionWithApproval): DefinitionVersion => ({
  id: definition.id,
  digest: definition.specDigest,
});

/** Whether settings hold `spec` itself under its name. */
const sameAsSettings = (
  settings: SettingsRead,
  spec: ResourceDefinitionInput,
  digest: ResourceSpecDigest,
) => settings.byName.get(spec.name)?.definition.specDigest === digest;

const NO_APPROVALS: ResourceApprovalsByTarget = { project: null, worktree: null };

const listedApprovals = (approvals: ResourceApprovalsByTarget): ResourceApprovals => ({
  project: approvals.project === null ? null : { by: approvals.project.approvedBy },
  worktree: approvals.worktree === null ? null : { by: approvals.worktree.approvedBy },
});

/**
 * One listed item's approvals, and for each target the request its reader may post or why there
 * is none, decided in the approve route's order: whose act it is (`resourceActRefusal`), then the
 * rules (`resourceApprovalRefusals`), then an approval already made. The worktree's is the read
 * worktree's, when the resource is a worktree's (decision G4). An item settings hold with this
 * exact spec shares their approvals; adopting one over a different spec replaces it. `source`
 * names the item, given what settings held under its name when it was listed.
 */
const approvalsOf = (
  reader: PageReader,
  settings: SettingsRead,
  spec: ResourceDefinitionInput,
  digest: ResourceSpecDigest,
  source: (settings: DefinitionVersion | null) => ResourceApprovalSource,
): { readonly approvals: ResourceApprovals; readonly approve: ResourceApprovalOffers } => {
  const held = settings.byName.get(spec.name) ?? null;
  const same = held?.definition.specDigest === digest;
  const approvals = same ? held.approvals : NO_APPROVALS;
  const offer = (
    worktreeId: WorktreeId | null,
    approvalFor: ResourceApprovalFor,
    approved: ResourceApproval | null,
  ): ResourceApprovalOffer => {
    const denied = resourceActRefusal(reader.project, reader.actor, {
      kind: "approve",
      for: approvalFor,
      replaces: held !== null && !same,
    });
    if (denied !== null) return { kind: "denied", message: denied };
    const refusals = resourceApprovalRefusals(
      settings.state,
      spec,
      // The route answers 404 for a worktree that is not the project's before any page is read.
      worktreeId === null
        ? { kind: "project" }
        : { kind: "worktree", projectId: reader.project.id },
    );
    if (refusals.length > 0) return { kind: "rejected", refusals };
    if (approved !== null) return { kind: "approved" };
    return {
      kind: "ready",
      request: { source: source(held === null ? null : versionOf(held)), worktreeId },
    };
  };
  const { worktree } = reader;
  return {
    approvals: listedApprovals(approvals),
    approve: {
      project: offer(null, { kind: "project" }, approvals.project),
      worktree:
        worktree === null || spec.scope !== "worktree"
          ? null
          : offer(
              worktree.id,
              { kind: "worktree", changeOwner: worktree.changeOwner },
              approvals.worktree,
            ),
    },
  };
};

/** Whether the reader may choose how the read worktree uses `spec`; a worktree resource has no choice. */
const mayChoose = (reader: PageReader, spec: ResourceDefinitionInput) =>
  reader.worktree !== null &&
  choicesFor(spec).length > 0 &&
  allows(reader.project, reader.actor, { kind: "use", changeOwner: reader.worktree.changeOwner });

/** The approval a settings line names: the read worktree's own, else the project's. */
const lineApproval = (approvals: ResourceApprovalsByTarget) =>
  approvals.worktree ?? approvals.project;

const isPresetVersion = Schema.is(PresetVersion);

/** A preset proposal's definition, refused on `version` when the tag names no major. */
const presetSpec = (input: Extract<ResourceProposalInput, { readonly kind: "preset" }>) => {
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

/** An approval as a status line names it: whose, and whether for the project or a worktree. */
const declaredApproval = (
  approval: ResourceApproval | null,
  nameOf: (id: string) => string,
): ResourceDeclaredApproval | null =>
  approval === null
    ? null
    : {
        by: nameOf(approval.approvedBy),
        for: approval.worktreeId === null ? "project" : "worktree",
      };

/** What an approval pins, and the registry or mirror that answered for it (none for a worktree). */
interface Pin {
  readonly target: ApprovalTarget;
  readonly resolvedBy: string | null;
}

const changed = (name: string, what: string) =>
  new ResourceStaleReadError({
    message: `@${name} · ${what} changed since you read it · nothing was approved`,
  });

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

    /** Settings as they are now, listed for `worktreeId` (or the project alone, for null). */
    const settingsNow = (projectId: ProjectId, worktreeId: WorktreeId | null) =>
      Effect.all([repo.listWithApprovals(projectId, worktreeId), repo.ownSelections(projectId)], {
        concurrency: "unbounded",
      }).pipe(Effect.map(([listed, owning]) => settingsRead(projectId, listed, owning)));

    const proposalEntry = (
      reader: PageReader,
      settings: SettingsRead,
      proposal: {
        readonly id: ResourceProposalId;
        readonly spec: ResourceDefinitionInput;
        readonly specDigest: ResourceProposalEntry["digest"];
        readonly proposedBy: string;
      },
      by: string,
      clock: ReaderClock,
    ): ResourceProposalEntry => ({
      id: proposal.id,
      digest: proposal.specDigest,
      spec: proposal.spec,
      proposedBy: proposal.proposedBy,
      mine: reader.actor.kind === "person" && reader.actor.viewer.userId === proposal.proposedBy,
      canRemove: allows(reader.project, reader.actor, {
        kind: "remove-proposal",
        proposedBy: proposal.proposedBy,
      }),
      ...approvalsOf(reader, settings, proposal.spec, proposal.specDigest, (held) => ({
        kind: "proposal",
        id: proposal.id,
        digest: proposal.specDigest,
        settings: held,
      })),
      statusLine: line(
        proposal.spec,
        {
          kind: "proposal",
          by,
          sameAsSettings: sameAsSettings(settings, proposal.spec, proposal.specDigest),
        },
        clock,
      ),
    });

    const settingEntry = (
      reader: PageReader,
      settings: SettingsRead,
      listed: DefinitionWithApproval,
      nameOf: (id: string) => string,
      clock: ReaderClock,
    ): ResourceSettingEntry => {
      const { definition, approvals, choice } = listed;
      return {
        id: definition.id,
        digest: definition.specDigest,
        spec: definition.spec,
        ...approvalsOf(reader, settings, definition.spec, definition.specDigest, () => ({
          kind: "settings",
          ...versionOf(listed),
        })),
        choice,
        canRemove: allows(reader.project, reader.actor, { kind: "remove-definition" }),
        canChoose: mayChoose(reader, definition.spec),
        statusLine: line(
          definition.spec,
          {
            kind: "settings",
            approval: declaredApproval(lineApproval(approvals), nameOf),
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
      const declared = readResourceProposals(isRecord(parsed) ? parsed["resource"] : undefined);
      return {
        kind: "read",
        worktreeId,
        observed,
        proposals: declared.proposals.map((spec) => {
          const digest = resourceSpecDigest(spec);
          return {
            digest,
            spec,
            ...approvalsOf(reader, settings, spec, digest, (held) => ({
              kind: "file",
              worktreeId,
              name: spec.name,
              digest,
              settings: held,
            })),
            statusLine: line(
              spec,
              { kind: "file", sameAsSettings: sameAsSettings(settings, spec, digest) },
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
      const [owner, definitions, proposals, owning] = yield* Effect.all(
        [
          worktreeId === null || actor.kind === "workspace"
            ? Effect.succeed(null)
            : changeOwner(worktreeId),
          repo.listWithApprovals(project.id, worktreeId),
          repo.proposals(project.id),
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
      const nameOf = yield* namesOf([
        ...definitions.flatMap(({ approvals }) =>
          [approvals.project, approvals.worktree].flatMap((each) =>
            each === null ? [] : [each.approvedBy],
          ),
        ),
        ...proposals.map((proposal) => proposal.proposedBy),
      ]);
      const settings = settingsRead(project.id, definitions, owning);
      const file: ResourceFileRead =
        worktreeId === null
          ? { kind: "not-selected" }
          : yield* readFile(reader, settings, worktreeId, clock);
      return {
        settings: definitions.map((listed) =>
          settingEntry(reader, settings, listed, nameOf, clock),
        ),
        proposals: proposals.map((proposal) =>
          proposalEntry(reader, settings, proposal, nameOf(proposal.proposedBy), clock),
        ),
        file,
        canPropose: allows(project, actor, { kind: "propose" }),
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

    const propose = Effect.fn("Resources.propose")(function* (
      project: ResourceProject,
      viewer: Viewer,
      input: ResourceProposalInput,
      clock: ReaderClock,
    ) {
      const actor: ResourceActor = { kind: "person", viewer };
      yield* decide(project, actor, { kind: "propose" });
      const spec =
        input.kind === "preset" ? yield* presetSpec(input) : withPresetCommand(input.spec);
      const proposal = yield* repo.propose(project.id, spec, viewer.userId);
      const settings = yield* settingsNow(project.id, null);
      const nameOf = yield* namesOf([proposal.proposedBy]);
      return proposalEntry(
        { project, actor, worktree: null },
        settings,
        proposal,
        nameOf(proposal.proposedBy),
        clock,
      );
    });

    const withdraw = Effect.fn("Resources.withdraw")(function* (
      project: ResourceProject,
      viewer: Viewer,
      id: ResourceProposalId,
    ) {
      const proposal = yield* repo.proposalById(project.id, id);
      if (proposal === null) return yield* new ResourceProposalNotFoundError({ id });
      yield* decide(
        project,
        { kind: "person", viewer },
        { kind: "remove-proposal", proposedBy: proposal.proposedBy },
      );
      // Another removal may have taken it since it was read; that one said it was removed.
      if (!(yield* repo.withdrawProposal(project.id, id))) {
        return yield* new ResourceProposalNotFoundError({ id });
      }
      return { statusLine: `@${proposal.spec.name} · proposal removed` };
    });

    const remove = Effect.fn("Resources.remove")(function* (
      project: ResourceProject,
      viewer: Viewer,
      version: DefinitionVersion,
    ) {
      yield* decide(project, { kind: "person", viewer }, { kind: "remove-definition" });
      const removed = yield* repo.removeIfCurrent(project.id, version);
      return { statusLine: `@${removed.spec.name} · definition removed` };
    });

    /** The spec `source` names, while it is still what its digest says was read. */
    const sourceSpec = Effect.fn("Resources.sourceSpec")(function* (
      reader: PageReader,
      source: ResourceApprovalSource,
      clock: ReaderClock,
    ) {
      const { project } = reader;
      switch (source.kind) {
        case "settings": {
          const held = (yield* repo.listForProject(project.id)).find(
            (each) => each.id === source.id,
          );
          if (held === undefined)
            return yield* new ResourceDefinitionNotFoundError({ id: source.id });
          if (held.specDigest !== source.digest)
            return yield* changed(held.spec.name, "the definition");
          return held.spec;
        }
        case "proposal": {
          const proposal = yield* repo.proposalById(project.id, source.id);
          if (proposal === null) return yield* new ResourceProposalNotFoundError({ id: source.id });
          if (proposal.specDigest !== source.digest) {
            return yield* changed(proposal.spec.name, "the proposal");
          }
          return proposal.spec;
        }
        case "file": {
          const file = yield* readFile(
            reader,
            settingsRead(project.id, [], new Map()),
            source.worktreeId,
            clock,
          );
          const table =
            file.kind === "read"
              ? file.proposals.find((each) => each.spec.name === source.name)
              : undefined;
          if (table?.digest !== source.digest) return yield* changed(source.name, MEND_TOML);
          return table.spec;
        }
      }
    });

    /**
     * The approval's answer: the definition settings hold now, listed for the worktree it was
     * approved for (none for a project approval), and the image as it runs.
     */
    const approved = Effect.fn("Resources.approved")(function* (
      reader: PageReader,
      adopted: Pick<Adopted, "definition" | "approval">,
      resolvedBy: string | null,
      clock: ReaderClock,
    ) {
      const { id } = adopted.definition;
      const settings = yield* settingsNow(reader.project.id, reader.worktree?.id ?? null);
      const listed = [...settings.byName.values()].find((each) => each.definition.id === id);
      if (listed === undefined) return yield* new ResourceDefinitionNotFoundError({ id });
      const { approvals } = listed;
      const nameOf = yield* namesOf(
        [approvals.project, approvals.worktree].flatMap((each) =>
          each === null ? [] : [each.approvedBy],
        ),
      );
      return {
        definition: settingEntry(reader, settings, listed, nameOf, clock),
        image: adopted.approval.spec.image,
        resolvedBy,
      } satisfies ResourceApproved;
    });

    const approve = Effect.fn("Resources.approve")(function* (
      project: ResourceProject,
      viewer: Viewer,
      request: ResourceApprovalRequest,
      clock: ReaderClock,
    ) {
      const { source, worktreeId } = request;
      const reader: PageReader = {
        project,
        actor: { kind: "person", viewer },
        worktree:
          worktreeId === null
            ? null
            : { id: worktreeId, changeOwner: yield* changeOwner(worktreeId) },
      };
      const approvalFor: ResourceApprovalFor =
        reader.worktree === null
          ? { kind: "project" }
          : { kind: "worktree", changeOwner: reader.worktree.changeOwner };
      const settings: DefinitionVersion | null =
        source.kind === "settings" ? { id: source.id, digest: source.digest } : source.settings;
      yield* decide(
        project,
        { kind: "person", viewer },
        {
          kind: "approve",
          for: approvalFor,
          replaces: settings !== null && settings.digest !== source.digest,
        },
      );
      const spec = yield* sourceSpec(reader, source, clock);
      // Every refusal that needs no registry, from settings as the page reads them, comes before
      // one is asked; the repo decides them again under its locks.
      const refusals = resourceApprovalRefusals(
        (yield* settingsNow(project.id, null)).state,
        spec,
        worktreeId === null ? { kind: "project" } : { kind: "worktree", projectId: project.id },
      );
      if (refusals.length > 0) {
        return yield* new ResourceDefinitionRefusedError({ name: spec.name, refusals });
      }
      const settingsChanged = () => Effect.fail(changed(spec.name, "settings"));
      const lookup = { projectId: project.id, spec, settings, worktreeId };
      // An approval already made is the answer, and no registry is asked again.
      const found = yield* repo
        .approvalAsRead(lookup)
        .pipe(Effect.catchTag("ResourceSettingsStaleError", settingsChanged));
      if (found !== null) return yield* approved(reader, found, null, clock);
      // A worktree runs the image the project's approval of this spec pins (G4), so no registry
      // is asked for it, and a tag that moved since changes nothing.
      const pin: Pin =
        worktreeId !== null
          ? { target: { kind: "worktree", worktreeId }, resolvedBy: null }
          : yield* images.resolve(spec.image).pipe(
              Effect.mapError(
                (error: ImageResolutionError) =>
                  new ResourceImageRefusedError({
                    name: spec.name,
                    refusal: { key: "image", message: imageRefusalClause(error) },
                    reason: error.reason,
                    message: imageRefusalLine(spec.name, error),
                  }),
              ),
              Effect.map(
                (image): Pin => ({
                  target: { kind: "project", imageDigest: image.digest },
                  resolvedBy: image.resolvedBy,
                }),
              ),
            );
      const adopted = yield* repo
        .adoptAndApprove({
          projectId: project.id,
          spec,
          settings,
          target: pin.target,
          approvedBy: viewer.userId,
        })
        .pipe(
          Effect.catchTags({
            ResourceSettingsStaleError: settingsChanged,
            ResourceApprovalStaleError: () => Effect.fail(changed(spec.name, "the definition")),
          }),
        );
      return yield* approved(reader, adopted, adopted.made ? pin.resolvedBy : null, clock);
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
      const listed = (yield* repo.listWithApprovals(project.id, worktreeId)).find(
        (each) => each.definition.id === definitionId,
      );
      if (listed === undefined)
        return yield* new ResourceDefinitionNotFoundError({ id: definitionId });
      const approval = lineApproval(listed.approvals);
      const nameOf = yield* namesOf(approval === null ? [] : [approval.approvedBy]);
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
            approval: declaredApproval(approval, nameOf),
            choice: stored.selection.mode,
          },
          clock,
        ),
      } satisfies ResourceSelectionEntry;
    });

    return { list, forSession, propose, withdraw, remove, approve, use };
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
