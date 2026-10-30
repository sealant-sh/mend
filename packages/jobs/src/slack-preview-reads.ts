import { WorktreeId } from "@mend/domain";
import type { WorktreePreviews } from "@mend/slack";
import { type Effect, Schema } from "effect";
import * as Context from "effect/Context";

export class PreviewReadUnavailable extends Schema.TaggedError<PreviewReadUnavailable>()(
  "PreviewReadUnavailable",
  { worktreeId: WorktreeId, cause: Schema.String },
) {}

/**
 * Facts and whether each preview opens, never a ticket or a preview host; it allocates nothing.
 * `Hidden` when the gateway is off. The API supplies it, where the gateway's setup and `APP_URL`
 * live.
 */
export class SlackPreviewReads extends Context.Service<
  SlackPreviewReads,
  {
    readonly forWorktree: (
      id: WorktreeId,
    ) => Effect.Effect<WorktreePreviews, PreviewReadUnavailable>;
  }
>()("@mend/jobs/SlackPreviewReads") {}
