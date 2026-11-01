import { Schema } from "effect";

import { ResourceDefinitionId, WorktreeId } from "../ids.ts";
import {
  ResourceDefinitionInput,
  ResourceName,
  ResourcePreset,
  ResourceRefusal,
  ResourceScope,
  ResourceSpecDigest,
  WorktreeChoice,
} from "./resource.ts";

/**
 * A project's resources as its settings page and `mend resource list` read them (ADR 0019): the
 * definitions settings hold, and the `[resource.*]` tables in one worktree's `mend.toml`, which a
 * person adds to settings. The file never overwrites settings by itself, and every entry carries
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
export const ResourceAddInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("preset"),
    name: ResourceName,
    preset: ResourcePreset,
    version: Schema.String.check(Schema.isMinLength(1)),
    scope: ResourceScope,
  }),
  Schema.Struct({ kind: Schema.Literal("definition"), spec: ResourceDefinitionInput }),
]);
export type ResourceAddInput = typeof ResourceAddInput.Type;

/**
 * Whether the reader may add a `mend.toml` table to settings as it stands, or why not. `denied`:
 * the add is not the reader's, in `resourceActRefusal`'s words. `rejected`: each refusal the add
 * route would answer, by key (`resourceDeclarationRefusals`). `added`: settings hold this exact
 * spec. Only a registry's answer, a project's removal, and a change after the read can still
 * refuse a ready add.
 */
export const ResourceAddOffer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("denied"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("rejected"), refusals: Schema.Array(ResourceRefusal) }),
  Schema.Struct({ kind: Schema.Literal("added") }),
]);
export type ResourceAddOffer = typeof ResourceAddOffer.Type;

/** The kind of a `ResourceInstanceObservation`, or `none` when the read reaches no one instance. */
export const ResourceInstanceKind = Schema.Literals([
  "none",
  "not-started",
  "starting",
  "running",
  "stopped",
  "exited",
  "failed",
  "unsupported",
  "not-observed",
]);
export type ResourceInstanceKind = typeof ResourceInstanceKind.Type;

export const ResourceSettingEntry = Schema.Struct({
  id: ResourceDefinitionId,
  /** What a removal sends back: it holds only while the definition still has this spec. */
  digest: ResourceSpecDigest,
  spec: ResourceDefinitionInput,
  /** The image as it runs, pinned to the digest it resolved to when it was added. */
  image: Schema.String,
  /** The account id of whoever added it last; the status line names them. */
  addedBy: Schema.String,
  /** The read worktree's stored choice; null when no worktree was read or it stored none. */
  choice: Schema.NullOr(WorktreeChoice),
  canRemove: Schema.Boolean,
  /** For the reader, choosing how the read worktree uses it; false when no worktree was read. */
  canChoose: Schema.Boolean,
  /**
   * What Sealant last observed of the instance the read reaches: `none` for a worktree resource
   * read for no worktree, or one the worktree has off.
   */
  instance: ResourceInstanceKind,
  statusLine: Schema.String,
});
export type ResourceSettingEntry = typeof ResourceSettingEntry.Type;

/** One `[resource.*]` table as read, and whether its reader may add it to settings. */
export const ResourceFileTable = Schema.Struct({
  digest: ResourceSpecDigest,
  spec: ResourceDefinitionInput,
  add: ResourceAddOffer,
  statusLine: Schema.String,
});
export type ResourceFileTable = typeof ResourceFileTable.Type;

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
    tables: Schema.Array(ResourceFileTable),
    /** Keyed in full (`resource.queue.ports.amqp`). */
    refused: Schema.Array(ResourceRefusal),
    ignored: Schema.Array(Schema.Struct({ key: Schema.String })),
  }),
]);
export type ResourceFileRead = typeof ResourceFileRead.Type;

export const ResourcesPage = Schema.Struct({
  settings: Schema.Array(ResourceSettingEntry),
  file: ResourceFileRead,
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

export const ResourceAdded = Schema.Struct({
  definition: ResourceSettingEntry,
  /**
   * The registry or mirror that answered for the image's digest; null when nothing was asked, as
   * for an image pinned already or a definition that did not change.
   */
  resolvedBy: Schema.NullOr(Schema.String),
});
export type ResourceAdded = typeof ResourceAdded.Type;

export const ResourceUseRequest = Schema.Struct({ mode: WorktreeChoice });

/** A worktree's choice, as the write that made it stored it. */
export const ResourceSelectionEntry = Schema.Struct({
  definitionId: ResourceDefinitionId,
  worktreeId: WorktreeId,
  mode: WorktreeChoice,
  chosenBy: Schema.NullOr(Schema.String),
  statusLine: Schema.String,
});
export type ResourceSelectionEntry = typeof ResourceSelectionEntry.Type;
