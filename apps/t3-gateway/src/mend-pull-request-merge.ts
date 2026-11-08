import * as Schema from "effect/Schema";

/** The caller's fresh GitHub merge authorization, read from Mend's public API. */
export const MendPullRequestMergeAccess = Schema.Struct({
  viewer: Schema.String,
  canMerge: Schema.Boolean,
  mergeMethods: Schema.Array(Schema.Literals(["merge", "squash", "rebase"])),
});
export type MendPullRequestMergeAccess = typeof MendPullRequestMergeAccess.Type;

/** One explicit merge; Mend rechecks the connected person's GitHub rights. */
export interface MendPullRequestMergeInput {
  readonly repository: string;
  readonly method: "merge" | "squash" | "rebase";
  readonly expectedAccountId?: string;
  readonly removeAgentCredits: boolean;
}
