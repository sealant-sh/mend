import { Effect, Schema } from "effect";

import { ResourceDatabaseId, ResourceInstanceId } from "../ids.ts";
import { observedAgo } from "./landing.ts";
import { ENV_NAME } from "./service-recipe.ts";

/** One DNS label on the project network (ADR 0019, "Names"). */
export const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Names a workspace already resolves. */
export const RESERVED_RESOURCE_NAMES: ReadonlyArray<string> = [
  "docker",
  "localhost",
  "host",
  "mend",
  "garage",
  "postgres",
];

/** Why `raw` cannot name a resource, or null when it can. */
export const resourceNameIssue = (raw: string): string | null => {
  if (!RESOURCE_NAME.test(raw)) {
    return "is not one DNS label (a lowercase letter, then up to 30 lowercase letters, digits or -)";
  }
  if (RESERVED_RESOURCE_NAMES.includes(raw))
    return "is reserved, because a workspace already resolves it";
  return null;
};

export const ResourceName = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => resourceNameIssue(value) ?? undefined)),
  Schema.brand("ResourceName"),
);
export type ResourceName = typeof ResourceName.Type;

export const ResourcePreset = Schema.Literals(["postgres", "redis", "mysql"]);
export type ResourcePreset = typeof ResourcePreset.Type;

export const ResourceScope = Schema.Literals(["project", "worktree"]);
export type ResourceScope = typeof ResourceScope.Type;

/** A port's or a volume's name: a label too, so `_PORT_<NAME>` is an env name. */
const PartName = Schema.String.check(Schema.isPattern(RESOURCE_NAME));

export const ResourcePort = Schema.Struct({
  name: PartName,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  protocol: Schema.Literals(["tcp", "udp"]),
});
export type ResourcePort = typeof ResourcePort.Type;

/** A literal value, or a reference to a project secret by name. */
export const ResourceEnvValue = Schema.Union([
  Schema.String,
  Schema.Struct({ secret: Schema.String }),
]);
export type ResourceEnvValue = typeof ResourceEnvValue.Type;

const isMountPath = (value: string) =>
  value.length > 1 &&
  value.startsWith("/") &&
  !value.includes("\0") &&
  value
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

export const ResourceVolume = Schema.Struct({
  name: PartName,
  mountPath: Schema.String.check(
    Schema.makeFilter((value: string) =>
      isMountPath(value) ? undefined : "an absolute, normalized path below /",
    ),
  ),
});
export type ResourceVolume = typeof ResourceVolume.Type;

/** Decision G3's per-instance defaults; a manager may raise them. */
export const RESOURCE_LIMIT_DEFAULTS = { cpu: 1, memoryMiB: 1024, diskGiB: 10 } as const;

const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const ResourceLimits = Schema.Struct({
  cpu: Positive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(RESOURCE_LIMIT_DEFAULTS.cpu))),
  memoryMiB: PositiveInt.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(RESOURCE_LIMIT_DEFAULTS.memoryMiB)),
  ),
  diskGiB: PositiveInt.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(RESOURCE_LIMIT_DEFAULTS.diskGiB)),
  ),
});
export type ResourceLimits = typeof ResourceLimits.Type;

/** A TCP accept on the first TCP port, a probe command, or the preset's own check. */
export const ResourceReady = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tcp") }),
  Schema.Struct({ kind: Schema.Literal("command"), argv: Schema.NonEmptyArray(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("preset") }),
]);
export type ResourceReady = typeof ResourceReady.Type;

/** An export's name, the suffix after `MEND_RESOURCE_<NAME>_`. */
export const RESOURCE_EXPORT_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * A resource as declared and not yet approved (ADR 0019): from project settings, `mend resource`
 * or a `[resource.*]` proposal in `mend.toml`. Shapes are checked here; rules across fields are
 * `resourceDefinitionRefusals`.
 */
export const ResourceDefinitionInput = Schema.Struct({
  name: ResourceName,
  scope: ResourceScope,
  preset: Schema.NullOr(ResourcePreset),
  image: Schema.String.check(Schema.isMinLength(1)),
  /** Null keeps the image's entrypoint. */
  command: Schema.NullOr(Schema.NonEmptyArray(Schema.String)),
  ports: Schema.Array(ResourcePort),
  /** Keys are refused by name in `resourceDefinitionRefusals`; a checked key would be dropped. */
  env: Schema.Record(Schema.String, ResourceEnvValue),
  volumes: Schema.Array(ResourceVolume),
  limits: ResourceLimits.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  ready: ResourceReady,
  /** Templates over `{host}`, `{port}`, `{port.<name>}` and `{env.<NAME>}`. */
  exports: Schema.Record(Schema.String, Schema.String),
});
export type ResourceDefinitionInput = typeof ResourceDefinitionInput.Type;

