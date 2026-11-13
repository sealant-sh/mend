import { Schema } from "effect";

import { EvidencePointer } from "./evidence.ts";
import { ChangeId, IssueId, RunId, SealantRunId, SealantWorkspaceId } from "./ids.ts";
import { SequenceNumber, Timestamp } from "./timestamp.ts";

/** Initial run · follow-up runs · re-verification runs. Runs are many. */
export const RunKind = Schema.Literals(["initial", "follow-up", "verification"]);
export type RunKind = typeof RunKind.Type;

/** Mirrors the SDK's run lifecycle so status maps 1:1 from the platform. */
export const RunStatus = Schema.Literals(["queued", "running", "completed", "failed", "cancelled"]);
export type RunStatus = typeof RunStatus.Type;

export const RunOutcome = Schema.Literals(["completed", "failed"]);
export type RunOutcome = typeof RunOutcome.Type;

/**
 * The failure mini-brief (docs/archive/PRODUCT.md §6): what was tried, what was observed,
 * reproduction status — summed from the recording of a failed run. No PR, no
 * brief; failures are evidence too, kept and reported, never hidden. Rendered
 * in-app on the issue (M2); posted to the tracker with M3.
 */
export class FailureBrief extends Schema.Class<FailureBrief>("FailureBrief")({
  whatWasTried: Schema.String,
  whatWasObserved: Schema.String,
  /** e.g. "reproduced, still failing after the attempt" · "never reproduced". */
  reproductionStatus: Schema.String,
  evidence: Schema.Array(EvidencePointer),
}) {}

/**
 * One harness execution in one workspace, indexed in Postgres. The recording
 * itself stays in Sealant; Mend addresses it by `(sealantRunId, sequence)`.
 */
export class Run extends Schema.Class<Run>("Run")({
  id: RunId,
  issueId: IssueId,
  changeId: Schema.NullOr(ChangeId),
  kind: RunKind,
  sealantRunId: Schema.NullOr(SealantRunId),
  sealantWorkspaceId: Schema.NullOr(SealantWorkspaceId),
  status: RunStatus,
  outcome: Schema.NullOr(RunOutcome),
  summary: Schema.NullOr(Schema.String),
  /** Present only on failed runs whose recording was summed (docs/archive/PRODUCT.md §6). */
  failureBrief: Schema.NullOr(FailureBrief),
  /** Last record sequence the supervisor persisted — crash-resume re-attaches from here. */
  lastSeenSequence: SequenceNumber,
  startedAt: Schema.NullOr(Timestamp),
  settledAt: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}
