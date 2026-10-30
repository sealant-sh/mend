import { ProjectId } from "@mend/domain";
import { Session, Worktree, WorktreeName } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware, BudgetExceeded } from "./common.ts";
import { GIT_BUNDLE_CONTENT_TYPE } from "./landing.ts";
import { RemovalInProgress, StoreFailure } from "./workbench-views.ts";

/** What this server takes in one handoff, in bytes. */
export class HandoffTerms extends Schema.Class<HandoffTerms>("HandoffTerms")({
  /** The largest bundle the receive endpoint accepts. */
  bundleBytes: Schema.Int,
  /** The largest file the client carries; larger ones stay in the checkout, named. */
  fileBytes: Schema.Int,
}) {}

export const HANDOFF_REFUSALS = [
  "store-co-located",
  "unsupported-repository",
  "not-a-handoff",
  "damaged",
  "base-unknown",
  "base-off-default-branch",
] as const;

/** The server will not take this handoff; `message` says why, in words a person can act on. */
export class HandoffRefused extends Schema.TaggedError<HandoffRefused>()(
  "HandoffRefused",
  { reason: Schema.Literals(HANDOFF_REFUSALS), message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** `?harness=claude&hold=true`: the session's harness, and whether to hold it with no agent. */
export const HandoffQuery = {
  harness: Schema.String,
  hold: Schema.Literals(["true", "false"]),
};

/** The bundle: one ref, `refs/mend/handoff/snapshot`, cut at the merge base with the default branch. */
export const HandoffBundleBytes = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: GIT_BUNDLE_CONTENT_TYPE }),
);

export class HandoffReceived extends Schema.Class<HandoffReceived>("HandoffReceived")({
  session: Session,
  worktree: Worktree,
  commitsAhead: Schema.Int,
  /** The same bundle arrived before; this is the session it made then. */
  replayed: Schema.Boolean,
  /**
   * The caller's earlier handoff of the same local branch whose name this one could not take,
   * when there is one: `handed off as fix-login-2 · fix-login is your earlier handoff`. Null when
   * the name was free, or was taken by something else.
   */
  previous: Schema.NullOr(Schema.Struct({ name: WorktreeName })),
}) {}

export const handoffsGroup = HttpApiGroup.make("handoffs")
  .add(
    HttpApiEndpoint.get("instanceTerms", "/handoffs", {
      success: HandoffTerms,
      error: [HandoffRefused],
    }),
  )
  .add(
    HttpApiEndpoint.get("terms", "/projects/:id/handoffs", {
      params: { id: ProjectId },
      success: HandoffTerms,
      error: [NotFound, HandoffRefused],
    }),
  )
  .add(
    HttpApiEndpoint.post("receive", "/projects/:id/handoffs", {
      params: { id: ProjectId },
      query: HandoffQuery,
      payload: HandoffBundleBytes,
      success: HandoffReceived,
      error: [NotFound, HandoffRefused, BudgetExceeded, StoreFailure, RemovalInProgress],
    }),
  )
  .middleware(AuthMiddleware);
