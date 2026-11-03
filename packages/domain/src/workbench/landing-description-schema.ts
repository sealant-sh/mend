import { Schema } from "effect";

import { ProofArtifactId } from "../ids.ts";

// The pull request media Schemas; `./landing-description.ts` holds the rules that render a
// description, free of Effect, and re-exports these.

/** A selected capture and its destination-specific delivery reference. */
export const PullRequestMediaItem = Schema.Struct({
  artifactId: ProofArtifactId,
  createdAt: Schema.optionalKey(Schema.String),
  label: Schema.String,
  kind: Schema.Literals(["screenshot", "video"]),
  checkpointOrdinal: Schema.NullOr(Schema.Int),
  ref: Schema.Union([
    Schema.Struct({ url: Schema.String }),
    Schema.Struct({ path: Schema.String }),
    Schema.Struct({ missing: Schema.String }),
  ]),
});
export type PullRequestMediaItem = typeof PullRequestMediaItem.Type;

/** Media delivery is independent of whether the branch and pull request were published. */
export const PullRequestMediaReport = Schema.Struct({
  delivered: Schema.Int,
  reused: Schema.Int,
  failed: Schema.Array(Schema.Struct({ artifactId: Schema.String, reason: Schema.String })),
  unavailable: Schema.optionalKey(Schema.String),
});
export type PullRequestMediaReport = typeof PullRequestMediaReport.Type;
