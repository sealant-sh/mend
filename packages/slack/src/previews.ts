import { PreviewId } from "@mend/domain";
import { PreviewStatus } from "@mend/domain/workbench";
import { PublicOrigin } from "@mend/network";
import { Schema } from "effect";

/** One kept preview of a worktree, as a Slack thread may show it (ADR 0017). */
export const PreviewNotice = Schema.Struct({
  id: PreviewId,
  service: Schema.String,
  facts: Schema.Array(PreviewStatus),
  /**
   * The gateway would serve it (`previewOpenOf`). A boolean, never a URL: the thread builds the
   * credential-free link from `appUrl` and the preview's id.
   */
  openable: Schema.Boolean,
});
export type PreviewNotice = typeof PreviewNotice.Type;

/**
 * The previews a message shows. `Hidden` carries nothing: the gateway is off, the thread may not
 * show them, or the project is private in a channel. `Shown` carries `appUrl`, the origin the
 * gateway's own sign-in uses (`APP_URL`), so a person signs in once, on one origin.
 */
export const WorktreePreviews = Schema.Union([
  Schema.TaggedStruct("Hidden", {}),
  Schema.TaggedStruct("Shown", {
    appUrl: PublicOrigin,
    /** By Service name, then id. */
    previews: Schema.Array(PreviewNotice),
    /** A preparation that failed before any preview was allocated. */
    unprepared: Schema.NullOr(PreviewStatus),
  }),
]);
export type WorktreePreviews = typeof WorktreePreviews.Type;

export const NO_PREVIEWS: WorktreePreviews = { _tag: "Hidden" };
