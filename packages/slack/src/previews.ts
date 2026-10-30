import type { PreviewId } from "@mend/domain";
import type { PreviewStatus } from "@mend/domain/workbench";
import type { PublicOrigin } from "@mend/network";

/** One kept preview of a worktree, as a Slack thread may show it (ADR 0017). */
export interface PreviewNotice {
  readonly id: PreviewId;
  readonly service: string;
  readonly facts: ReadonlyArray<PreviewStatus>;
  /**
   * The gateway would serve it (`previewOpenOf`). A boolean, never a URL: the thread builds the
   * credential-free link from `appUrl` and the preview's id.
   */
  readonly openable: boolean;
}

/**
 * The previews a message shows. `Hidden` carries nothing: the gateway is off, the thread may not
 * show them, or the project is private in a channel. `Shown` carries `appUrl`, the origin the
 * gateway's own sign-in uses (`APP_URL`), so a person signs in once, on one origin.
 */
export type WorktreePreviews =
  | { readonly _tag: "Hidden" }
  | {
      readonly _tag: "Shown";
      readonly appUrl: PublicOrigin;
      /** By Service name, then id. */
      readonly previews: ReadonlyArray<PreviewNotice>;
      /** A preparation that failed before any preview was allocated. */
      readonly unprepared: PreviewStatus | null;
    };

export const NO_PREVIEWS: WorktreePreviews = { _tag: "Hidden" };
