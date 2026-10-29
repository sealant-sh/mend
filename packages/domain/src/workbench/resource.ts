import { Effect, Schema } from "effect";

import { ResourceDatabaseId, ResourceInstanceId } from "../ids.ts";
import { formatProjectEnvironmentIssue } from "./project-environment.ts";
import { validateProjectSecretName } from "./project-secret.ts";
import { ENV_NAME } from "./service-recipe.ts";

/** One DNS label on the project network (ADR 0019, "Names"), which never ends in `-`. */
export const RESOURCE_NAME = /^[a-z]([a-z0-9-]{0,29}[a-z0-9])?$/;

const NOT_A_LABEL =
  "is not one DNS label (a lowercase letter, then up to 30 lowercase letters, digits or -, not ending in -)";

/** Names a workspace already resolves. */
export const RESERVED_RESOURCE_NAMES: ReadonlyArray<string> = [
  "docker",
  "localhost",
  "host",
  "mend",
  "garage",
  "postgres",
];

/** Why `raw` cannot name a new resource, or null when it can. */
export const resourceNameIssue = (raw: string): string | null => {
  if (!RESOURCE_NAME.test(raw)) return NOT_A_LABEL;
  if (RESERVED_RESOURCE_NAMES.includes(raw))
    return "is reserved, because a workspace already resolves it";
  return null;
};

/** Reserved names are refused when declared, not here, so a stored name reads when the list grows. */
export const ResourceName = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => (RESOURCE_NAME.test(value) ? undefined : NOT_A_LABEL)),
  ),
  Schema.brand("ResourceName"),
);
export type ResourceName = typeof ResourceName.Type;

export const ResourcePreset = Schema.Literals(["postgres", "redis", "mysql"]);
export type ResourcePreset = typeof ResourcePreset.Type;

export const ResourceScope = Schema.Literals(["project", "worktree"]);
export type ResourceScope = typeof ResourceScope.Type;

/** A volume's name: a label too. */
const VolumeName = Schema.String.check(Schema.isPattern(RESOURCE_NAME));

/** An IANA service name, as a Kubernetes port name must be; `_PORT_<NAME>` is an env name. */
const PortName = Schema.String.check(
  Schema.isPattern(/^[a-z](-?[a-z0-9])*$/),
  Schema.isMaxLength(15),
);

export const ResourcePort = Schema.Struct({
  name: PortName,
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
  name: VolumeName,
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

/** An executable and its arguments; a later argument may be empty. */
const Argv = Schema.NonEmptyArray(
  Schema.String.check(
    Schema.makeFilter((value: string) => (value.includes("\0") ? "has a NUL byte" : undefined)),
  ),
).check(
  Schema.makeFilter((argv: readonly [string, ...Array<string>]) =>
    argv[0] === "" ? "names no executable" : undefined,
  ),
);

/**
 * A TCP accept on the first TCP port, a probe command, the preset's own check, or, for a resource
 * with no TCP port, none: it is reported running and not probed.
 */
export const ResourceReady = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tcp") }),
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("command"), argv: Argv }),
  Schema.Struct({ kind: Schema.Literal("preset") }),
]);
export type ResourceReady = typeof ResourceReady.Type;

/** An export's name, the suffix after `MEND_RESOURCE_<NAME>_`. */
export const RESOURCE_EXPORT_NAME = /^[A-Z][A-Z0-9_]*$/;

const definitionFields = {
  name: ResourceName,
  preset: Schema.NullOr(ResourcePreset),
  image: Schema.String.check(Schema.isMinLength(1)),
  /** Null keeps the image's entrypoint. */
  command: Schema.NullOr(Argv),
  ports: Schema.Array(ResourcePort),
  /** Keys are refused by name in `resourceDefinitionRefusals`; a checked key would be dropped. */
  env: Schema.Record(Schema.String, ResourceEnvValue),
  volumes: Schema.Array(ResourceVolume),
  limits: ResourceLimits.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  ready: ResourceReady,
  /** Templates over `{host}`, `{port}`, `{port.<name>}` and `{env.<NAME>}`. */
  exports: Schema.Record(Schema.String, Schema.String),
};

export const ProjectResourceDefinition = Schema.Struct({
  ...definitionFields,
  scope: Schema.Literal("project"),
});
export type ProjectResourceDefinition = typeof ProjectResourceDefinition.Type;

export const WorktreeResourceDefinition = Schema.Struct({
  ...definitionFields,
  scope: Schema.Literal("worktree"),
});
export type WorktreeResourceDefinition = typeof WorktreeResourceDefinition.Type;

/**
 * A resource as declared and not yet approved (ADR 0019): from project settings, `mend resource`
 * or a `[resource.*]` proposal in `mend.toml`. Shapes are checked here; rules across fields are
 * `resourceDefinitionRefusals`.
 */
