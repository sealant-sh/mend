import {
  PROOF_LIMITS,
  PROOF_MISSING_TOOL,
  PROOF_SCREENSHOT_TOOL,
  ProofKind,
  ProofSide,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import { isMendTool, type ToolIdentity } from "./mend-page-call.ts";

const title = Schema.String.check(Schema.isBetweenLength(1, PROOF_LIMITS.titleChars));
const note = Schema.String.check(Schema.isMaxLength(PROOF_LIMITS.noteChars));
export const ProofScreenshotParams = Schema.Struct({
  title,
  side: ProofSide,
  caption: Schema.String.check(Schema.isMaxLength(PROOF_LIMITS.captionChars)),
  launch: Schema.optionalKey(note),
  differences: Schema.optionalKey(note),
});
export type ProofScreenshotParams = typeof ProofScreenshotParams.Type;
export const ProofMissingParams = Schema.Struct({
  title,
  side: ProofSide,
  kind: ProofKind,
  reason: Schema.String.check(Schema.isBetweenLength(1, PROOF_LIMITS.noteChars)),
});
export type ProofMissingParams = typeof ProofMissingParams.Type;

const GUIDANCE =
  "Choose what a person needs to see using .mend/features.md and .mend/verify.md when present. For before, run the base app from a side copy on another port, with its own writable data; never check out the base in /workspace/repo. Labels describe observations, never verdicts that a change works. Never put secret values, signed cookies or tokens in tool arguments. If before cannot run, record proof_missing with the reason; never relabel an after capture as before.";
export const PROOF_SCREENSHOT_DESCRIPTION = `Capture a labelled before or after PNG of the user's web app on this session's screen and attach it to the change. Start the app and open it with chromium first. After pins a checkpoint; record launch commands, port overrides and fixture differences. ${GUIDANCE}`;
export const PROOF_MISSING_DESCRIPTION = `Record a screenshot or video that could not be captured, with its reason, on this session's change. ${GUIDANCE}`;

export type MendProofTool = typeof PROOF_SCREENSHOT_TOOL | typeof PROOF_MISSING_TOOL;
export const mendProofToolOf = (identity: ToolIdentity): MendProofTool | null =>
  isMendTool(PROOF_SCREENSHOT_TOOL, identity)
    ? PROOF_SCREENSHOT_TOOL
    : isMendTool(PROOF_MISSING_TOOL, identity)
      ? PROOF_MISSING_TOOL
      : null;

/** The text beside proof media. Stored transcripts retain this, never the PNG block. */
export const ProofToolText = Schema.Struct({
  artifactId: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  message: Schema.String,
  refusal: Schema.optionalKey(Schema.String),
});
export type ProofToolText = typeof ProofToolText.Type;
