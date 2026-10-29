import { observedAgo } from "./landing.ts";
import {
  imageReference,
  isDatabasePreset,
  type ProjectResourceDefinition,
  type ResourceDefinitionInput,
  type WorktreeResourceDefinition,
} from "./resource.ts";

/** What answered the instance's ready check, or that it has none to answer (a UDP-only resource). */
export type ResourceProbe =
  | { readonly kind: "answered"; readonly check: string }
  | { readonly kind: "not-probed" };

export type ResourceStopReason =
  | { readonly kind: "idle" }
  | { readonly kind: "person"; readonly by: string }
  | { readonly kind: "memory-limit" }
  | { readonly kind: "disk-limit" };

export type ResourceBlockReason = "data-volume-missing" | "needs-newer-sealant";

/** Whether the instance runs on the project's current secrets, which many images read only once. */
export type ResourceSecretState = "applied" | "changed-not-applied";

/** What Mend observed of the instance a worktree reaches, apart from the worktree's choice. */
export type ResourceInstanceObservation =
  | { readonly kind: "declared" }
  | { readonly kind: "waiting-for-approval" }
  | { readonly kind: "starting" }
  | {
      readonly kind: "running";
      readonly probe: ResourceProbe;
      readonly secret: ResourceSecretState;
    }
  | { readonly kind: "stopping" }
  | {
      readonly kind: "stopped";
      readonly reason: ResourceStopReason;
      readonly secret: ResourceSecretState;
    }
  | { readonly kind: "blocked"; readonly reason: ResourceBlockReason };

/** How an own database or instance began. A snapshot of an unknown image is crash-consistent. */
export type ResourceOwnStart =
  | { readonly kind: "empty" }
  | { readonly kind: "copied"; readonly at: Date }
  | { readonly kind: "snapshot"; readonly at: Date }
  | { readonly kind: "seed"; readonly seed: string };

/** What one worktree observed of a project resource it selected. `off` reaches no instance. */
export type ProjectResourceUse =
  | {
      readonly kind: "shared";
      readonly worktrees: number;
      readonly instance: ResourceInstanceObservation;
    }
  | {
      readonly kind: "own";
      readonly start: ResourceOwnStart;
      readonly instance: ResourceInstanceObservation;
    }
  | { readonly kind: "off" };

/** What one worktree observed of its own instance of a worktree resource. */
export interface WorktreeResourceUse {
  readonly kind: "worktree";
  readonly instance: ResourceInstanceObservation;
}

/** Why a launch went on without the resource. A launch never starts what a person stopped. */
export type ResourceLaunchHold =
  | { readonly kind: "stopped-by"; readonly by: string }
  | { readonly kind: "blocked"; readonly reason: ResourceBlockReason };

/** The status line's input. The line reads a definition's name, image and scope, never its env. */
export type ResourceStatusView =
  | {
      readonly kind: "observed";
      readonly definition: ProjectResourceDefinition;
      readonly use: ProjectResourceUse;
      readonly observedAt: Date;
    }
  | {
      readonly kind: "observed";
      readonly definition: WorktreeResourceDefinition;
      readonly use: WorktreeResourceUse;
      readonly observedAt: Date;
    }
  | {
      readonly kind: "launched-without";
      readonly definition: ResourceDefinitionInput;
      readonly because: ResourceLaunchHold;
    }
  /** A switch of the worktree's selection, with the processes it restarted and still waits for. */
  | {
      readonly kind: "switched";
      readonly definition: ProjectResourceDefinition;
      readonly use: ProjectResourceUse;
      readonly restarted: ReadonlyArray<string>;
      readonly waitingFor: ReadonlyArray<string>;
    };

/**
 * `postgres:17` → `postgres 17`, `rabbitmq:4-management` → `rabbitmq 4`, `axllent/mailpit:v1.21`
 * → `mailpit`. A preset leads with its own name: `pgvector/pgvector:pg17` → `postgres pgvector 17`.
 */
const engineOf = (def: ResourceDefinitionInput): string => {
  const { repository, tag } = imageReference(def.image);
  const image = repository.split("/").at(-1) ?? repository;
  const major = (def.preset === null ? null : /(?:^|-)pg(\d+)/.exec(tag)) ?? /^(\d+)/.exec(tag);
  const names =
    def.preset === null ? [image] : image === def.preset ? [def.preset] : [def.preset, image];
  return [...names, ...(major === null ? [] : [major[1]])].join(" ");
};

const SHARED_DATABASE_WARNING = "any worktree on shared can change or drop its tables";

const BLOCKED: { readonly [R in ResourceBlockReason]: string } = {
  "data-volume-missing": "data volume missing",
  "needs-newer-sealant": "resources need a newer Sealant on this runtime",
};

const secretParts = (secret: ResourceSecretState) =>
  secret === "changed-not-applied"
    ? ["secret changed", "not applied", "consumers keep the applied one"]
    : [];

