import { Schema } from "effect";

import { ResourceDefinitionId, ResourceProposalId, WorktreeId } from "../ids.ts";
import {
  ResourceDefinitionInput,
  ResourceName,
  ResourcePreset,
  ResourceRefusal,
  ResourceScope,
  ResourceSpecDigest,
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

export const ResourceSettingEntry = Schema.Struct({
  id: ResourceDefinitionId,
  /** What a removal sends back: it holds only while the definition still has this spec. */
  digest: ResourceSpecDigest,
  spec: ResourceDefinitionInput,
  canRemove: Schema.Boolean,
  statusLine: Schema.String,
});
export type ResourceSettingEntry = typeof ResourceSettingEntry.Type;

export const ResourceProposalEntry = Schema.Struct({
  id: ResourceProposalId,
  digest: ResourceSpecDigest,
  spec: ResourceDefinitionInput,
  /** The proposer's account id; the status line names them. */
  proposedBy: Schema.String,
  canRemove: Schema.Boolean,
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
        /** `resourceProposalNotices`: each refused or ignored key, one line each. */
        readonly notices: ReadonlyArray<string>;
      };
}