export const ResourceDefinitionInput = Schema.Union([
  ProjectResourceDefinition,
  WorktreeResourceDefinition,
]);
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

type TemplateParse =
  | { readonly ok: true; readonly placeholders: ReadonlyArray<string> }
  | { readonly ok: false; readonly issue: string };

/** A template has no escape, so every brace opens or closes a placeholder. */
const parseTemplate = (template: string): TemplateParse => {
  const placeholders: Array<string> = [];
  let open: number | null = null;
  for (let at = 0; at < template.length; at++) {
    if (template[at] === "{") {
      if (open !== null) {
        return { ok: false, issue: `opens a { at ${at} inside the placeholder at ${open}` };
      }
      open = at;
    } else if (template[at] === "}") {
      if (open === null) return { ok: false, issue: `closes a } at ${at} that no { opened` };
      placeholders.push(template.slice(open + 1, at));
      open = null;
    }
  }
  return open === null
    ? { ok: true, placeholders }
    : { ok: false, issue: `leaves the { at ${open} open` };
};

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
  const parsed = parseTemplate(template);
  if (!parsed.ok) return [{ key, message: parsed.issue }];
  const known = new Set([
    "host",
    "port",
    ...def.ports.map((port) => `port.${port.name}`),
    ...Object.keys(def.env).map((env) => `env.${env}`),
  ]);
  return parsed.placeholders
    .filter((placeholder) => !known.has(placeholder))
    .map((placeholder) => ({
      key,
      message: `names {${placeholder}}, which is not host, port, a port's or an env's name of this resource`,
    }));
};

/** Whether an env value carries a credential, which keeps it out of `launch_env`, logs and status lines. */
export type ResourceEnvKind = "secret" | "plain";

/**
 * What Mend knows of each preset's inside: the image repositories it runs, whether `own` is a
 * database on the project instance, the fixed exports, and the conventional names set when it is
 * the only one of its engine in use.
 */
export const RESOURCE_PRESETS: {
  readonly [P in ResourcePreset]: {
    readonly images: ReadonlyArray<string>;
    readonly database: boolean;
    readonly exports: Readonly<Record<string, ResourceEnvKind>>;
    readonly conventional: Readonly<Record<string, ResourceEnvKind>>;
  };
} = {
  postgres: {
    images: ["postgres", "pgvector/pgvector", "postgis/postgis"],
    database: true,
    exports: { URL: "secret", DATABASE: "plain", USERNAME: "plain", PASSWORD: "secret" },
    conventional: {
      DATABASE_URL: "secret",
      PGHOST: "plain",
      PGPORT: "plain",
      PGUSER: "plain",
      PGPASSWORD: "secret",
      PGDATABASE: "plain",
    },
  },
  mysql: {
    images: ["mysql", "mariadb"],
    database: true,
    exports: { URL: "secret", DATABASE: "plain", USERNAME: "plain", PASSWORD: "secret" },
    conventional: {},
  },
  redis: {
    images: ["redis", "valkey/valkey"],
    database: false,
    exports: { URL: "secret" },
    conventional: { REDIS_URL: "secret" },
  },
};

/** Whether `own` is a database on the project instance rather than an instance of its own. */
export const isDatabasePreset = (def: PolicySubject): boolean =>
  def.preset !== null && RESOURCE_PRESETS[def.preset].database;

/**
 * An image reference's repository and tag: `docker.io/library/postgres:17@sha256:…` is
 * `postgres` and `17`. A registry host is dropped, so a mirror's `postgres` is still `postgres`.
 */
export const imageReference = (image: string): { repository: string; tag: string } => {
  const [named = image] = image.split("@");
  const tagAt = named.lastIndexOf(":");
  const tagged = tagAt > named.lastIndexOf("/");
  const segments = (tagged ? named.slice(0, tagAt) : named).split("/");
  const [first = "", ...rest] = segments;
  const isHost =
    rest.length > 0 && (first.includes(".") || first.includes(":") || first === "localhost");
  const path = isHost ? rest : segments;
  const repository = path.length === 2 && path[0] === "library" ? path.slice(1) : path;
  return { repository: repository.join("/"), tag: tagged ? named.slice(tagAt + 1) : "" };
};

const envRefusals = (name: string, value: ResourceEnvValue): ReadonlyArray<ResourceRefusal> => {
  if (!ENV_NAME.test(name)) {
    return [{ key: `env.${name}`, message: "is not an environment variable name" }];
  }
  if (typeof value === "string") return [];
  const issue = validateProjectSecretName(value.secret);
  return issue === null
    ? []
    : [
        {
          key: `env.${name}.secret`,
          message: `is not a project secret's name. ${formatProjectEnvironmentIssue(issue)}`,
        },
      ];
};

