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
  /** The live workspace of the Service's session, where a start would run; null when none. */
  readonly workspaceId: SealantWorkspaceId | null;
}

export type PreviewSelection =
  | { readonly _tag: "Bound"; readonly service: Service; readonly attempt: SessionProcess }
  | {
      readonly _tag: "Unbound";
      readonly reason: PreviewUnboundReason;
      readonly service: Service | null;
      readonly workspaceId: SealantWorkspaceId | null;
    };

const unbound = (
  reason: PreviewUnboundReason,
  target: PreviewTarget | null = null,
): PreviewSelection => ({
  _tag: "Unbound",
  reason,
  service: target?.service ?? null,
  workspaceId: target?.workspaceId ?? null,
});

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
    .flatMap((target) =>
      target.service.browserScheme !== null && target.liveAttempt !== null
        ? [{ target, attempt: target.liveAttempt }]
        : [],
    )
    .toSorted((a, b) => oldestFirst(a.attempt, b.attempt))[0];
  if (live !== undefined) {
    if (live.target.service.browserScheme === "https") {
      return unbound("https-unsupported", live.target);
    }
    if (live.attempt.argv.length === 0) return unbound("no-recorded-command", live.target);
    return { _tag: "Bound", service: live.target.service, attempt: live.attempt };
  }
  const newest = named.toSorted((a, b) => oldestFirst(b.service, a.service))[0];
  if (newest === undefined) return unbound("service-missing");
  if (newest.service.browserScheme === null) return unbound("not-browser-service", newest);
  if (newest.service.browserScheme === "https") return unbound("https-unsupported", newest);
  const hasCommand = newest.recordedCommand || newest.service.declarationSource === "explicit-run";
  return unbound(hasCommand ? "no-live-attempt" : "no-recorded-command", newest);
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
 * when a person's Stop or Start changes the state, so a start keyed by it runs once per intent.
 * `seq` orders the person's Stop against every Start asked before or after it.
 */
export const PreviewControl = Schema.Union([
  Schema.TaggedStruct("Automatic", { revision: Schema.Int }),
  Schema.TaggedStruct("Stopped", {
    revision: Schema.Int,
    by: Schema.String,
    at: Schema.Date,
    seq: Schema.Int,
  }),
]);
export type PreviewControl = typeof PreviewControl.Type;

export type PreviewStoppedRead = Extract<PreviewControl, { readonly _tag: "Stopped" }> & {
  readonly byName: string;
};
export type PreviewControlRead =
  | Extract<PreviewControl, { readonly _tag: "Automatic" }>
  | PreviewStoppedRead;

export const PREVIEW_CONTROL_INITIAL: Extract<PreviewControl, { readonly _tag: "Automatic" }> = {
  _tag: "Automatic",
  revision: 0,
};

/**
 * A person's intent, each with its place in one order of intents (`seq`). A Start asked before a
 * Stop was recorded never clears that Stop, however late the Start reaches it.
 */
export type PreviewControlIntent =
  | { readonly _tag: "Stop"; readonly by: string; readonly at: Date; readonly seq: number }
  | { readonly _tag: "Start"; readonly seq: number };

export const changePreviewControl = (
  current: PreviewControl,
  intent: PreviewControlIntent,
): PreviewControl => {
  switch (intent._tag) {
    case "Stop":
      return {
        _tag: "Stopped",
        revision: current._tag === "Stopped" ? current.revision : current.revision + 1,
        by: intent.by,
        at: intent.at,
        seq: intent.seq,
      };
    case "Start":
      return current._tag === "Automatic" || current.seq > intent.seq
        ? current
        : { _tag: "Automatic", revision: current.revision + 1 };
  }
};

/**
 * Why a Service stops or starts. Only `person` decides its preview's control, and only Mend's
 * person-facing routes name one (ADR 0017, Decision log 6): the owner's or a steerer's Stop, Start
 * or restart. `workspace` is the session's own socket or channel, which is its agent even when a
 * person's token carries it: `runsAs` is then that person.
 */
export type ServiceStopCause =
  | { readonly kind: "person"; readonly userId: string }
  | { readonly kind: "workspace" }
  | { readonly kind: "system"; readonly reason: "session-ended" | "removal" | "idle" };

export type ServiceStartCause =
  | { readonly kind: "person"; readonly userId: string }
  | { readonly kind: "workspace"; readonly runsAs: string | null }
  | { readonly kind: "system" };

export const previewControlDecider = (cause: ServiceStopCause | ServiceStartCause): string | null =>
  cause.kind === "person" ? cause.userId : null;

/** Whom a started Service runs as in a person executor; null is the session's owner. */
export const serviceRunsAs = (cause: ServiceStartCause): string | null => {
  switch (cause.kind) {
    case "person":
      return cause.userId;
    case "workspace":
      return cause.runsAs;
    case "system":
      return null;
  }
};

export interface PreviewBoundAttempt {
  readonly serviceId: ServiceId;
  readonly attemptId: SessionProcessId;
  readonly sessionId: SessionId;
  readonly workspaceId: SealantWorkspaceId;
  readonly port: number;
  readonly platformSessionId: string;
}

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

