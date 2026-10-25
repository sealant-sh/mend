import { Schema } from "effect";

import {
  PreviewId,
  PreviewLabel,
  ProjectId,
  type SealantWorkspaceId,
  ServiceId,
  type SessionId,
  SessionProcessId,
  WorktreeId,
} from "../ids.ts";
import { type Service, serviceStartCorrelation } from "./service.ts";
import type { SessionProcess } from "./session-process.ts";

const identity = {
  id: PreviewId,
  serviceName: Schema.String,
  label: PreviewLabel,
};

export const Preview = Schema.Union([
  Schema.Struct({
    ...identity,
    projectId: ProjectId,
    worktreeId: WorktreeId,
    state: Schema.Literal("kept"),
  }),
  Schema.Struct({
    ...identity,
    projectId: Schema.NullOr(ProjectId),
    worktreeId: Schema.Null,
    state: Schema.Literal("removed"),
  }),
]);
export type Preview = typeof Preview.Type;

export const PreviewUnboundReason = Schema.Literals([
  "removed",
  "service-missing",
  "not-browser-service",
  "no-live-attempt",
  "no-recorded-command",
  "https-unsupported",
]);
export type PreviewUnboundReason = typeof PreviewUnboundReason.Type;

export const PreviewBinding = Schema.Union([
  Schema.TaggedStruct("Unbound", { reason: PreviewUnboundReason }),
  Schema.TaggedStruct("Bound", { serviceId: ServiceId, attemptId: SessionProcessId }),
]);
export type PreviewBinding = typeof PreviewBinding.Type;

export const PreviewView = Schema.Struct({ preview: Preview, binding: PreviewBinding });
export type PreviewView = typeof PreviewView.Type;

export interface PreviewTarget {
  readonly service: Service;
  readonly liveAttempt: SessionProcess | null;
  readonly recordedCommand: boolean;
}

/** The Service a preview's rule picks, with the binding it gives: the live attempt when bound. */
export type PreviewSelection =
  | { readonly _tag: "Bound"; readonly service: Service; readonly attempt: SessionProcess }
  | {
      readonly _tag: "Unbound";
      readonly reason: PreviewUnboundReason;
      readonly service: Service | null;
    };

const unbound = (
  reason: PreviewUnboundReason,
  service: Service | null = null,
): PreviewSelection => ({ _tag: "Unbound", reason, service });

const oldestFirst = (
  a: { readonly createdAt: Date; readonly id: string },
  b: { readonly createdAt: Date; readonly id: string },
) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const selectPreviewTarget = (
  preview: Preview,
  targets: ReadonlyArray<PreviewTarget>,
): PreviewSelection => {
  if (preview.state === "removed") return unbound("removed");
  const named = targets.filter((target) => target.service.name === preview.serviceName);
  const live = named
    .flatMap(({ service, liveAttempt }) =>
      service.browserScheme !== null && liveAttempt !== null
        ? [{ service, attempt: liveAttempt }]
        : [],
    )
    .toSorted((a, b) => oldestFirst(a.attempt, b.attempt))[0];
  if (live !== undefined) {
    if (live.service.browserScheme === "https") return unbound("https-unsupported", live.service);
    if (live.attempt.argv.length === 0) return unbound("no-recorded-command", live.service);
    return { _tag: "Bound", service: live.service, attempt: live.attempt };
  }
  const newest = named.toSorted((a, b) => oldestFirst(b.service, a.service))[0];
  if (newest === undefined) return unbound("service-missing");
  if (newest.service.browserScheme === null) return unbound("not-browser-service", newest.service);
  if (newest.service.browserScheme === "https") {
    return unbound("https-unsupported", newest.service);
  }
  const hasCommand = newest.recordedCommand || newest.service.declarationSource === "explicit-run";
  return unbound(hasCommand ? "no-live-attempt" : "no-recorded-command", newest.service);
};

export const resolvePreviewBinding = (
  preview: Preview,
  targets: ReadonlyArray<PreviewTarget>,
): PreviewBinding => {
  const selected = selectPreviewTarget(preview, targets);
  return selected._tag === "Bound"
    ? { _tag: "Bound", serviceId: selected.service.id, attemptId: selected.attempt.id }
    : { _tag: "Unbound", reason: selected.reason };
};

/**
 * Whether a preview's requests may start it (ADR 0017, Decision log 6). The revision changes only
 * when a person's Stop or Start changes it, so a start keyed by it runs once per intent.
 */
export const PreviewControl = Schema.Union([
  Schema.TaggedStruct("Automatic", { revision: Schema.Int }),
  Schema.TaggedStruct("OwnerStopped", {
    revision: Schema.Int,
    by: Schema.String,
    at: Schema.Date,
  }),
]);
export type PreviewControl = typeof PreviewControl.Type;

/** A preview with no control row: requests may start it. */
export const PREVIEW_CONTROL_INITIAL: PreviewControl = { _tag: "Automatic", revision: 0 };

