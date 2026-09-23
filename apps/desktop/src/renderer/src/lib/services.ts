import { serviceConnectCommand, serviceReach, type ServiceReach } from "@mend/domain/workbench";

import type { ServiceEndpointDto, ServiceViewDto, SessionProcessDto } from "#/lib/api";
import type { Tone } from "#/lib/words";

export type ServiceAction =
  | "open"
  | "copy"
  | "copy-command"
  | "logs"
  | "restart"
  | "stop"
  | "remove-forward"
  | "run-again";

export interface ServiceFact {
  readonly word: string;
  readonly tone: Tone;
}

export interface ServiceFacts {
  readonly view: ServiceViewDto;
  readonly name: string;
  readonly process: ServiceFact | null;
  readonly forward: ServiceFact;
  readonly target: (ServiceFact & { readonly observedAt: string }) | null;
  readonly endpoint: ServiceEndpointDto | null;
  /** What Open opens — null when nothing answers where this desktop runs. */
  readonly browserUrl: string | null;
  /** Where this desktop reaches it: directly, or only through the CLI's tunnel. */
  readonly reach: ServiceReach;
  /** `mend service connect <name>`: what brings a loopback-only Service here. */
  readonly connectCommand: string;
  readonly logAttempt: SessionProcessDto | null;
  readonly movedFrom: string | null;
  readonly actions: ReadonlyArray<ServiceAction>;
  readonly attention: ServiceFact | null;
}

const currentAttempt = (view: ServiceViewDto): SessionProcessDto | null =>
  view.service.currentAttemptId === null
    ? null
    : (view.attempts.find((attempt) => attempt.id === view.service.currentAttemptId) ?? null);

const latestSupervisedAttempt = (view: ServiceViewDto): SessionProcessDto | null =>
  view.attempts.findLast(
    (attempt) => attempt.argv.length > 0 && attempt.sealantSessionId !== null,
  ) ?? null;

const preferredEndpoint = (view: ServiceViewDto): ServiceEndpointDto | null =>
  view.endpoints.find((endpoint) => endpoint.scope === "private") ?? view.endpoints[0] ?? null;

const processFact = (attempt: SessionProcessDto | null): ServiceFact | null => {
  if (attempt === null) return null;
  const ordinal = attempt.attemptOrdinal === null ? "" : ` · attempt ${attempt.attemptOrdinal}`;
  switch (attempt.status) {
    case "running":
      return { word: `Process running${ordinal}`, tone: "accent" };
    case "starting":
      return { word: `Process starting${ordinal}`, tone: "accent" };
    case "stopped":
      return { word: `Process stopped${ordinal}`, tone: "hollow" };
    case "exited":
      return {
        word: `Process exited${attempt.exitCode === null ? "" : ` code ${attempt.exitCode}`}${ordinal}`,
        tone: attempt.exitCode === null || attempt.exitCode === 0 ? "hollow" : "red",
      };
    default:
      return { word: `Process ${attempt.status}${ordinal}`, tone: "hollow" };
  }
};

/**
 * `clientOnMendHost`: whether this desktop runs on the Mend host (its server URL is loopback).
 * Elsewhere a loopback endpoint is unreachable, so Open and Copy endpoint give way to the CLI
 * command that tunnels it here.
 */
