import { Effect, Schema } from "effect";

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
import { Timestamp } from "../timestamp.ts";
import { observedAgo } from "./landing.ts";
import { type ServiceAddress, ServiceHostPolicy } from "./service-recipe.ts";
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

/**
 * How the gateway dials a bound preview: bound to the attempt's process, or by port for a Service
 * Docker publishes, where nothing can prove the process (ADR 0017, "A bound dial never falls
 * back").
 */
export const PreviewDial = Schema.Literals(["session-bound", "port-scoped"]);
export type PreviewDial = typeof PreviewDial.Type;

export const previewDialOf = (address: ServiceAddress): PreviewDial =>
  address === "docker" ? "port-scoped" : "session-bound";

export const PreviewBinding = Schema.Union([
  Schema.TaggedStruct("Unbound", { reason: PreviewUnboundReason }),
  Schema.TaggedStruct("Bound", {
    serviceId: ServiceId,
    attemptId: SessionProcessId,
    host: ServiceHostPolicy.pipe(Schema.withDecodingDefaultKey(Effect.succeed("rewrite" as const))),
    dial: PreviewDial.pipe(Schema.withDecodingDefaultKey(Effect.succeed("session-bound" as const))),
  }),
]);
export type PreviewBinding = typeof PreviewBinding.Type;

export const PreviewView = Schema.Struct({ preview: Preview, binding: PreviewBinding });
export type PreviewView = typeof PreviewView.Type;

export const previewAuthTarget = (previewId: PreviewId, path: string): string =>
  `/preview-auth?preview=${encodeURIComponent(previewId)}&path=${encodeURIComponent(path)}`;

const gatewayServes = (binding: PreviewBinding): boolean =>
  binding._tag === "Bound" || binding.reason === "no-live-attempt";

export const previewOpenTarget = ({ preview, binding }: PreviewView): string | null =>
  preview.state === "kept" && gatewayServes(binding) ? previewAuthTarget(preview.id, "/") : null;

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
    ? {
        _tag: "Bound",
        serviceId: selected.service.id,
        attemptId: selected.attempt.id,
        host: selected.service.hostPolicy,
        dial: previewDialOf(selected.service.address),
      }
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
  /** `runsAs` null: the session's owner. */
  | { readonly kind: "system"; readonly runsAs: string | null };

export const previewControlDecider = (cause: ServiceStopCause | ServiceStartCause): string | null =>
  cause.kind === "person" ? cause.userId : null;

/** Whom a started Service runs as in a person executor; null is the session's owner. */
export const serviceRunsAs = (cause: ServiceStartCause): string | null => {
  switch (cause.kind) {
    case "person":
      return cause.userId;
    case "workspace":
    case "system":
      return cause.runsAs;
  }
};

export interface PreviewBoundAttempt {
  readonly serviceId: ServiceId;
  readonly attemptId: SessionProcessId;
  readonly sessionId: SessionId;
  readonly workspaceId: SealantWorkspaceId;
  readonly port: number;
  readonly platformSessionId: string;
  readonly host: ServiceHostPolicy;
  readonly dial: PreviewDial;
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
      /** Null while a leased preparation runs setup or dependencies before its attempt. */
      readonly attemptId: SessionProcessId | null;
      readonly workspaceId: SealantWorkspaceId | null;
    }
  | {
      readonly _tag: "Dormant";
      readonly revision: number;
      readonly source: PreviewResumeSource;
      readonly workspaceId: SealantWorkspaceId | null;
    }
  | { readonly _tag: "Refused"; readonly reason: PreviewGatewayRefusal };

/**
 * Open may wake a recipe or an idle-stopped run (ADR 0017, delivery step 12). An explicit run
 * stopped outside the idle lifecycle may have used temporary files that no longer exist.
 */
export const previewOffersOpen = (
  resolution: PreviewGatewayResolution | null,
  source: Pick<Service, "declarationSource"> | null,
  idleStopped: boolean,
  preparing = false,
): boolean => {
  if (preparing && resolution?._tag !== "Stopped") return true;
  switch (resolution?._tag) {
    case "Bound":
    case "Starting":
      return true;
    case "Dormant":
      return (
        idleStopped ||
        source?.declarationSource === "recipe-file" ||
        source?.declarationSource === "recipe-project"
      );
    default:
      return false;
  }
};

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
      host: service.hostPolicy,
      dial: previewDialOf(service.address),
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

