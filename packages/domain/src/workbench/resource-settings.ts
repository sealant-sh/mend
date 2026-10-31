import { Schema } from "effect";

import { ResourceDefinitionId, ResourceProposalId, WorktreeId } from "../ids.ts";
import {
  ResourceDefinitionInput,
  ResourceName,
  ResourcePreset,
  ResourceRefusal,
  ResourceScope,
  ResourceSpecDigest,
  SelectionRevision,
  WorktreeChoice,
} from "./resource.ts";

/**
 * A project's resources as its settings page and `mend resource list` read them (ADR 0019): the
 * definitions settings hold, the proposals members made beside them, and the `[resource.*]`
 * proposals in one worktree's `mend.toml`. No source overwrites another, and every entry carries
 * its status line from `resourceStatusLine`.
 */

const isTimeZone = (value: string): boolean => {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

/** The reader's IANA zone, which clock times in a status line read in. */
export const ReaderTimeZone = Schema.String.check(
  Schema.makeFilter((value: string) =>
    isTimeZone(value) ? undefined : "an IANA time zone, such as Europe/Athens",
  ),
);

/** A preset at a version, which the server expands (`presetDefinition`), or a whole definition. */
export const ResourceProposalInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("preset"),
    name: ResourceName,
    preset: ResourcePreset,
    version: Schema.String.check(Schema.isMinLength(1)),
    scope: ResourceScope,
  }),
  Schema.Struct({ kind: Schema.Literal("definition"), spec: ResourceDefinitionInput }),
]);
export type ResourceProposalInput = typeof ResourceProposalInput.Type;

/** A definition settings hold, as its reader saw it: a write over it holds only while it still is. */
export const ResourceDefinitionVersion = Schema.Struct({
  id: ResourceDefinitionId,
  digest: ResourceSpecDigest,
});

/**
 * What an approver read and approves, by the digest they read: the definition settings hold, a
 * member's proposal, or one `[resource.*]` table in a worktree's `mend.toml`. Adopting a proposal
 * or a table names what settings held under its name when it was read (null for nothing), so it
 * never writes over a definition its approver did not see.
 */
export const ResourceApprovalSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("settings"),
    id: ResourceDefinitionId,
    digest: ResourceSpecDigest,
  }),
  Schema.Struct({
    kind: Schema.Literal("proposal"),
    id: ResourceProposalId,
    digest: ResourceSpecDigest,
    settings: Schema.NullOr(ResourceDefinitionVersion),
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    worktreeId: WorktreeId,
    name: ResourceName,
    digest: ResourceSpecDigest,
    settings: Schema.NullOr(ResourceDefinitionVersion),
  }),
]);
export type ResourceApprovalSource = typeof ResourceApprovalSource.Type;

export const ResourceApprovalRequest = Schema.Struct({
  source: ResourceApprovalSource,
  /** Null approves for the project; a worktree approves a worktree resource for it alone (G4). */
  worktreeId: Schema.NullOr(WorktreeId),
});
export type ResourceApprovalRequest = typeof ResourceApprovalRequest.Type;

/** One target's approval of the listed spec: the approver's account id. */
export const ResourceListedApproval = Schema.Struct({ by: Schema.String });
export type ResourceListedApproval = typeof ResourceListedApproval.Type;

/**
 * The listed spec's latest approval for each target: the project's, a manager's, and the read
 * worktree's own (decision G4), which is null when no worktree was read.
 */
export const ResourceApprovals = Schema.Struct({
  project: Schema.NullOr(ResourceListedApproval),
  worktree: Schema.NullOr(ResourceListedApproval),
});
export type ResourceApprovals = typeof ResourceApprovals.Type;

/**
 * One target's approval as its reader may ask for it: the request to post as it stands, built by
 * the server from what it listed, or why there is none. `denied`: the approval is not the
 * reader's, in `resourceActRefusal`'s words. `rejected`: each refusal the approve route would
 * answer, by key (`resourceApprovalRefusals`). `approved`: the target already approves this exact
 * spec. Only a registry's answer, a project's removal, and a change after the read can still
 * refuse a ready request.
 */
export const ResourceApprovalOffer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready"), request: ResourceApprovalRequest }),
  Schema.Struct({ kind: Schema.Literal("denied"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("rejected"), refusals: Schema.Array(ResourceRefusal) }),
  Schema.Struct({ kind: Schema.Literal("approved") }),
]);
export type ResourceApprovalOffer = typeof ResourceApprovalOffer.Type;

/**
 * Each target's offer. `worktree` is null when no worktree was read, or the resource is the
 * project's, which no worktree approves on its own.
 */
export const ResourceApprovalOffers = Schema.Struct({
  project: ResourceApprovalOffer,
  worktree: Schema.NullOr(ResourceApprovalOffer),
});
export type ResourceApprovalOffers = typeof ResourceApprovalOffers.Type;

