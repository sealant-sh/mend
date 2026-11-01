import { observedAgo } from "./landing.ts";
import { loadBytes, type ResourceLoadPhase } from "./resource-load.ts";
import { imageReference, type ResourceDefinition, type ResourceLevel } from "./resource.ts";

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
  | { readonly kind: "copied"; readonly at: Date }
  | { readonly kind: "loaded"; readonly at: Date };

/** What a read is for: one worktree's use of a resource, or the project as a whole. */
export type ResourceUse =
  | { readonly kind: "shared" }
  /** Null: the worktree has not made its own database yet. */
  | { readonly kind: "own"; readonly origin: OwnDatabaseOrigin | null; readonly available?: true }
  | { readonly kind: "off" }
  /** A worktree resource: the worktree's own instance. */
  | { readonly kind: "worktree" }
  /** Read for no worktree: who added it. A worktree resource's instances are counted instead. */
  | { readonly kind: "project"; readonly addedBy: string };

/** The status line's input. The line reads a definition's name, image and level, never its env. */
export type ResourceStatusView =
  | {
      readonly kind: "load";
      readonly definition: ResourceDefinition;
      readonly target: "shared" | "own";
      readonly phase: ResourceLoadPhase;
      readonly label: string;
      readonly bytesDone: number;
      readonly bytesTotal: number | null;
      readonly savedAt: Date | null;
      readonly message: string | null;
    }
  | {
      readonly kind: "own-removed";
      readonly purpose?: "own" | "base";
      readonly definition: { readonly name: string };
      readonly savedAt: Date;
      readonly startedForRemoval: boolean;
      /** The server was archived after the recorded dump was checked; no live drop is needed. */
      readonly savedWhenArchived?: boolean;
    }
  | {
      readonly kind: "removal-refused";
      readonly definition: ResourceDefinition;
      readonly database: string;
      readonly reason: string;
    }
  | {
      readonly kind: "archived";
      readonly definition: ResourceDefinition;
    }
  | {
      readonly kind: "observed";
      readonly definition: ResourceDefinition;
      readonly use: ResourceUse;
      readonly level: ResourceLevel;
      /** A worktree resource read for the project: how many of its instances run. */
      readonly instance:
        | ResourceInstanceObservation
        | { readonly kind: "per-worktree"; readonly running: number };
      readonly observedAt: Date;
    }
  /** A launch went on while the instance was not running: the process has its env, not its server. */
  | {
      readonly kind: "launched-without";
      readonly definition: ResourceDefinition;
      readonly instance: ResourceInstanceObservation;
    }
  /** Names the project's env or secrets set, which the resource leaves as they are. */
  | {
      readonly kind: "env-left";
      readonly definition: ResourceDefinition;
      readonly names: ReadonlyArray<string>;
    }
  /** The worktree's own database could not be made, and why; run mend resource start to try again. */
  | {
      readonly kind: "own-not-made";
      readonly definition: ResourceDefinition;
      readonly message: string;
    }
  /**
   * A worktree's switch: the use it has now and the Services it restarted. Agents and shells keep
   * the env they opened with until they restart.
   */
  | {
      readonly kind: "switched";
      readonly definition: ResourceDefinition;
      readonly use: ResourceUse;
      readonly restarted: ReadonlyArray<string>;
    }
  /**
   * A database emptied by a reset: which one, how it begins again, and when the dump of what it
   * held was saved (null: it held nothing yet).
   */
  | {
      readonly kind: "reset";
      readonly definition: ResourceDefinition;
      readonly target: "shared" | "own";
      readonly origin: "empty" | "copied";
      readonly savedAt: Date | null;
    }
  | {
      readonly kind: "definition-differs";
      readonly definition: ResourceDefinition;
      readonly level: ResourceLevel;
    }
  | {
      readonly kind: "own-on-differing-server";
      readonly definition: ResourceDefinition;
      readonly requested: ResourceDefinition;
    }
  | { readonly kind: "defined"; readonly definition: ResourceDefinition };

/**
 * `postgres:17` → `postgres 17`, `rabbitmq:4-management` → `rabbitmq 4`, `axllent/mailpit:v1.21`
 * → `mailpit`. A preset leads with its own name: `pgvector/pgvector:pg17` → `postgres pgvector 17`.
 */