const stopParts = (reason: ResourceStopReason) => {
  switch (reason.kind) {
    case "idle":
      return ["stopped", "idle"];
    case "person":
      return [`stopped by ${reason.by}`];
    case "memory-limit":
      return ["stopped", "memory limit reached"];
    case "disk-limit":
      return ["stopped", "disk limit reached"];
  }
};

const instanceParts = (instance: ResourceInstanceObservation): ReadonlyArray<string> => {
  switch (instance.kind) {
    case "declared":
      return ["declared"];
    case "waiting-for-approval":
      return ["waiting for approval"];
    case "starting":
    case "stopping":
      return [instance.kind];
    case "running":
      return [
        "running",
        instance.probe.kind === "answered" ? `answered ${instance.probe.check}` : "not probed",
        ...secretParts(instance.secret),
      ];
    case "stopped":
      return [...stopParts(instance.reason), ...secretParts(instance.secret)];
    case "blocked":
      return ["blocked", BLOCKED[instance.reason]];
  }
};

type Clock = (at: Date) => string;

const originParts = (start: ResourceOwnStart, clock: Clock) => {
  switch (start.kind) {
    case "empty":
      return ["empty"];
    case "copied":
      return [`copied from shared ${clock(start.at)}`];
    case "snapshot":
      return [`snapshot of shared ${clock(start.at)}`, "crash-consistent"];
    case "seed":
      return [`from seed ${start.seed}`];
  }
};

const choiceParts = (
  def: ResourceDefinitionInput,
  use: ProjectResourceUse | WorktreeResourceUse,
  clock: Clock,
): ReadonlyArray<string> => {
  switch (use.kind) {
    case "shared":
      return [isDatabasePreset(def) ? "shared database" : "shared"];
    case "own":
      return [
        isDatabasePreset(def) ? "its own database" : "its own instance",
        ...originParts(use.start, clock),
      ];
    case "off":
      return ["off"];
    case "worktree":
      return [];
  }
};

const reachedParts = (use: ProjectResourceUse | WorktreeResourceUse) =>
  use.kind === "shared"
    ? [`reached by ${use.worktrees} ${use.worktrees === 1 ? "worktree" : "worktrees"}`]
    : [];

const useInstanceParts = (use: ProjectResourceUse | WorktreeResourceUse) =>
  use.kind === "off" ? [] : instanceParts(use.instance);

const warningsOf = (def: ResourceDefinitionInput, use: ProjectResourceUse | WorktreeResourceUse) =>
  use.kind === "shared" && isDatabasePreset(def) ? [SHARED_DATABASE_WARNING] : [];

/** `14:02` today in the reader's zone, `27 Oct 14:02` on another day, with the year when it differs. */
const clockIn = (now: Date, timeZone: string): Clock => {
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  });
  const dayOf = (at: Date) => {
    const parts = date.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((each) => each.type === type)?.value ?? "";
    return { day: part("day"), month: part("month"), year: part("year") };
  };
  const today = dayOf(now);
  return (at) => {
    const day = dayOf(at);
    if (day.day === today.day && day.month === today.month && day.year === today.year) {
      return time.format(at);
    }
    const year = day.year === today.year ? "" : ` ${day.year}`;
    return `${day.day} ${day.month}${year} ${time.format(at)}`;
  };
};

const launchParts = (def: ResourceDefinitionInput, because: ResourceLaunchHold) => {
  if (because.kind === "stopped-by") {
    return [`stopped by ${because.by}`, "this session starts without it"];
  }
  return because.reason === "needs-newer-sealant"
    ? [BLOCKED[because.reason], `this session can run its own [service.${def.name}]`]
    : ["blocked", BLOCKED[because.reason], "this session starts without it"];
};

/**
 * The one status line every client shows for a resource (ADR 0019, decision S5): what was
 * observed and when, never a verdict and never a credential. Clock times read in `timeZone`, the
 * reader's, which a caller must name because a server's zone is nobody's.
 */
export const resourceStatusLine = (
  view: ResourceStatusView,
  at: { readonly now: Date; readonly timeZone: string },
): string => {
  const clock = clockIn(at.now, at.timeZone);
  const def = view.definition;
  const parts = ((): ReadonlyArray<string> => {
    switch (view.kind) {
      case "launched-without":
        return launchParts(def, view.because);
      case "switched":
        return [
          ...choiceParts(def, view.use, clock),
          ...useInstanceParts(view.use),
          ...(view.restarted.length > 0 ? [`restarted ${view.restarted.join(", ")}`] : []),
          ...(view.waitingFor.length > 0
            ? [`waiting for ${view.waitingFor.join(", ")} to restart`]
            : []),
          ...warningsOf(def, view.use),
        ];
      case "observed":
        return [
          engineOf(def),
          def.scope,
          ...choiceParts(def, view.use, clock),
          ...reachedParts(view.use),
          ...useInstanceParts(view.use),
          ...warningsOf(def, view.use),
          `observed ${observedAgo(view.observedAt, at.now)}`,
        ];
    }
  })();
  return [`@${def.name}`, ...parts].join(" · ");
};