/** Why a definition cannot be approved: the key it names (`ports.http`, `exports.URL`) and why. */
export const ResourceRefusal = Schema.Struct({ key: Schema.String, message: Schema.String });
export type ResourceRefusal = typeof ResourceRefusal.Type;

const duplicates = (values: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];

const envPart = (label: string): string => label.toUpperCase().replaceAll("-", "_");

/** The suffixes Mend sets for every resource, whatever it exports. */
const addressSuffixes = (def: ResourceDefinitionInput): ReadonlyArray<string> => [
  "HOST",
  ...(def.ports.length > 0 ? ["PORT"] : []),
  ...def.ports.map((port) => `PORT_${envPart(port.name)}`),
];

const PLACEHOLDER = /\{([^{}]*)\}/g;

const exportRefusals = (
  def: ResourceDefinitionInput,
  name: string,
  template: string,
): ReadonlyArray<ResourceRefusal> => {
  const key = `exports.${name}`;
  if (!RESOURCE_EXPORT_NAME.test(name)) {
    return [{ key, message: "is not an export name (an upper-case letter, then A-Z, 0-9 or _)" }];
  }
  if (addressSuffixes(def).includes(name)) {
    return [{ key, message: "is set by Mend for every resource" }];
  }
  const known = new Set([
    "host",
    "port",
    ...def.ports.map((port) => `port.${port.name}`),
    ...Object.keys(def.env).map((env) => `env.${env}`),
  ]);
  return [...template.matchAll(PLACEHOLDER)]
    .map((match) => match[1] ?? "")
    .filter((placeholder) => !known.has(placeholder))
    .map((placeholder) => ({
      key,
      message: `names {${placeholder}}, which is not host, port, a port's or an env's name of this resource`,
    }));
};

/**
 * What Mend knows of each preset's inside: whether `own` is a database on the project instance,
 * the fixed exports, and the conventional names set when it is the only one of its engine in use.
 */
export const RESOURCE_PRESETS: {
  readonly [P in ResourcePreset]: {
    readonly database: boolean;
    readonly exports: ReadonlyArray<string>;
    readonly conventional: ReadonlyArray<string>;
  };
} = {
  postgres: {
    database: true,
    exports: ["URL", "DATABASE", "USERNAME", "PASSWORD"],
    conventional: ["DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"],
  },
  mysql: { database: true, exports: ["URL", "DATABASE", "USERNAME", "PASSWORD"], conventional: [] },
  redis: { database: false, exports: ["URL"], conventional: ["REDIS_URL"] },
};

/** `MEND_RESOURCE_<NAME>_`, with `-` written as `_`. */
export const resourceEnvPrefix = (name: ResourceName): string => `MEND_RESOURCE_${envPart(name)}_`;

/**
 * Every env name a process gets from one resource: its address, its exports, and, when the caller
 * says it is the only one of its engine in use, the preset's conventional names.
 */
export const resourceEnvNames = (
  def: ResourceDefinitionInput,
  use: { readonly onlyOfItsEngine: boolean },
): ReadonlyArray<string> => {
  const preset = def.preset === null ? null : RESOURCE_PRESETS[def.preset];
  const suffixes = [...addressSuffixes(def), ...(preset?.exports ?? Object.keys(def.exports))];
  return [
    ...suffixes.map((suffix) => resourceEnvPrefix(def.name) + suffix),
    ...(use.onlyOfItsEngine ? (preset?.conventional ?? []) : []),
  ];
};

export interface ResourceEnvCollision {
  readonly name: string;
  readonly resources: ReadonlyArray<ResourceName>;
}

/** Env names two resources in use together would both set (`db`'s `MAIN_URL`, `db-main`'s `URL`). */
export const envNameCollisions = (
  defs: ReadonlyArray<ResourceDefinitionInput>,
): ReadonlyArray<ResourceEnvCollision> => {
  const setBy = new Map<string, ReadonlyArray<ResourceName>>();
  for (const def of defs) {
    const onlyOfItsEngine = defs.filter((other) => other.preset === def.preset).length === 1;
    for (const name of resourceEnvNames(def, { onlyOfItsEngine })) {
      setBy.set(name, [...(setBy.get(name) ?? []), def.name]);
    }
  }
  return [...setBy].flatMap(([name, resources]) =>
    resources.length > 1 ? [{ name, resources }] : [],
  );
};

/** A project resource's choice for one worktree. */
export const WorktreeChoice = Schema.Literals(["off", "shared", "own"]);
export type WorktreeChoice = typeof WorktreeChoice.Type;