/** What a person who decides a preview's control asked of it. */
export type PreviewControlIntent =
  | { readonly _tag: "OwnerStop"; readonly by: string; readonly at: Date }
  | { readonly _tag: "OwnerStart" };

/**
 * The control once `intent` is applied. A Stop of a stopped preview, or a Start of an automatic
 * one, changes nothing: the revision moves only with the state.
 */
export const changePreviewControl = (
  current: PreviewControl,
  intent: PreviewControlIntent,
): PreviewControl => {
  switch (intent._tag) {
    case "OwnerStop":
      return current._tag === "OwnerStopped"
        ? current
        : { _tag: "OwnerStopped", revision: current.revision + 1, by: intent.by, at: intent.at };
    case "OwnerStart":
      return current._tag === "Automatic"
        ? current
        : { _tag: "Automatic", revision: current.revision + 1 };
  }
};

/** Why a Service stopped. Only a person's Stop can be an owner's choice. */
export type ServiceStopCause =
  | { readonly kind: "person"; readonly userId: string }
  | { readonly kind: "system"; readonly reason: "session-ended" | "removal" | "idle" };

/** Why a Service started. Only a person's Start can clear an owner's Stop. */
export type ServiceStartCause =
  | { readonly kind: "person"; readonly userId: string }
  | { readonly kind: "preview-request" }
  | { readonly kind: "system" };

/**
 * Whether `person` decides the preview's control: its Service session's owner, as ADR 0017
 * Decision log 6 is written. Pending Yiannis: "any person's Stop" makes this `true`.
 */
export const decidesPreviewControl = (person: string, sessionOwner: string | null): boolean =>
  sessionOwner !== null && person === sessionOwner;

/** An attempt the gateway may deliver to: every field read from the Service and the attempt. */
export interface PreviewBoundAttempt {
  readonly serviceId: ServiceId;
  readonly attemptId: SessionProcessId;
  readonly sessionId: SessionId;
  readonly workspaceId: SealantWorkspaceId;
  readonly port: number;
  /** The platform session the process runs in: the forward is bound to it. */
  readonly platformSessionId: string;
  /** Still `starting`: not yet seen to answer, so a request waits for readiness. */
  readonly starting: boolean;
}

/** The last attempt seen to answer: what a request-triggered start runs again. */
export interface PreviewResumeSource {
  readonly serviceId: ServiceId;
  readonly sourceAttemptId: SessionProcessId;
}

export const PreviewGatewayRefusal = Schema.Literals([
  "service-missing",
  "not-browser-service",
  "no-recorded-command",
  "https-unsupported",
  "process-binding-unavailable",
]);
export type PreviewGatewayRefusal = typeof PreviewGatewayRefusal.Type;

/** What the gateway does with one request to a kept preview, read in one snapshot. */
export type PreviewGatewayResolution =
  | {
      readonly _tag: "OwnerStopped";
      readonly control: Extract<PreviewControl, { readonly _tag: "OwnerStopped" }>;
    }
  | {
      readonly _tag: "Bound";
      readonly revision: number;
      readonly attempt: PreviewBoundAttempt;
    }
  | {
      readonly _tag: "Dormant";
      readonly revision: number;
      readonly source: PreviewResumeSource;
    }
  | { readonly _tag: "Refused"; readonly reason: PreviewGatewayRefusal };

/** A request-triggered start, once per (preview, revision, source). */
export interface PreviewStartRequest {
  readonly previewId: PreviewId;
  readonly revision: number;
  readonly sourceAttemptId: SessionProcessId;
  /** Epoch milliseconds on the caller's Clock. Lifecycle waits count against it. */
  readonly deadline: number;
}

const PREVIEW_START = "preview-start:";

/**
 * The start id a request-triggered start runs under. Its attempt carries
 * `serviceStartCorrelation(serviceId, previewStartId(request))`, so a second start under the same
 * intent finds that attempt instead of starting another process.
 */
export const previewStartId = (
  request: Pick<PreviewStartRequest, "previewId" | "revision" | "sourceAttemptId">,
): string => `${PREVIEW_START}${request.previewId}:${request.revision}:${request.sourceAttemptId}`;

/** Whether a request to the preview started this attempt of `serviceId`, not a person. */
export const startedByPreviewRequest = (
  serviceId: string,
  launchCorrelationId: string | null,
): boolean =>
  launchCorrelationId !== null &&
  launchCorrelationId.startsWith(serviceStartCorrelation(serviceId, PREVIEW_START));

/** One recorded attempt of a Service, and whether a probe saw that attempt answer. */
export interface PreviewAttemptEvidence {
  readonly attempt: SessionProcess;
  readonly reachable: boolean;
}

/** The Service whose attempt history decides a dormant preview's resume source, if any. */
export const previewResumeCandidate = (selected: PreviewSelection): Service | null =>
  selected._tag === "Unbound" && selected.reason === "no-live-attempt" ? selected.service : null;

