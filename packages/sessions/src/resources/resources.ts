import {
  type DefinitionVersion,
  ProjectsRepo,
  type ResourceDefinitionNotFoundError,
  ResourceDefinitionRefusedError,
  type ResourceDefinitionStaleError,
  ResourcesRepo,
  SessionsRepo,
  UsersRepo,
} from "@mend/db";
import type { ProjectId, ResourceProposalId, SessionId, WorktreeId } from "@mend/domain";
import {
  PRESET_VERSION_RULE,
  presetDefinition,
  withPresetCommand,
  PresetVersion,
  type ProjectTenancy,
  type ResourceAct,
  resourceActRefusal,
  type ResourceActor,
  type ResourceDeclaration,
  type ResourceDefinitionInput,
  type ResourceFileRead,
  type ResourceProposalEntry,
  type ResourceProposalInput,
  resourceProposalNotices,
  type ResourcesPage,
  type ResourceSpecDigest,
  type ResourcesStatus,
  resourceSpecDigest,
  resourceStatusLine,
  type Viewer,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";
import { parse as parseToml, TomlError } from "smol-toml";

import { MEND_TOML } from "../recipes.ts";
import { readResourceProposals } from "../resource-proposals.ts";
import { SessionChannelRegistry } from "../session-channel.ts";
import { stampLabel, WorktreeReads } from "../worktree-reads.ts";

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

export const ResourcesLive: Layer.Layer<
  Resources,
  never,
  ResourcesRepo | ProjectsRepo | SessionsRepo | UsersRepo | WorktreeReads
> = Layer.effect(
  Resources,
  Effect.gen(function* () {
    const repo = yield* ResourcesRepo;
    const projects = yield* ProjectsRepo;
    const sessions = yield* SessionsRepo;
    const users = yield* UsersRepo;
    const reads = yield* WorktreeReads;

    /** Display names by account id, in one query; an id with no account reads as itself. */
    const namesOf = (ids: ReadonlyArray<string>) =>
      users.byIds(ids).pipe(
        Effect.map((found) => {
          const names = new Map(found.map((user) => [user.id, user.name]));
          return (id: string) => names.get(id) ?? id;
        }),
      );

    const proposalEntry = (
      project: ResourceProject,
      actor: ResourceActor,
      proposal: {
        readonly id: ResourceProposalId;
        readonly spec: ResourceDefinitionInput;
        readonly specDigest: ResourceProposalEntry["digest"];
        readonly proposedBy: string;
      },
      by: string,
      sameAsSettings: boolean,
      clock: ReaderClock,
    ): ResourceProposalEntry => ({
      id: proposal.id,
      digest: proposal.specDigest,
      spec: proposal.spec,
      proposedBy: proposal.proposedBy,
      canRemove: allows(project, actor, {
        kind: "remove-proposal",
        proposedBy: proposal.proposedBy,
      }),
      statusLine: line(proposal.spec, { kind: "proposal", by, sameAsSettings }, clock),
    });

    const readFile = Effect.fn("Resources.readFile")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      sameAsSettings: (spec: ResourceDefinitionInput, digest: ResourceSpecDigest) => boolean,
      clock: ReaderClock,
    ) {
      const read = yield* reads
        .readFile(projectId, worktreeId, MEND_TOML, null, MEND_TOML_MAX_BYTES)
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
            statusLine: line(
              spec,
              { kind: "file", sameAsSettings: sameAsSettings(spec, digest) },
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
      const definitions = yield* repo.listWithApprovals(project.id, worktreeId);
      const proposals = yield* repo.proposals(project.id);
      const nameOf = yield* namesOf([
        ...definitions.flatMap(({ approval }) => (approval === null ? [] : [approval.approvedBy])),
        ...proposals.map((proposal) => proposal.proposedBy),
      ]);
      const held = new Map(
        definitions.map(({ definition }) => [definition.spec.name, definition.specDigest]),
      );
      const sameAsSettings = (spec: ResourceDefinitionInput, digest: ResourceSpecDigest) =>
        held.get(spec.name) === digest;
      const settings = definitions.map(({ definition, approval }) => ({
        id: definition.id,
        digest: definition.specDigest,
        spec: definition.spec,
        canRemove: allows(project, actor, { kind: "remove-definition" }),
        statusLine: line(
          definition.spec,
          {
            kind: "settings",
            approval:
              approval === null
                ? null
                : {
                    by: nameOf(approval.approvedBy),
                    for: approval.worktreeId === null ? "project" : "worktree",
                  },
          },
          clock,
        ),
      }));
      const file: ResourceFileRead =
        worktreeId === null
          ? { kind: "not-selected" }
          : yield* readFile(project.id, worktreeId, sameAsSettings, clock);
      return {
        settings,
        proposals: proposals.map((proposal) =>
          proposalEntry(
            project,
            actor,
            proposal,
            nameOf(proposal.proposedBy),
            sameAsSettings(proposal.spec, proposal.specDigest),
            clock,
          ),
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
      const held = yield* repo.byName(project.id, spec.name);
      const nameOf = yield* namesOf([proposal.proposedBy]);
      return proposalEntry(
        project,
        actor,
        proposal,
        nameOf(proposal.proposedBy),
        held?.specDigest === proposal.specDigest,
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

    return { list, forSession, propose, withdraw, remove };
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
