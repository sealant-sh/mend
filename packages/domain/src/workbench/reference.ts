import { Schema } from "effect";

import { OrganizationId, ReferenceId, Sha } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * An upstream repository cloned into the store as read-only source material —
 * dependency sources the agent should read instead of guessing APIs (plan §17,
 * decided 2026-08-01). Not a project: no sessions, no worktrees, no adoption.
 * Each organization keeps its own list, managed by its owners; each project selects which of
 * its organization's references its sessions mount at `/workspace/ref/<name>`.
 */
export class Reference extends Schema.Class<Reference>("Reference")({
  id: ReferenceId,
  /** Short name, unique within the organization; also the mount directory name. */
  name: Schema.String,
  /** The organization that owns the reference (docs/adr/0003-organizations-and-tenancy.md). */
  organizationId: OrganizationId,
  /** The account that added it; null for references added before organizations. */
  createdByUserId: Schema.NullOr(Schema.String),
  /** Where the clone comes from — a remote URL or a local path. */
  originUrl: Schema.String,
  /**
   * Absolute path of the clone inside the store:
   * `<storeRoot>/_organizations/<organizationId>/references/<id>`, or
   * `<storeRoot>/_references/<name>` for references added before organizations.
   */
  path: Schema.String,
  /** Branch or tag the clone is held at; null = the remote's default branch. */
  pinnedRef: Schema.NullOr(Schema.String),
  /** HEAD of the clone as last observed — what sessions launched now would see. */
  headSha: Schema.NullOr(Sha),
  refreshedAt: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/**
 * What a session actually received: one reference as mounted at launch, with
 * the SHA observed then — the session record stays honest even after the
 * clone refreshes.
 */
export class SessionReferenceMount extends Schema.Class<SessionReferenceMount>(
  "SessionReferenceMount",
)({
  name: Schema.String,
  /** Container path the clone was mounted at, e.g. `/workspace/ref/effect`. */
  mountPath: Schema.String,
  sha: Schema.NullOr(Sha),
}) {}