export const engineOf = (def: ResourceDefinition): string => {
  const { repository, tag } = imageReference(def.image);
  const image = repository.split("/").at(-1) ?? repository;
  const major = (def.preset === null ? null : /(?:^|-)pg(\d+)/.exec(tag)) ?? /^(\d+)/.exec(tag);
  const names =
    def.preset === null ? [image] : image === def.preset ? [def.preset] : [def.preset, image];
  return `${names.join(" ")}${major === null ? "" : `:${major[1]}`}`;
};

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
  def: ResourceDefinition,
  use: ResourceUse,
  clock: Clock,
): ReadonlyArray<string> => {
  switch (use.kind) {
    case "shared":
      return def.preset === "postgres" ? ["shared database"] : [];
    case "own":
      return [
        "own database",
        ...(use.origin === null
          ? use.available === true
            ? []
            : ["not made yet"]
          : use.origin.kind === "copied"
            ? [`copied from shared ${clock(use.origin.at)}`]
            : use.origin.kind === "loaded"
              ? [`loaded ${clock(use.origin.at)}`]
              : [`started empty ${clock(use.origin.at)}`]),
      ];
    case "off":
      return ["off"];
    case "worktree":
      return [];
    case "project":
      return [engineOf(def), `started by ${use.addedBy}`];
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
  const clock = clockIn(at.now, at.timeZone);
  if (view.kind === "own-removed")
    return [
      `@${view.definition.name}`,
      `${view.purpose === "base" ? "base copy database" : "its own database"} saved as a dump ${clock(view.savedAt)}${view.savedWhenArchived ? "" : " and dropped"}`,
      ...(view.savedWhenArchived ? [`saved when @${view.definition.name} was archived`] : []),
      ...(view.startedForRemoval ? ["removal started its server"] : []),
    ].join(" · ");
  const def = view.definition;
  const parts = ((): ReadonlyArray<string> => {
    switch (view.kind) {
      case "load":
        if (view.phase === "done")
          return [
            `loaded ${loadBytes(view.bytesDone)} from ${view.label}`,
            view.savedAt === null
              ? "it had no data"
              : `previous data saved as a dump ${clock(view.savedAt)}`,
            `${view.target} database`,
          ];
        if (view.phase === "failed")
          return [
            "load failed",
            view.message ?? "the load did not finish",
            "the database was not changed",
          ];
        return [
          `loading ${view.label}`,
          `${view.phase} ${loadBytes(view.bytesDone)}${view.bytesTotal === null ? "" : ` of ${loadBytes(view.bytesTotal)}`}`,
          `${view.target} database`,
        ];
      case "removal-refused":
        return [`database ${view.database}`, "not removed", view.reason];
      case "archived":
        return ["archived", "volumes kept"];
      case "defined":
        return [engineOf(def), "in .mend/mend.toml", "not started"];
      case "definition-differs":
        return [view.level, "definition differs from this worktree"];
      case "own-on-differing-server":
        return [
          `own database on the project server (${engineOf(def)})`,
          `this worktree's file asks ${engineOf(view.requested)}`,
        ];
      case "launched-without":
        return [...instanceParts(view.instance), "this session starts without it"];
      case "env-left":
        return [
          `${view.names.join(", ")} left as the project sets ${view.names.length === 1 ? "it" : "them"}`,
        ];
      case "own-not-made":
        return ["own database not made", view.message, "run mend resource start to try again"];
      case "switched":
        return [
          ...useParts(def, view.use, clock),
          ...(view.use.kind === "off"
            ? []
            : [
                view.restarted.length === 0
                  ? "no Service was running"
                  : `restarted ${view.restarted.join(", ")}`,
              ]),
          "agents and shells keep their env until they restart",
        ];
      case "reset":
        return [
          `${view.target === "own" ? "own" : "shared"} database reset`,
          view.origin === "copied" ? "copied from shared" : "empty",
          view.savedAt === null
            ? "it held no data to save"
            : `previous data saved as a dump ${clock(view.savedAt)}`,
        ];
      case "observed":
        if (view.use.kind === "off") return ["off"];
        return view.use.kind === "project"
          ? [
              ...useParts(def, view.use, clock),
              ...instanceParts(view.instance),
              view.level,
              `observed ${observedAgo(view.observedAt, at.now)}`,
            ]
          : [
              ...instanceParts(view.instance),
              view.level,
              ...useParts(def, view.use, clock),
              `observed ${observedAgo(view.observedAt, at.now)}`,
            ];
    }
  })();
  return [`@${def.name}`, ...parts].join(" · ");
};
