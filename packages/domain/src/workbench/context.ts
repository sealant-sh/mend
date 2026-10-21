import { Schema } from "effect";

import { ContextSnapshotId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/** One explicit source of information supplied to a session (plan §5.3). */
export const ContextItemKind = Schema.Literals(["file", "document", "note", "url", "summary"]);
export type ContextItemKind = typeof ContextItemKind.Type;

export class ContextItem extends Schema.Class<ContextItem>("ContextItem")({
  kind: ContextItemKind,
  /** Path, URL, or session summary id — whatever addresses the item for its kind. */
  ref: Schema.String,
  /** Content digest at snapshot time, when computable; provenance, not access control. */
  digest: Schema.NullOr(Schema.String),
}) {}

/**
 * The immutable manifest of exactly what a session received (plan §5.4/§7.1).
 * Packs are editable; snapshots never are — the review can always show the
 * exact context a session started with.
 */
export class ContextSnapshot extends Schema.Class<ContextSnapshot>("ContextSnapshot")({
  id: ContextSnapshotId,
  /** The pack this was snapshotted from, if any ("workspace-reaper @3"). */
  packName: Schema.NullOr(Schema.String),
  items: Schema.Array(ContextItem),
  createdAt: Timestamp,
}) {}