export const PreviewStopper = Schema.Union([
  Schema.TaggedStruct("Person", { name: Schema.String }),
  Schema.TaggedStruct("Idle", { minutes: Schema.Int }),
]);
export type PreviewStopper = typeof PreviewStopper.Type;

export const PreviewPhase = Schema.Literals(["setup", "depends", "service"]);
export type PreviewPhase = typeof PreviewPhase.Type;

export const PreviewNotPrepared = Schema.Union([
  Schema.TaggedStruct("NotCaptured", {}),
  Schema.TaggedStruct("SessionEnded", {}),
  Schema.TaggedStruct("Refused", { words: Schema.String }),
]);
export type PreviewNotPrepared = typeof PreviewNotPrepared.Type;

export type PreviewNotDelivered =
  | { readonly _tag: "DidNotStart"; readonly holdMs: number; readonly reason: PreviewStartReason }
  | { readonly _tag: "Stopped"; readonly by: string };

/**
 * What Mend observed or decided about a preview, as facts. A surface words each with
 * `previewStatusLine` at the time it shows it.
 */
export const PreviewStatus = Schema.Union([
  Schema.TaggedStruct("Observed", {
    service: Schema.String,
    reachable: Schema.Boolean,
    /** The status code its HTTP ready check read; null under a TCP rule. */
    httpStatus: Schema.NullOr(Schema.Int),
    observedAt: Timestamp,
  }),
  Schema.TaggedStruct("Starting", { service: Schema.String, phase: PreviewPhase }),
  Schema.TaggedStruct("Stopped", { service: Schema.String, by: PreviewStopper }),
  Schema.TaggedStruct("NotPrepared", {
    /**
     * Null when no Service was chosen: the change was not captured, the session ended, or
     * mend.toml was unreadable.
     */
    service: Schema.NullOr(Schema.String),
    why: PreviewNotPrepared,
  }),
  Schema.TaggedStruct("SetupInputsChanged", {}),
]);
export type PreviewStatus = typeof PreviewStatus.Type;

const holdText = (ms: number): string =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;

const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";

const observedWords = (status: Extract<PreviewStatus, { readonly _tag: "Observed" }>): string =>
  !status.reachable
    ? "unreachable"
    : status.httpStatus === null
      ? "reachable"
      : `answered HTTP ${status.httpStatus}`;

const notPreparedWords = (service: string | null, why: PreviewNotPrepared): string => {
  switch (why._tag) {
    case "NotCaptured":
      return "change not captured";
    case "SessionEnded":
      return "session ended";
    case "Refused":
      return firstLine(why.words);
  }
};

export const previewFactLine = (service: string, fact: string): string =>
  `preview · ${service} · ${fact}`;

/**
 * How a fact is worded: as of `now`, or `stable`, without an age, so the line does not change as
 * time passes or a check repeats (`preview · web · answered HTTP 200 · observed`).
 */
export type PreviewLineOptions = { readonly now: Date } | { readonly stable: true };

export const previewStatusLine = (status: PreviewStatus, options: PreviewLineOptions): string => {
  switch (status._tag) {
    case "Observed":
      return previewFactLine(
        status.service,
        "now" in options
          ? `${observedWords(status)} · observed ${observedAgo(status.observedAt, options.now)}`
          : `${observedWords(status)} · observed`,
      );
    case "Starting":
      return previewFactLine(
        status.service,
        `starting · ${status.phase === "service" ? status.service : status.phase}`,
      );
    case "Stopped":
      return previewFactLine(
        status.service,
        status.by._tag === "Person"
          ? `stopped by ${status.by.name}`
          : `stopped after ${status.by.minutes} min idle`,
      );
    case "NotPrepared": {
      const words = notPreparedWords(status.service, status.why);
      return status.service === null
        ? `preview not prepared · ${words}`
        : `preview not prepared · ${status.service} · ${words}`;
    }
    case "SetupInputsChanged":
      return "setup inputs changed · restart to apply";
  }
};

export const previewUndeliveredLine = (service: string, why: PreviewNotDelivered): string => {
  const fact =
    why._tag === "Stopped"
      ? `${why.by} stopped the preview`
      : `did not start${why.reason === "start timed out" ? ` in ${holdText(why.holdMs)}` : ""} · ${why.reason}`;
  return `${previewFactLine(service, fact)} · your request was not delivered`;
};
