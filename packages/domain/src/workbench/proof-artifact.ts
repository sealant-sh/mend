/**
 * Recorded proof artifacts (docs/adr/0021-setup-session-and-proof-artifacts.md): a selected
 * screenshot or short video of the user's web app on a session's screen, attached to its change
 * with the source that ran and when Mend observed it. A label says what was observed, never that
 * the change works.
 */

import { Schema } from "effect";

import {
  AgentTurnId,
  ChangeId,
  CheckpointId,
  ProjectId,
  ProofArtifactId,
  ScreenId,
  SessionId,
  Sha,
  WorktreeId,
} from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { ScreenMoment, ScreenSpan } from "./screen.ts";

export const PROOF_SCREENSHOT_TOOL = "proof_screenshot";
export const PROOF_VIDEO_START_TOOL = "proof_video_start";
export const PROOF_VIDEO_STOP_TOOL = "proof_video_stop";
export const PROOF_MISSING_TOOL = "proof_missing";

export const PROOF_LIMITS = {
  titleChars: 120,
  captionChars: 1_000,
  noteChars: 1_000,
  /** ADR 0021 D7: the after video runs under about a minute; Mend ends it here. */
  videoMs: 60_000,
} as const;

/** `before` and `after` name the source an artifact shows, not when it was taken. */
export const ProofSide = Schema.Literals(["before", "after"]);
export type ProofSide = typeof ProofSide.Type;

export const ProofKind = Schema.Literals(["screenshot", "video"]);
export type ProofKind = typeof ProofKind.Type;

/**
 * The source the app ran. `Base` is the change's base commit, for `before`. `Checkpoint` is the
 * checkpoint Mend took when an `after` capture began. `Unknown` says why neither holds. A screen
 * entry's `ObservedAfter` link never stands in for a source.
 */
export const ProofSource = Schema.Union([
  Schema.TaggedStruct("Base", { commit: Sha }),
  Schema.TaggedStruct("Checkpoint", {
    checkpointId: CheckpointId,
    ordinal: Schema.Int,
    commit: Sha,
  }),
  Schema.TaggedStruct("Unknown", { reason: Schema.String }),
]);
export type ProofSource = typeof ProofSource.Type;

export const ProofMimeType = Schema.Literals(["image/png", "video/mp4"]);
export type ProofMimeType = typeof ProofMimeType.Type;

/** Media Mend holds in its blob store under `proofBlobKey`, for as long as the change exists. */
export const ProofMedia = Schema.Struct({
  blobKey: Schema.String,
  mimeType: ProofMimeType,
  bytes: Schema.Int,
  sha256: Schema.String,
});
export type ProofMedia = typeof ProofMedia.Type;

/** How a video ended. Anything but `Stopped` is said beside the video. */
export const ProofVideoEnding = Schema.Literals(["stopped", "time-limit", "interrupted"]);
export type ProofVideoEnding = typeof ProofVideoEnding.Type;

/**
 * What the artifact holds. `Recording` is a video still being captured; `NotCaptured` is an
 * artifact the agent could not capture, with the reason (a base that does not run, a missing test
 * account). An after capture is never relabeled before to fill a gap.
 */
export const ProofCapture = Schema.Union([
  Schema.TaggedStruct("Screenshot", { moment: ScreenMoment, media: ProofMedia }),
  Schema.TaggedStruct("Recording", { screenId: ScreenId, fromSeq: Schema.Int }),
  Schema.TaggedStruct("Video", {
    span: ScreenSpan,
    media: ProofMedia,
    durationMs: Schema.Int,
    ending: ProofVideoEnding,
  }),
  Schema.TaggedStruct("NotCaptured", { kind: ProofKind, reason: Schema.String }),
]);
export type ProofCapture = typeof ProofCapture.Type;

export class ProofArtifact extends Schema.Class<ProofArtifact>("ProofArtifact")({
  id: ProofArtifactId,
  changeId: ChangeId,
  worktreeId: WorktreeId,
  projectId: ProjectId,
  /** Null once the contributing session is removed; the artifact stays with the change. */
  sessionId: Schema.NullOr(SessionId),
  turnId: Schema.NullOr(AgentTurnId),
  /** The flow shown, such as "Completed task on board". */
  title: Schema.String,
  /** The agent's description of what is visible. */
  caption: Schema.String,
  side: ProofSide,
  source: ProofSource,
  capture: ProofCapture,
  /** The recipe or launch command and port the app ran with, as the agent reported it. */
  launch: Schema.NullOr(Schema.String),
  /** Known differences in data, account or route between before and after. */
  differences: Schema.NullOr(Schema.String),
  observedFrom: Timestamp,
  observedTo: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
}) {}

/** The `proof` agent item's data: enough for a client to label and fetch the media. */
export class ProofRef extends Schema.Class<ProofRef>("ProofRef")({
  artifactId: ProofArtifactId,
  sessionId: SessionId,
  kind: ProofKind,
  side: ProofSide,
  title: Schema.String,
  caption: Schema.String,
  label: Schema.String,
  /** `stored` media can be fetched; `recording` and `not-captured` have none yet or ever. */
  state: Schema.Literals(["stored", "recording", "not-captured"]),
  mimeType: Schema.NullOr(ProofMimeType),
}) {}

export const proofItemProviderId = (id: ProofArtifactId): string => `mend-proof:${id}`;

/** Every artifact of a change lives under one prefix, so deleting the change can list them. */
export const proofBlobPrefix = (changeId: ChangeId): string => `proof-artifacts/${changeId}/`;

export const proofBlobKey = (
  changeId: ChangeId,
  id: ProofArtifactId,
  mimeType: ProofMimeType,
): string => `${proofBlobPrefix(changeId)}${id}.${mimeType === "image/png" ? "png" : "mp4"}`;

export const proofKindOf = (capture: ProofCapture): ProofKind => {
  switch (capture._tag) {
    case "Screenshot":
      return "screenshot";
    case "Recording":
    case "Video":
      return "video";
    case "NotCaptured":
      return capture.kind;
  }
};

const sourceLabel = (source: ProofSource): string => {
  switch (source._tag) {
    case "Base":
      return `base ${source.commit.slice(0, 7)}`;
    case "Checkpoint":
      return `checkpoint #${source.ordinal}`;
    case "Unknown":
      return "source unknown";
  }
};

const stateLabel = (capture: ProofCapture): string | null => {
  switch (capture._tag) {
    case "Screenshot":
      return null;
    case "Recording":
      return "recording";
    case "Video":
      return capture.ending === "stopped"
        ? null
        : capture.ending === "time-limit"
          ? "ended at the time limit"
          : "interrupted";
    case "NotCaptured":
      return `not captured · ${capture.reason}`;
  }
};

/**
 * The one line every client shows: `Completed task on board · before · base 1a2b3c4 · observed
 * 14:02 UTC`. `observedAt` formats the observation time for the reader's surface.
 */
export const proofLabel = (
  artifact: Pick<ProofArtifact, "title" | "side" | "source" | "capture" | "observedFrom">,
  observedAt: (at: Date) => string,
): string =>
  [
    artifact.title,
    artifact.side,
    sourceLabel(artifact.source),
    stateLabel(artifact.capture),
    artifact.capture._tag === "NotCaptured"
      ? null
      : `observed ${observedAt(artifact.observedFrom)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
