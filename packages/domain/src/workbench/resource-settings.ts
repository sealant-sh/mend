import { Schema } from "effect";

import { ResourceDefinitionId, WorktreeId } from "../ids.ts";
import {
  ResourceDefinition,
  ResourceRefusal,
  ResourceLevel,
  ResourceSpecDigest,
  WorktreeChoice,
} from "./resource.ts";

/**
 * Remembered instances and a selected worktree's file definitions, with the shared status line.
 * File definitions become remembered specs only when a person explicitly starts them.
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

/** Whether a person's Start or Stop does something for an instance observed so. */
export const resourceControls = (
  kind: ResourceInstanceKind,
): { readonly start: boolean; readonly stop: boolean } => ({
  start: ["not-started", "stopped", "exited", "failed"].includes(kind),
  stop: ["starting", "running", "exited"].includes(kind),
});

export const ResourceSettingEntry = Schema.Struct({
  id: ResourceDefinitionId,
  /** What a removal sends back: it holds only while the definition still has this spec. */
  digest: ResourceSpecDigest,
  spec: ResourceDefinition,
  level: ResourceLevel,
  worktreeId: Schema.NullOr(WorktreeId),
  /** The image as it runs, pinned to the digest it resolved to when it was added. */
  image: Schema.String,
  /** The account id of whoever added it last; the status line names them. */
  addedBy: Schema.String,
  /** The read worktree's stored choice; null when no worktree was read or it stored none. */
  choice: Schema.NullOr(WorktreeChoice),
  canRemove: Schema.Boolean,
  /** For the reader, choosing how the read worktree uses it; false when no worktree was read. */
  canChoose: Schema.Boolean,
  /** The reader owns the selected worktree and may replace its own database. */
  canLoadOwn: Schema.Boolean,
  /**
   * What Sealant last observed of the instance the read reaches, which the Start and Stop
   * controls follow: `none` for a worktree resource read for no worktree, or one the worktree has
   * off.
   */
  instance: ResourceInstanceKind,
  statusLine: Schema.String,
});
export type ResourceSettingEntry = typeof ResourceSettingEntry.Type;

/** One file definition available to an explicit start. */
export const ResourceFileTable = Schema.Struct({
  digest: ResourceSpecDigest,
  spec: ResourceDefinition,
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

/** What a request from a session answers: its lines, as the helper prints them. */
export interface ResourceSessionAnswer {
  readonly lines: ReadonlyArray<string>;
}

export const ResourceUseRequest = Schema.Struct({ mode: WorktreeChoice });

/** A worktree's choice, as the write that made it stored it. */
export const ResourceSelectionEntry = Schema.Struct({
  definitionId: ResourceDefinitionId,
  worktreeId: WorktreeId,
  mode: WorktreeChoice,
  chosenBy: Schema.NullOr(Schema.String),
  statusLine: Schema.String,
  message: Schema.NullOr(Schema.String),
});
export type ResourceSelectionEntry = typeof ResourceSelectionEntry.Type;

/** A person's Start or Stop, answered with the instance's line as it stands after. */
export const ResourceControlled = Schema.Struct({
  instance: ResourceInstanceKind,
  statusLine: Schema.String,
  message: Schema.NullOr(Schema.String),
});
export type ResourceControlled = typeof ResourceControlled.Type;

/** What every process in a worktree is told of its resources now: the env, and lines about it. */
export const ResourceEnvAnswer = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.String),
  /** `export NAME='value'`, one per name, as `mend resource env` prints them. */
  exports: Schema.Array(Schema.String),
  /** Names left as the project sets them, as status lines. */
  statusLines: Schema.Array(Schema.String),
});
export type ResourceEnvAnswer = typeof ResourceEnvAnswer.Type;

/** An explicit start names its level and reads one worktree's current definition. */
export const ResourceStartOptions = Schema.Struct({
  level: ResourceLevel,
  worktreeId: WorktreeId,
  restart: Schema.Boolean,
});
export type ResourceStartOptions = typeof ResourceStartOptions.Type;
/** Stop defaults to the level this worktree currently uses. */
export const ResourceStopOptions = Schema.Struct({
  level: Schema.optional(ResourceLevel),
  worktreeId: WorktreeId,
});
export type ResourceStopOptions = typeof ResourceStopOptions.Type;
/** A start either observed an instance or asks explicitly to replace its remembered definition. */
export const ResourceStarted = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("started"), ...ResourceControlled.fields }),
  Schema.Struct({
    kind: Schema.Literal("needs-restart"),
    statusLine: Schema.String,
    hint: Schema.String,
    worktrees: Schema.Array(Schema.Struct({ id: WorktreeId, name: Schema.String })),
  }),
]);
export type ResourceStarted = typeof ResourceStarted.Type;