const readyRefusals = (def: ResourceDefinitionInput): ReadonlyArray<ResourceRefusal> => {
  const hasTcp = def.ports.some((port) => port.protocol === "tcp");
  if (def.ready.kind === "tcp" && def.ports.length > 0 && !hasTcp) {
    return [{ key: "ready", message: "is a TCP accept, and this resource has no TCP port" }];
  }
  if (def.ready.kind === "none" && hasTcp) {
    return [{ key: "ready", message: "is none, and this resource has a TCP port to check" }];
  }
  return [];
};

const presetRefusals = (def: ResourceDefinitionInput): ReadonlyArray<ResourceRefusal> => {
  if (def.preset === null) {
    return def.ready.kind === "preset"
      ? [{ key: "ready", message: "is a preset's own check, and this resource has no preset" }]
      : [];
  }
  const preset = RESOURCE_PRESETS[def.preset];
  const { repository } = imageReference(def.image);
  return [
    ...(preset.images.includes(repository)
      ? []
      : [
          {
            key: "image",
            message: `is ${repository}, and the ${def.preset} preset runs ${preset.images.join(", ")}`,
          },
        ]),
    ...(def.ready.kind === "preset"
      ? []
      : [{ key: "ready", message: `is fixed by the ${def.preset} preset to its own check` }]),
    ...(Object.keys(def.exports).length > 0
      ? [{ key: "exports", message: `are fixed by the ${def.preset} preset` }]
      : []),
  ];
};

/** `MEND_RESOURCE_<NAME>_`, with `-` written as `_`. */
export const resourceEnvPrefix = (name: ResourceName): string => `MEND_RESOURCE_${envPart(name)}_`;

/** How a worktree reaches a resource it uses. A project resource on `off` is not bound. */
export type ResourceBinding =
  | { readonly definition: ProjectResourceDefinition; readonly mode: "shared" | "own" }
  | { readonly definition: WorktreeResourceDefinition; readonly mode: "worktree" };

/** Whether `def` is the one of its preset among `bound`; an image Mend does not know is no engine. */
export const onlyOfItsEngine = (
  def: ResourceDefinitionInput,
  bound: ReadonlyArray<ResourceDefinitionInput>,
): boolean =>
  def.preset !== null && bound.filter((other) => other.preset === def.preset).length === 1;

/**
 * An export built from a secret env value is itself a secret (ADR 0019, "Env"). One that does not
 * parse is taken as secret, since what it names is unknown.
 */
const exportKind = (def: ResourceDefinitionInput, template: string): ResourceEnvKind => {
  const parsed = parseTemplate(template);
  if (!parsed.ok) return "secret";
  return parsed.placeholders.some((placeholder) => {
    const value = placeholder.startsWith("env.")
      ? def.env[placeholder.slice("env.".length)]
      : undefined;
    return value !== undefined && typeof value !== "string";
  })
    ? "secret"
    : "plain";
};

const envOf = (
  binding: ResourceBinding,
  bound: ReadonlyArray<ResourceBinding>,
): ReadonlyArray<readonly [string, ResourceEnvKind]> => {
  const def = binding.definition;
  const prefixed = (suffix: string, kind: ResourceEnvKind): readonly [string, ResourceEnvKind] => [
    resourceEnvPrefix(def.name) + suffix,
    kind,
  ];
  const address = addressSuffixes(def).map((suffix) => prefixed(suffix, "plain"));
  if (def.preset === null) {
    return [
      ...address,
      ...Object.entries(def.exports).map(([name, template]) =>
        prefixed(name, exportKind(def, template)),
      ),
    ];
  }
  const preset = RESOURCE_PRESETS[def.preset];
  const only = onlyOfItsEngine(
    def,
    bound.map((other) => other.definition),
  );
  return [
    ...address,
    ...Object.entries(preset.exports).map(([name, kind]) => prefixed(name, kind)),
    // Test and shadow databases are named server-wide, so each own database needs its suffix (S15).
    ...(binding.mode === "own" && preset.database ? [prefixed("SUFFIX", "plain")] : []),
    ...(only ? Object.entries(preset.conventional) : []),
  ];
};

/**
 * Every env name a process gets from each resource its worktree binds: the address, the exports,
 * an own database's suffix, and a preset's conventional names when it is the one of its engine.
 */
export const resourceEnvNames = (
  bound: ReadonlyArray<ResourceBinding>,
): ReadonlyMap<ResourceName, ReadonlyArray<string>> =>
  new Map(
    bound.map((binding) => [binding.definition.name, envOf(binding, bound).map(([name]) => name)]),
  );