/**
 * The attempt a request-triggered start runs again: the newest with a command that either answered
 * or was not itself started by a request. A request's start that never answered keeps its source,
 * and attempts recorded before attempt-tied readiness still qualify.
 */
export const previewResumeSourceOf = (
  service: Service,
  history: ReadonlyArray<PreviewAttemptEvidence>,
): PreviewResumeSource | null => {
  const source = history
    .filter(
      ({ attempt, reachable }) =>
        attempt.argv.length > 0 &&
        (reachable || !startedByPreviewRequest(service.id, attempt.launchCorrelationId)),
    )
    .toSorted((a, b) => oldestFirst(b.attempt, a.attempt))[0];
  return source === undefined
    ? null
    : { serviceId: service.id, sourceAttemptId: source.attempt.id };
};

/**
 * What the gateway does with a request to `selected`'s preview. A removed preview is refused (the
 * gateway answers it as removed), an owner's Stop wins over a live attempt, and a dormant preview
 * resumes only its own Service. `history` is `previewResumeCandidate`'s attempts.
 */
export const previewGatewayResolution = (
  control: PreviewControl,
  selected: PreviewSelection,
  history: ReadonlyArray<PreviewAttemptEvidence>,
): PreviewGatewayResolution => {
  const removed = selected._tag === "Unbound" && selected.reason === "removed";
  if (!removed && control._tag === "OwnerStopped") return { _tag: "OwnerStopped", control };
  if (selected._tag === "Unbound") {
    switch (selected.reason) {
      case "removed":
        return { _tag: "Refused", reason: "service-missing" };
      case "no-live-attempt": {
        const source =
          selected.service === null ? null : previewResumeSourceOf(selected.service, history);
        return source === null
          ? { _tag: "Refused", reason: "no-recorded-command" }
          : { _tag: "Dormant", revision: control.revision, source };
      }
      default:
        return { _tag: "Refused", reason: selected.reason };
    }
  }
  const { service, attempt } = selected;
  if (attempt.sealantSessionId === null) {
    return { _tag: "Refused", reason: "process-binding-unavailable" };
  }
  return {
    _tag: "Bound",
    revision: control.revision,
    attempt: {
      serviceId: service.id,
      attemptId: attempt.id,
      sessionId: service.sessionId,
      workspaceId: attempt.sealantWorkspaceId,
      port: service.workspacePort,
      platformSessionId: attempt.sealantSessionId,
      starting: attempt.status === "starting",
    },
  };
};

export const PreviewStartRefusal = Schema.Literals([
  "owner-stopped",
  "control-changed",
  "preview-gone",
  "workspace-not-live",
  "workspace-retiring",
  "no-recorded-command",
  "starter-no-standing",
  "port-occupied",
  "start-expired",
  "command-failed",
  "start-unconfirmed",
]);
export type PreviewStartRefusal = typeof PreviewStartRefusal.Type;

/** Why a held request was not delivered, in the words of the page that says so. */
export type PreviewStartReason =
  | "start timed out"
  | "workspace is not live"
  | "command failed"
  | "setup failed"
  | "start could not be confirmed"
  | "starter no longer has access"
  | "the port is already in use"
  | "nothing listens"
  | "process exited"
  | "process binding is unavailable"
  | "preview is unavailable";

const START_REFUSAL_REASON = {
  "owner-stopped": "preview is unavailable",
  "control-changed": "preview is unavailable",
  "preview-gone": "preview is unavailable",
  "workspace-not-live": "workspace is not live",
  "workspace-retiring": "workspace is not live",
  "no-recorded-command": "command failed",
  "starter-no-standing": "starter no longer has access",
  "port-occupied": "the port is already in use",
  "start-expired": "start timed out",
  "command-failed": "command failed",
  "start-unconfirmed": "start could not be confirmed",
} as const satisfies Record<PreviewStartRefusal, PreviewStartReason>;

export const previewStartReasonOf = (refusal: PreviewStartRefusal): PreviewStartReason =>
  START_REFUSAL_REASON[refusal];

/** A request the gateway answered without delivering it. */
export type PreviewUndelivered =
  | {
      readonly _tag: "DidNotStart";
      readonly serviceName: string;
      readonly holdMs: number;
      readonly reason: PreviewStartReason;
    }
  | { readonly _tag: "StoppedByOwner"; readonly serviceName: string };

const holdText = (ms: number): string =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;

/** The page's one line: what happened, and that the request did not reach the app. */
export const previewUndeliveredLine = (fact: PreviewUndelivered): string => {
  switch (fact._tag) {
    case "DidNotStart":
      return `preview · ${fact.serviceName} · did not start in ${holdText(fact.holdMs)} · ${fact.reason} · your request was not delivered`;
    case "StoppedByOwner":
      return `preview · ${fact.serviceName} · the owner stopped the preview · your request was not delivered`;
  }
};