export type PreviewGatewayResolution =
  | {
      readonly _tag: "Stopped";
      readonly control: PreviewStoppedRead;
    }
  | {
      readonly _tag: "Bound";
      readonly revision: number;
      readonly attempt: PreviewBoundAttempt;
    }
  | {
      readonly _tag: "Starting";
      readonly revision: number;
      readonly attemptId: SessionProcessId;
      readonly workspaceId: SealantWorkspaceId;
    }
  | {
      readonly _tag: "Dormant";
      readonly revision: number;
      readonly source: PreviewResumeSource;
      readonly workspaceId: SealantWorkspaceId | null;
    }
  | { readonly _tag: "Refused"; readonly reason: PreviewGatewayRefusal };

export interface PreviewStartRequest {
  readonly previewId: PreviewId;
  readonly revision: number;
  readonly sourceAttemptId: SessionProcessId;
  /** Epoch milliseconds on the caller's Clock. Lifecycle waits count against it. */
  readonly deadline: number;
}

const PREVIEW_START = "preview-start:";

export const previewStartId = (
  request: Pick<PreviewStartRequest, "previewId" | "revision" | "sourceAttemptId">,
): string => `${PREVIEW_START}${request.previewId}:${request.revision}:${request.sourceAttemptId}`;

export const startedByPreviewRequest = (
  serviceId: string,
  launchCorrelationId: string | null,
): boolean =>
  launchCorrelationId !== null &&
  launchCorrelationId.startsWith(serviceStartCorrelation(serviceId, PREVIEW_START));

export interface PreviewAttemptEvidence {
  readonly attempt: SessionProcess;
  readonly reachable: boolean;
}

export const previewResumeCandidate = (selected: PreviewSelection): Service | null =>
  selected._tag === "Unbound" && selected.reason === "no-live-attempt" ? selected.service : null;

/** Attempts recorded before attempt-tied readiness (0139) still qualify as a source. */
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
 * A removed preview resolves to `service-missing`: the gateway answers it as removed. `history` is
 * the attempts of `previewResumeCandidate(selected)`. A person's Stop keeps requests from starting
 * the Service (ADR 0017, Decision log 6): a run the agent started is served while it lasts, and
 * the Stop holds again once it ends.
 */
export const previewGatewayResolution = (
  control: PreviewControlRead,
  selected: PreviewSelection,
  history: ReadonlyArray<PreviewAttemptEvidence>,
): PreviewGatewayResolution => {
  const resolution = unlatchedResolution(control.revision, selected, history);
  return resolution._tag === "Dormant" && control._tag === "Stopped"
    ? { _tag: "Stopped", control }
    : resolution;
};

const unlatchedResolution = (
  revision: number,
  selected: PreviewSelection,
  history: ReadonlyArray<PreviewAttemptEvidence>,
): PreviewGatewayResolution => {
  if (selected._tag === "Unbound") {
    switch (selected.reason) {
      case "removed":
        return { _tag: "Refused", reason: "service-missing" };
      case "no-live-attempt": {
        const source =
          selected.service === null ? null : previewResumeSourceOf(selected.service, history);
        return source === null
          ? { _tag: "Refused", reason: "no-recorded-command" }
          : { _tag: "Dormant", revision, source, workspaceId: selected.workspaceId };
      }
      default:
        return { _tag: "Refused", reason: selected.reason };
    }
  }
  const { service, attempt } = selected;
  if (attempt.status === "starting") {
    return {
      _tag: "Starting",
      revision,
      attemptId: attempt.id,
      workspaceId: attempt.sealantWorkspaceId,
    };
  }
  if (attempt.sealantSessionId === null) {
    return { _tag: "Refused", reason: "process-binding-unavailable" };
  }
  return {
    _tag: "Bound",
    revision,
    attempt: {
      serviceId: service.id,
      attemptId: attempt.id,
      sessionId: service.sessionId,
      workspaceId: attempt.sealantWorkspaceId,
      port: service.workspacePort,
      platformSessionId: attempt.sealantSessionId,
    },
  };
};

export const PreviewStartRefusal = Schema.Literals([
  "stopped",
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
  stopped: "preview is unavailable",
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

export type PreviewUndelivered =
  | {
      readonly _tag: "DidNotStart";
      readonly serviceName: string;
      readonly holdMs: number;
      readonly reason: PreviewStartReason;
    }
  | { readonly _tag: "Stopped"; readonly serviceName: string; readonly by: string };

const holdText = (ms: number): string =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;

export const previewUndeliveredLine = (fact: PreviewUndelivered): string => {
  switch (fact._tag) {
    case "DidNotStart": {
      const within = fact.reason === "start timed out" ? ` in ${holdText(fact.holdMs)}` : "";
      return `preview · ${fact.serviceName} · did not start${within} · ${fact.reason} · your request was not delivered`;
    }
    case "Stopped":
      return `preview · ${fact.serviceName} · ${fact.by} stopped the preview · your request was not delivered`;
  }
};