export const serviceFacts = (view: ServiceViewDto, clientOnMendHost = true): ServiceFacts => {
  const attempt = currentAttempt(view);
  const logAttempt = latestSupervisedAttempt(view);
  const endpoint = preferredEndpoint(view);
  const bound = view.currentForward?.state === "bound";
  const forward: ServiceFact =
    view.currentForward === null
      ? { word: "Forward absent", tone: "hollow" }
      : view.currentForward.state === "bound"
        ? {
            word: `Forward bound${endpoint === null ? "" : ` to ${endpoint.authority}`}`,
            tone: "accent",
          }
        : view.currentForward.state === "failed"
          ? {
              word: `Forward failed${view.currentForward.error === null ? "" : ` · ${view.currentForward.error}`}`,
              tone: "red",
            }
          : { word: `Forward ${view.currentForward.state}`, tone: "hollow" };
  const observation =
    view.currentForward !== null && view.latestObservation?.forwardId === view.currentForward.id
      ? view.latestObservation
      : null;
  const target =
    observation === null
      ? null
      : {
          word:
            observation.state === "reachable"
              ? `${view.service.transport.toUpperCase()} accepted on :${view.service.workspacePort}`
              : `${view.service.transport.toUpperCase()} did not answer on :${view.service.workspacePort}`,
          tone: observation.state === "reachable" ? ("green" as const) : ("amber" as const),
          observedAt: observation.lastObservedAt,
        };
  const reach = serviceReach(view.endpoints, clientOnMendHost);
  const browserUrl = reach.kind === "direct" ? reach.browserUrl : null;
  const previousEndpoint =
    view.previousEndpoints.find((candidate) => candidate.scope === "private") ??
    view.previousEndpoints[0] ??
    null;
  const movedFrom =
    endpoint !== null &&
    previousEndpoint !== null &&
    endpoint.authority !== previousEndpoint.authority
      ? previousEndpoint.authority
      : null;
  const actions: ServiceAction[] = [];
  if (bound && browserUrl !== null) actions.push("open");
  if (bound && endpoint !== null && reach.kind === "direct") actions.push("copy");
  if (bound && reach.kind === "tunnel") actions.push("copy-command");
  if (logAttempt !== null) actions.push("logs");
  if (attempt !== null && attempt.exitedAt === null && attempt.argv.length > 0) {
    actions.push("restart", "stop");
  } else if (view.currentForward?.state === "bound" || view.currentForward?.state === "binding") {
    actions.push("remove-forward");
  } else if (logAttempt !== null) {
    actions.push("run-again");
  }
  const attention =
    view.workspaceTtlRenewalError === null
      ? view.currentForward?.state === "failed"
        ? { word: "Forward failed", tone: "red" as const }
        : attempt?.status === "exited" && attempt.exitCode !== null && attempt.exitCode !== 0
          ? { word: `Process exited code ${attempt.exitCode}`, tone: "red" as const }
          : observation?.state === "unreachable"
            ? { word: "Target stopped answering", tone: "amber" as const }
            : movedFrom === null
              ? null
              : { word: "Endpoint moved", tone: "amber" as const }
      : { word: "Workspace TTL renewal failed", tone: "amber" as const };

  return {
    view,
    name: view.service.name,
    process: processFact(attempt),
    forward,
    target,
    endpoint,
    browserUrl,
    reach,
    connectCommand: serviceConnectCommand(view.service.name),
    logAttempt,
    movedFrom,
    actions,
    attention,
  };
};

export const servicesForSession = (
  views: ReadonlyArray<ServiceViewDto>,
  sessionId: string,
  clientOnMendHost = true,
): ReadonlyArray<ServiceFacts> =>
  views
    .filter((view) => view.service.sessionId === sessionId)
    .map((view) => serviceFacts(view, clientOnMendHost));

/** One sidebar line per Service: the attention word, or the tersest liveness fact. */
export interface ServiceGlance {
  readonly name: string;
  readonly word: string;
  readonly tone: Tone;
  readonly attention: boolean;
}

export const serviceGlance = (view: ServiceViewDto): ServiceGlance => {
  const facts = serviceFacts(view);
  if (facts.attention !== null) {
    return {
      name: facts.name,
      word: facts.attention.word,
      tone: facts.attention.tone,
      attention: true,
    };
  }
  if (facts.target?.tone === "green") {
    return { name: facts.name, word: "reachable", tone: "green", attention: false };
  }
  if (facts.process?.tone === "accent") {
    return { name: facts.name, word: "running", tone: "accent", attention: false };
  }
  if (facts.forward.tone === "accent") {
    return { name: facts.name, word: "bound", tone: "accent", attention: false };
  }
  return { name: facts.name, word: "stopped", tone: "hollow", attention: false };
};