export type ResourceKind = ResourcePreset | "other";

/** What a worktree gets from one (scope, kind) pair. */
export type ResourceScopePolicy =
  | {
      readonly kind: "choose";
      readonly choices: ReadonlyArray<WorktreeChoice>;
      readonly default: WorktreeChoice;
    }
  /** A worktree resource: its own instance, started on first use, with no choice. */
  | { readonly kind: "own-instance" }
  | { readonly kind: "refused"; readonly message: string };

const DATABASE_POLICY: ResourceScopePolicy = {
  kind: "choose",
  choices: ["shared", "own", "off"],
  default: "own",
};
const PER_WORKTREE: ResourceScopePolicy = { kind: "own-instance" };

/** ADR 0019, "Two scopes, and what each worktree gets": the one policy (S1, S10, G11, G12). */
export const RESOURCE_SCOPE_POLICY: {
  readonly [S in ResourceScope]: { readonly [K in ResourceKind]: ResourceScopePolicy };
} = {
  project: {
    postgres: DATABASE_POLICY,
    mysql: DATABASE_POLICY,
    redis: { kind: "choose", choices: ["shared", "off"], default: "shared" },
    other: { kind: "choose", choices: ["shared", "own", "off"], default: "shared" },
  },
  worktree: {
    postgres: PER_WORKTREE,
    mysql: PER_WORKTREE,
    redis: {
      kind: "refused",
      message:
        "is worktree, and a worktree's own Redis comes in a later step; declare Redis with scope project",
    },
    other: PER_WORKTREE,
  },
};

type PolicySubject = Pick<ResourceDefinitionInput, "scope" | "preset">;

export const scopePolicyFor = (def: PolicySubject): ResourceScopePolicy =>
  RESOURCE_SCOPE_POLICY[def.scope][def.preset ?? "other"];

/** The choices a worktree has; none for a worktree resource. */
export const choicesFor = (def: PolicySubject): ReadonlyArray<WorktreeChoice> => {
  const policy = scopePolicyFor(def);
  return policy.kind === "choose" ? policy.choices : [];
};

/** A worktree's choice at its first launch; null for a worktree resource. */
export const defaultChoiceFor = (def: PolicySubject): WorktreeChoice | null => {
  const policy = scopePolicyFor(def);
  return policy.kind === "choose" ? policy.default : null;
};

/** A selection's revision: a switch, or a reset of the shared data, makes a new one. */
export const SelectionRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("SelectionRevision"),
);
export type SelectionRevision = typeof SelectionRevision.Type;

/** What `own` names: a database on the project instance for a database preset, else an instance. */
export const OwnTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("database"), database: ResourceDatabaseId }),
  Schema.Struct({ kind: Schema.Literal("instance"), instance: ResourceInstanceId }),
]);
export type OwnTarget = typeof OwnTarget.Type;

/** A project resource's choice for one worktree. A worktree resource has no selection. */
export const WorktreeSelection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("off"), revision: SelectionRevision }),
  Schema.Struct({ mode: Schema.Literal("shared"), revision: SelectionRevision }),
  Schema.Struct({ mode: Schema.Literal("own"), revision: SelectionRevision, target: OwnTarget }),
]);
export type WorktreeSelection = typeof WorktreeSelection.Type;

/** Every rule across fields of a definition, each refusal naming its key. Empty when it may run. */
export const resourceDefinitionRefusals = (
  def: ResourceDefinitionInput,
): ReadonlyArray<ResourceRefusal> => {
  const policy = scopePolicyFor(def);
  return [
    ...(policy.kind === "refused" ? [{ key: "scope", message: policy.message }] : []),
    ...(def.ports.length === 0
      ? [{ key: "ports", message: "names no port, and a resource is reached on one" }]
      : []),
    ...duplicates(def.ports.map((port) => port.name)).map((name) => ({
      key: `ports.${name}`,
      message: "names two ports",
    })),
    ...duplicates(def.volumes.map((volume) => volume.name)).map((name) => ({
      key: `volumes.${name}`,
      message: "names two volumes",
    })),
    ...duplicates(def.volumes.map((volume) => volume.mountPath)).map((path) => ({
      key: "volumes",
      message: `mounts two volumes at ${path}`,
    })),
    ...Object.keys(def.env).flatMap((name) =>
      ENV_NAME.test(name)
        ? []
        : [{ key: `env.${name}`, message: "is not an environment variable name" }],
    ),
    ...(def.ready.kind === "preset" && def.preset === null
      ? [{ key: "ready", message: "is a preset's own check, and this resource has no preset" }]
      : []),
    ...(def.preset !== null && Object.keys(def.exports).length > 0
      ? [{ key: "exports", message: `are fixed by the ${def.preset} preset` }]
      : []),
    ...Object.entries(def.exports).flatMap(([name, template]) =>
      exportRefusals(def, name, template),
    ),
  ];
};