export const ResourceSettingEntry = Schema.Struct({
  id: ResourceDefinitionId,
  /** What a removal sends back: it holds only while the definition still has this spec. */
  digest: ResourceSpecDigest,
  spec: ResourceDefinitionInput,
  approvals: ResourceApprovals,
  approve: ResourceApprovalOffers,
  /** The read worktree's stored choice; null when no worktree was read or it stored none. */
  choice: Schema.NullOr(WorktreeChoice),
  canRemove: Schema.Boolean,
  /** For the reader, choosing how the read worktree uses it; false when no worktree was read. */
  canChoose: Schema.Boolean,
  statusLine: Schema.String,
});
export type ResourceSettingEntry = typeof ResourceSettingEntry.Type;

export const ResourceProposalEntry = Schema.Struct({
  id: ResourceProposalId,
  digest: ResourceSpecDigest,
  spec: ResourceDefinitionInput,
  /** The proposer's account id; the status line names them. */
  proposedBy: Schema.String,
  /** Whether the reader proposed it: they withdraw it, where a manager removes another's. */
  mine: Schema.Boolean,
  canRemove: Schema.Boolean,
  /** Of the definition settings hold under its name, when that holds this exact spec. */
  approvals: ResourceApprovals,
  /** Each adopts it into settings and approves it for that target. */
  approve: ResourceApprovalOffers,
  statusLine: Schema.String,
});
export type ResourceProposalEntry = typeof ResourceProposalEntry.Type;

/**
 * A worktree's `mend.toml` as read: unavailable is never shown as an empty file. Bytes that were
 * read keep where they came from, whether they parsed or not.
 */
export const ResourceFileRead = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-selected") }),
  Schema.Struct({
    kind: Schema.Literal("absent"),
    worktreeId: WorktreeId,
    /** Where the bytes came from: `observed at capture 12 · seq 4,180`. */
    observed: Schema.String,
  }),
  /** No bytes: the read itself failed. */
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    worktreeId: WorktreeId,
    message: Schema.String,
  }),
  /** Bytes were read and are not a file Mend parses: too large, not text, or not TOML. */
  Schema.Struct({
    kind: Schema.Literal("unparsed"),
    worktreeId: WorktreeId,
    observed: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("read"),
    worktreeId: WorktreeId,
    observed: Schema.String,
    proposals: Schema.Array(
      Schema.Struct({
        digest: ResourceSpecDigest,
        spec: ResourceDefinitionInput,
        /** As on a member's proposal. */
        approvals: ResourceApprovals,
        approve: ResourceApprovalOffers,
        statusLine: Schema.String,
      }),
    ),
    /** Keyed in full (`resource.queue.ports.amqp`). */
    refused: Schema.Array(ResourceRefusal),
    ignored: Schema.Array(Schema.Struct({ key: Schema.String })),
  }),
]);
export type ResourceFileRead = typeof ResourceFileRead.Type;

export const ResourcesPage = Schema.Struct({
  settings: Schema.Array(ResourceSettingEntry),
  proposals: Schema.Array(ResourceProposalEntry),
  file: ResourceFileRead,
  canPropose: Schema.Boolean,
});
export type ResourcesPage = typeof ResourcesPage.Type;

/**
 * What a workspace reads of its project's resources (ADR 0019, "Read status"): each status line
 * and its file's diagnostics. No spec, env value, account id or digest.
 */
export interface ResourcesStatus {
  readonly statusLines: ReadonlyArray<string>;
  readonly file:
    | { readonly kind: "not-selected" }
    | { readonly kind: "absent"; readonly observed: string }
    | { readonly kind: "unavailable"; readonly message: string }
    | { readonly kind: "unparsed"; readonly observed: string; readonly message: string }
    | {
        readonly kind: "read";
        readonly observed: string;
        readonly statusLines: ReadonlyArray<string>;
        /** `resourceTableNotices`: each refused or ignored key, one line each. */
        readonly notices: ReadonlyArray<string>;
      };
}

export const ResourceApproved = Schema.Struct({
  definition: ResourceSettingEntry,
  /** The image as it runs, pinned to the digest it resolved to: `postgres:17@sha256:…`. */
  image: Schema.String,
  /** The registry or mirror that answered; null when nothing was asked, as for an image pinned already. */
  resolvedBy: Schema.NullOr(Schema.String),
});
export type ResourceApproved = typeof ResourceApproved.Type;

export const ResourceUseRequest = Schema.Struct({ mode: WorktreeChoice });

/** A worktree's choice, as the write that made it stored it. */
export const ResourceSelectionEntry = Schema.Struct({
  definitionId: ResourceDefinitionId,
  worktreeId: WorktreeId,
  mode: WorktreeChoice,
  revision: SelectionRevision,
  chosenBy: Schema.NullOr(Schema.String),
  statusLine: Schema.String,
});
export type ResourceSelectionEntry = typeof ResourceSelectionEntry.Type;
