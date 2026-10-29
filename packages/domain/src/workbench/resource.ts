import { Effect, Schema } from "effect";

import { ResourceDatabaseId, ResourceInstanceId } from "../ids.ts";
import { EnvName } from "./service-recipe.ts";

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
  if (raw.endsWith(".internal")) return "ends in .internal, which a workspace already resolves";
  if (!RESOURCE_NAME.test(raw)) {
    return "is not one DNS label: a lowercase letter, then up to 30 lowercase letters, digits or -";
  }
  if (RESERVED_RESOURCE_NAMES.includes(raw)) return "is reserved: a workspace already resolves it";
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
export const ResourceExportName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/));

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
  env: Schema.Record(EnvName, ResourceEnvValue),
  volumes: Schema.Array(ResourceVolume),
  limits: ResourceLimits.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  ready: ResourceReady,
  /** Templates over `{host}`, `{port}`, `{port.<name>}` and `{env.<NAME>}`. */
  exports: Schema.Record(ResourceExportName, Schema.String),
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
        "is project only for Redis until Redis gets an instance per worktree; declare it with scope project",
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
