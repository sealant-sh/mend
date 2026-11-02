import {
  PROOF_LIMITS,
  PROOF_MISSING_TOOL,
  PROOF_SCREENSHOT_TOOL,
  PROOF_VIDEO_START_TOOL,
  PROOF_VIDEO_STOP_TOOL,
  ProofKind,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import { isMendTool, type ToolIdentity } from "./mend-page-call.ts";

const title = Schema.String.check(Schema.isBetweenLength(1, PROOF_LIMITS.titleChars));
const note = Schema.String.check(Schema.isMaxLength(PROOF_LIMITS.noteChars));
export const ProofScreenshotParams = Schema.Struct({
  title,
  caption: Schema.String.check(Schema.isMaxLength(PROOF_LIMITS.captionChars)),
  launch: Schema.optionalKey(note),
  differences: Schema.optionalKey(note),
});
export type ProofScreenshotParams = typeof ProofScreenshotParams.Type;
export const ProofMissingParams = Schema.Struct({
  title,
  kind: ProofKind,
  reason: Schema.String.check(Schema.isBetweenLength(1, PROOF_LIMITS.noteChars)),
});
export type ProofMissingParams = typeof ProofMissingParams.Type;

export const ProofVideoStartParams = Schema.Struct({
  title,
  caption: Schema.String.check(Schema.isMaxLength(PROOF_LIMITS.captionChars)),
  launch: Schema.optionalKey(note),
  differences: Schema.optionalKey(note),
});
export type ProofVideoStartParams = typeof ProofVideoStartParams.Type;
export const ProofVideoStopParams = Schema.Record(Schema.String, Schema.Never);

const GUIDANCE =
  "Capture the app with the change as a person would see it. Choose what a person needs to see using .mend/features.md and .mend/verify.md when present. Labels describe observations, never verdicts that a change works. Never put secret values, signed cookies or tokens in tool arguments. When a capture cannot be taken, record proof_missing with the reason.";
export const PROOF_SCREENSHOT_DESCRIPTION = `Capture a labelled PNG of the user's web app on this session's screen and attach it to the change. Start the app and open it with chromium first. Mend takes a checkpoint when capture starts; record launch commands and known differences from the verification instructions. ${GUIDANCE}`;
export const PROOF_MISSING_DESCRIPTION = `Record a screenshot or video that could not be captured, with its reason, on this session's change. ${GUIDANCE}`;

export const PROOF_VIDEO_START_DESCRIPTION = `Start a labelled video of the user's web app on this session's screen, attached to the change and pinned to a checkpoint. Start the app and open it with chromium first. Drive the flow with screen_act while recording; screen_look can observe between batches. Keep it under about a minute and call proof_video_stop within 60 seconds. Mend ends and stores it at the limit even if you forget to stop. Record launch commands and known differences from the verification instructions. ${GUIDANCE}`;
export const PROOF_VIDEO_STOP_DESCRIPTION = `Stop this session's proof video and store its playable MP4 on the change. Returns its source and observation label, including a time limit or interruption when observed. If it already finished, returns that artifact. Never put secret values in tool arguments.`;

export type MendProofTool =
  | typeof PROOF_SCREENSHOT_TOOL
  | typeof PROOF_MISSING_TOOL
  | typeof PROOF_VIDEO_START_TOOL
  | typeof PROOF_VIDEO_STOP_TOOL;
export const mendProofToolOf = (identity: ToolIdentity): MendProofTool | null =>
  isMendTool(PROOF_SCREENSHOT_TOOL, identity)
    ? PROOF_SCREENSHOT_TOOL
    : isMendTool(PROOF_MISSING_TOOL, identity)
      ? PROOF_MISSING_TOOL
      : isMendTool(PROOF_VIDEO_START_TOOL, identity)
        ? PROOF_VIDEO_START_TOOL
        : isMendTool(PROOF_VIDEO_STOP_TOOL, identity)
          ? PROOF_VIDEO_STOP_TOOL
          : null;

/** The text beside proof media. Stored transcripts retain this, never the PNG block. */
export const ProofToolText = Schema.Struct({
  artifactId: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  message: Schema.String,
  refusal: Schema.optionalKey(Schema.String),
});
export type ProofToolText = typeof ProofToolText.Type;