/** The env names among `resourceEnvNames` that carry a credential. */
export const secretEnvNames = (bound: ReadonlyArray<ResourceBinding>): ReadonlySet<string> =>
  new Set(
    bound.flatMap((binding) =>
      envOf(binding, bound).flatMap(([name, kind]) => (kind === "secret" ? [name] : [])),
    ),
  );

export interface ResourceEnvCollision {
  readonly name: string;
  readonly resources: ReadonlyArray<ResourceName>;
}

/** The binding that sets the most names: own where the policy offers it. */
const widestBinding = (def: ResourceDefinitionInput): ResourceBinding =>
  def.scope === "worktree"
    ? { definition: def, mode: "worktree" }
    : { definition: def, mode: choicesFor(def).includes("own") ? "own" : "shared" };

/** Env names two resources in use together would both set (`db`'s `MAIN_URL`, `db-main`'s `URL`). */
export const envNameCollisions = (
  defs: ReadonlyArray<ResourceDefinitionInput>,
): ReadonlyArray<ResourceEnvCollision> => {
  const setBy = new Map<string, ReadonlyArray<ResourceName>>();
  for (const [resource, names] of resourceEnvNames(defs.map(widestBinding))) {
    for (const name of names) setBy.set(name, [...(setBy.get(name) ?? []), resource]);
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

/** Why `selection` is not one the policy offers this definition, or null when it is. */
export const selectionRefusal = (
  def: ResourceDefinitionInput,
  selection: WorktreeSelection,
): ResourceRefusal | null => {
  if (def.scope === "worktree") {
    return {
      key: "selection",
      message: `is for a project resource, and @${def.name} is a worktree resource with no choice`,
    };
  }
  const choices = choicesFor(def);
  if (!choices.includes(selection.mode)) {
    return {
      key: "mode",
      message: `is ${selection.mode}, and @${def.name} offers ${choices.join(", ")}`,
    };
  }
  if (selection.mode !== "own") return null;
  const target = isDatabasePreset(def) ? "database" : "instance";
  if (selection.target.kind === target) return null;
  return {
    key: "target",
    message:
      target === "database"
        ? `is an instance, and own for @${def.name} is a database on the project instance`
        : `is a database, and own for @${def.name} is an instance of its own`,
  };
};

/** Every rule across fields of a definition, each refusal naming its key. Empty when it may run. */
export const resourceDefinitionRefusals = (
  def: ResourceDefinitionInput,
): ReadonlyArray<ResourceRefusal> => {
  const policy = scopePolicyFor(def);
  const nameIssue = resourceNameIssue(def.name);
  return [
    ...(nameIssue === null ? [] : [{ key: "name", message: nameIssue }]),
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
    ...Object.entries(def.env).flatMap(([name, value]) => envRefusals(name, value)),
    ...presetRefusals(def),
    ...readyRefusals(def),
    ...Object.entries(def.exports).flatMap(([name, template]) =>
      exportRefusals(def, name, template),
    ),
  ];
};

/** A `mend.toml` key a `[resource.*]` proposal owns (decision S8): `resource`, or one under it. */
export const isResourceProposalKey = (key: string): boolean =>
  key === "resource" || key.startsWith("resource.");

/** Heads `resourceProposalNotices`; true of every proposal, refused or not. */
export const RESOURCE_PROPOSALS_HEADING =
  "Resource proposals in mend.toml (none runs from the file; a manager approves each in project settings)";

/**
 * A file's refusals and ignored keys under `[resource]`, one line each, keyed in full:
 * `resource.db.ports.pg · must be a port in 1..65535`. Empty when there is none.
 */
export const resourceProposalNotices = (declared: {
  readonly refused: ReadonlyArray<{ readonly key: string; readonly message: string }>;
  readonly ignored: ReadonlyArray<{ readonly key: string }>;
}): ReadonlyArray<string> => [
  ...declared.refused.flatMap((refusal) =>
    isResourceProposalKey(refusal.key) ? [`${refusal.key} · ${refusal.message}`] : [],
  ),
  ...declared.ignored.flatMap((ignored) =>
    isResourceProposalKey(ignored.key)
      ? [`${ignored.key} · is ignored: this Mend does not read it`]
      : [],
  ),
];

/** `resourceProposalNotices` for a terminal: the heading, then one indented line each; empty when none. */
export const resourceProposalsSection = (
  declared: Parameters<typeof resourceProposalNotices>[0],
): ReadonlyArray<string> => {
  const notices = resourceProposalNotices(declared);
  return notices.length === 0
    ? []
    : [`${RESOURCE_PROPOSALS_HEADING}:`, ...notices.map((notice) => `  ${notice}`)];
};
