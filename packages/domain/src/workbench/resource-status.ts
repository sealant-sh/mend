import { observedAgo } from "./landing.ts";
import { imageReference, isDatabasePreset, type ResourceDefinitionInput } from "./resource.ts";

/** Why an instance is stopped: idle, or a person, whose stop holds until a person starts it. */
export type ResourceStopReason =
  | { readonly kind: "idle" }
  | { readonly kind: "person"; readonly by: string };

/** What Sealant last observed of an instance, or why Mend could not ask. */
export type ResourceInstanceObservation =
  | { readonly kind: "not-started" }
  | { readonly kind: "starting" }
  /** Its ready check answered. */
  | { readonly kind: "running" }
  | { readonly kind: "stopped"; readonly reason: ResourceStopReason }
  /** It ended on its own; Sealant starts it again. */
  | { readonly kind: "exited" }
  | { readonly kind: "failed"; readonly message: string }
  /** This Sealant runs no resources: they run on Docker, and it runs `runtime`. */
  | { readonly kind: "unsupported"; readonly runtime: string }
  /** Mend could not ask Sealant, and why. */
  | { readonly kind: "not-observed"; readonly message: string };

/** How a worktree's own database began. */
export type OwnDatabaseOrigin =
  | { readonly kind: "empty"; readonly at: Date }
  | { readonly kind: "copied"; readonly at: Date };

/** What a read is for: one worktree's use of a resource, or the project as a whole. */
export type ResourceUse =
  | { readonly kind: "shared" }
  /** Null: the worktree has not made its own database yet. */
  | { readonly kind: "own"; readonly origin: OwnDatabaseOrigin | null }
  | { readonly kind: "off" }
  /** A worktree resource: the worktree's own instance. */
  | { readonly kind: "worktree" }
  /** Read for no worktree: who added it. A worktree resource's instances are counted instead. */
  | { readonly kind: "project"; readonly addedBy: string };

/**
 * Where a `mend.toml` table stands against what settings hold under its name. A table never
 * replaces a definition settings hold.
 */
export type ResourceDeclaration = {
  readonly kind: "file";
  readonly settings: "absent" | "same" | "differs";
};

/** The status line's input. The line reads a definition's name, image and scope, never its env. */
export type ResourceStatusView =
  | {
      readonly kind: "observed";
      readonly definition: ResourceDefinitionInput;
      readonly use: ResourceUse;
      /** A worktree resource read for the project: how many of its instances run. */
      readonly instance:
        | ResourceInstanceObservation
        | { readonly kind: "per-worktree"; readonly running: number };
      readonly observedAt: Date;
    }
  /** A launch went on while the instance was not running: the process has its env, not its server. */
  | {
      readonly kind: "launched-without";
      readonly definition: ResourceDefinitionInput;
      readonly instance: ResourceInstanceObservation;
    }
  /** Names the project's env or secrets set, which the resource leaves as they are. */
  | {
      readonly kind: "env-left";
      readonly definition: ResourceDefinitionInput;
      readonly names: ReadonlyArray<string>;
    }
  /** The worktree's own database could not be made, and why; the next launch tries again. */
  | {
      readonly kind: "own-not-made";
      readonly definition: ResourceDefinitionInput;
      readonly message: string;
    }
  /** A `mend.toml` table whose name settings hold with another spec: settings were kept. */
  | { readonly kind: "file-kept"; readonly definition: ResourceDefinitionInput }
  /** A `mend.toml` table as read, with no instance behind it. */
  | {
      readonly kind: "declared";
      readonly definition: ResourceDefinitionInput;
      readonly source: ResourceDeclaration;
    };

const AGAINST_SETTINGS = {
  absent: "not in settings",
  same: "same as settings",
  differs: "differs from settings",
} as const;

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

/**
 * What every start of `@name` answers while this Mend starts no resource on a person's ask: a
 * `mend resource start` and a recipe's `depends` on it say this sentence, from here. A surface
 * with no session in view, such as project setup, names a session rather than this one.
 */
export const resourceRuntimeRefusal = (
  name: string,
  surface: "session" | "project" = "session",
): string =>
  `@${name} · resources need a newer Sealant on this runtime · ${surface === "session" ? "this" : "a"} session can run its own [service.${name}]`;

const instanceParts = (
  instance:
    | ResourceInstanceObservation
    | { readonly kind: "per-worktree"; readonly running: number },
): ReadonlyArray<string> => {
  switch (instance.kind) {
    case "not-started":
      return ["not started"];
    case "starting":
    case "running":
      return [instance.kind];
    case "stopped":
      return instance.reason.kind === "person"
        ? [`stopped by ${instance.reason.by}`]
        : ["stopped", "idle"];
    case "exited":
      return ["exited", "Sealant starts it again"];
    case "failed":
      return ["failed", instance.message];
    case "unsupported":
      return [`resources run on Docker; this Sealant runs ${instance.runtime}`];
    case "not-observed":
      return ["not observed", instance.message];
    case "per-worktree":
      return ["one per worktree", `${instance.running} running`];
  }
};

type Clock = (at: Date) => string;

const useParts = (
  def: ResourceDefinitionInput,
  use: ResourceUse,
  clock: Clock,
): ReadonlyArray<string> => {
  switch (use.kind) {
    case "shared":
      return isDatabasePreset(def) ? ["shared database", SHARED_DATABASE_WARNING] : ["shared"];
    case "own":
      return [
        "own database",
        ...(use.origin === null
          ? ["not made yet"]
          : use.origin.kind === "copied"
            ? [`copied from shared ${clock(use.origin.at)}`]
            : [`started empty ${clock(use.origin.at)}`]),
      ];
    case "off":
      return ["off"];
    case "worktree":
      return ["its own instance"];
    case "project":
      return [engineOf(def), def.scope, `added by ${use.addedBy}`];
  }
};

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

/**
 * The one status line every client shows for a resource (ADR 0019, story 7): what was observed and
 * when, never a verdict and never a credential. Clock times read in `timeZone`, the reader's,
 * which a caller must name because a server's zone is nobody's.
 *
 * `@db · running · own database · copied from shared 14:02 · observed 3 s ago`
 * `@db · stopped by Maria · this session starts without it`
 * `@mail · running · its own instance · observed 3 s ago`
 */
export const resourceStatusLine = (
  view: ResourceStatusView,
  at: { readonly now: Date; readonly timeZone: string },
): string => {
  const def = view.definition;
  const clock = clockIn(at.now, at.timeZone);
  const parts = ((): ReadonlyArray<string> => {
    switch (view.kind) {
      case "declared":
        return [engineOf(def), def.scope, "in mend.toml", AGAINST_SETTINGS[view.source.settings]];
      case "launched-without":
        return [...instanceParts(view.instance), "this session starts without it"];
      case "env-left":
        return [
          `${view.names.join(", ")} left as the project sets ${view.names.length === 1 ? "it" : "them"}`,
        ];
      case "own-not-made":
        return ["own database not made", view.message, "the next launch tries again"];
      case "file-kept":
        return ["mend.toml differs", "project settings kept"];
      case "observed":
        if (view.use.kind === "off") return ["off"];
        return view.use.kind === "project"
          ? [
              ...useParts(def, view.use, clock),
              ...instanceParts(view.instance),
              `observed ${observedAgo(view.observedAt, at.now)}`,
            ]
          : [
              ...instanceParts(view.instance),
              ...useParts(def, view.use, clock),
              `observed ${observedAgo(view.observedAt, at.now)}`,
            ];
    }
  })();
  return [`@${def.name}`, ...parts].join(" · ");
};