/** How an own database or instance began. A snapshot of an unknown image is crash-consistent. */
export type ResourceOwnStart =
  | { readonly kind: "empty" }
  | { readonly kind: "copied"; readonly at: Date }
  | { readonly kind: "snapshot"; readonly at: Date }
  | { readonly kind: "seed"; readonly seed: string };

/** What one worktree observed of one resource. */
export type ResourceUse =
  | { readonly kind: "shared"; readonly worktrees: number }
  | { readonly kind: "own"; readonly start: ResourceOwnStart }
  | { readonly kind: "off" }
  | { readonly kind: "worktree"; readonly state: "starting" | "running" | "stopped" };

/** The status line's input. The line reads a definition's name, image and scope, never its env. */
export type ResourceStatusView =
  | {
      readonly kind: "observed";
      readonly definition: ResourceDefinitionInput;
      readonly use: ResourceUse;
      readonly observedAt: Date;
    }
  /** A launch found the instance stopped by a person; launches never start it. */
  | {
      readonly kind: "stopped-by";
      readonly definition: ResourceDefinitionInput;
      readonly by: string;
    }
  /** A switch of the worktree's selection, with the processes it restarted and still waits for. */
  | {
      readonly kind: "switched";
      readonly definition: ResourceDefinitionInput;
      readonly use: ResourceUse;
      readonly restarted: ReadonlyArray<string>;
      readonly waitingFor: ReadonlyArray<string>;
    };

/** `postgres:17` → `postgres 17`, `rabbitmq:4-management` → `rabbitmq 4`, `axllent/mailpit:v1.21` → `mailpit`. */
const engineOf = (image: string): string => {
  const [repository = image, tag = ""] =
    (image.split("@")[0] ?? image).split("/").at(-1)?.split(":") ?? [];
  const major = /^\d+/.exec(tag)?.[0];
  return major === undefined ? repository : `${repository} ${major}`;
};

const isDatabase = (def: ResourceDefinitionInput) =>
  def.preset !== null && RESOURCE_PRESETS[def.preset].database;

const SHARED_DATABASE_WARNING = "any worktree on shared can change or drop its tables";

const useParts = (def: ResourceDefinitionInput, use: ResourceUse, clock: (at: Date) => string) => {
  switch (use.kind) {
    case "shared":
      return [isDatabase(def) ? "shared database" : "shared"];
    case "off":
      return ["off"];
    case "worktree":
      return [use.state];
    case "own":
      return [
        isDatabase(def) ? "its own database" : "its own instance",
        ...originParts(use.start, clock),
      ];
  }
};

const originParts = (start: ResourceOwnStart, clock: (at: Date) => string) => {
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

const warningsOf = (def: ResourceDefinitionInput, use: ResourceUse) =>
  use.kind === "shared" && isDatabase(def) ? [SHARED_DATABASE_WARNING] : [];

/**
 * The one status line every client shows for a resource (ADR 0019, decision S5): what was
 * observed and when, never a verdict and never a credential. Clock times read in `timeZone`.
 */
export const resourceStatusLine = (
  view: ResourceStatusView,
  at: { readonly now: Date; readonly timeZone?: string | undefined },
): string => {
  const clock = (time: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: at.timeZone,
    }).format(time);
  const def = view.definition;
  const parts = ((): ReadonlyArray<string> => {
    switch (view.kind) {
      case "stopped-by":
        return [`stopped by ${view.by}`, "this session starts without it"];
      case "switched":
        return [
          ...useParts(def, view.use, clock),
          ...(view.restarted.length > 0 ? [`restarted ${view.restarted.join(", ")}`] : []),
          ...(view.waitingFor.length > 0
            ? [`waiting for ${view.waitingFor.join(", ")} to restart`]
            : []),
          ...warningsOf(def, view.use),
        ];
      case "observed":
        return [
          engineOf(def.image),
          def.scope,
          ...useParts(def, view.use, clock),
          ...(view.use.kind === "shared"
            ? [
                `reached by ${view.use.worktrees} ${view.use.worktrees === 1 ? "worktree" : "worktrees"}`,
              ]
            : []),
          ...warningsOf(def, view.use),
          `observed ${observedAgo(view.observedAt, at.now)}`,
        ];
    }
  })();
  return [`@${def.name}`, ...parts].join(" · ");
};
