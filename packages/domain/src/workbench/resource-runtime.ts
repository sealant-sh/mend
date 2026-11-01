import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { ProjectId, ResourceDefinitionId, WorktreeId } from "../ids.ts";
import {
  choiceInEffect,
  type ResourceBinding,
  type ResourceDefinition,
  resourceEnvPrefix,
  type ResourceName,
  type WorktreeChoice,
} from "./resource.ts";

/**
 * How Mend runs a resource on Sealant and what every process in a worktree is told of it (ADR
 * 0019, amendment of 2026-11-01). Pure: the `Resources` service reads the rows, these decide.
 */

/** The database `shared` names on a project Postgres, and the one a worktree Postgres serves. */
export const SHARED_DATABASE = "app";

/** The one login on every Postgres; the reach network is the access boundary, so it has no password. */
export const POSTGRES_USER = "postgres";

/** Every Postgres gets a volume here: dumps live beside the data they protect. */
export const DUMPS_MOUNT = "/mend/dumps";

/** An instance no live workspace reaches for this long stops, and keeps its volumes. */
export const RESOURCE_IDLE_STOP_SECONDS = 1800;

/** `own_` and 12 hex: a database name Postgres takes unquoted, and a shell argument as it is. */
export const OWN_DATABASE = /^own_[0-9a-f]{12}$/;

/**
 * A worktree's own database on its project's Postgres: `own_<12 hex of sha256(worktreeId)>`.
 * Derived, never stored, so a switch back to own always lands on the same data.
 */
export const ownDatabaseName = (worktreeId: WorktreeId): string =>
  `own_${bytesToHex(sha256(utf8ToBytes(worktreeId))).slice(0, 12)}`;

/** A base copy stays separate from the after app's own database. */
export const baseDatabaseName = (worktreeId: WorktreeId): string =>
  `base_${bytesToHex(sha256(utf8ToBytes(worktreeId))).slice(0, 12)}`;

/** Only derived worktree database names may enter copy and removal scripts. */
export const WORKTREE_DATABASE = /^(own|base)_[0-9a-f]{12}$/;

/** Selects a tracked database without changing the worktree's resource binding. */
export const worktreeDatabaseName = (worktreeId: WorktreeId, purpose: "own" | "base"): string =>
  purpose === "base" ? baseDatabaseName(worktreeId) : ownDatabaseName(worktreeId);

/** The Sealant scope a project's resources run in. */
export const resourceScopeKey = (projectId: ProjectId): string => `mend:${projectId}`;

/** Sealant's key for an instance: the definition's id, and `@<worktree id>` for a worktree resource. */
export const resourceInstanceKey = (
  definitionId: ResourceDefinitionId,
  worktreeId: WorktreeId | null,
): string => (worktreeId === null ? definitionId : `${definitionId}@${worktreeId}`);

/**
 * What Sealant runs for an instance: `@sealant/sdk`'s `ScopeInstanceSpec`, field for field. It has
 * no field for privileged mode, capabilities, host networking or paths, devices or the Docker
 * socket, so a definition cannot ask for one.
 */
export interface ResourceInstanceSpec {
  readonly alias: string;
  readonly worktreeKey: string | null;
  readonly image: string;
  readonly command: ReadonlyArray<string> | null;
  readonly env: Readonly<Record<string, string>>;
  readonly volumes: ReadonlyArray<{ readonly name: string; readonly mountPath: string }>;
  readonly limits: { readonly cpuMillicores: number; readonly memoryBytes: number };
  readonly ready:
    | { readonly kind: "tcp"; readonly port: number }
    | {
        readonly kind: "exec";
        readonly argv: ReadonlyArray<string>;
        readonly user: string | null;
      };
  readonly idleStopAfterSeconds: number;
}

/** The env a preset's image needs to start with no password and the shared database made. */
const presetEnv = (def: ResourceDefinition): Readonly<Record<string, string>> => {
  switch (def.preset) {
    case "postgres":
      return { POSTGRES_HOST_AUTH_METHOD: "trust", POSTGRES_DB: SHARED_DATABASE };
    case "mysql":
      return { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MYSQL_DATABASE: SHARED_DATABASE };
    case "redis":
    case null:
      return {};
  }
};

const firstPort = (def: ResourceDefinition, protocol?: "tcp") =>
  def.ports.find((port) => protocol === undefined || port.protocol === protocol);

const readyOf = (def: ResourceDefinition): ResourceInstanceSpec["ready"] => {
  if (def.preset === "postgres") {
    return {
      kind: "exec",
      argv: ["pg_isready", "-h", "127.0.0.1", "-U", POSTGRES_USER, "-d", SHARED_DATABASE],
      user: POSTGRES_USER,
    };
  }
  if (def.ready.kind === "command") return { kind: "exec", argv: def.ready.argv, user: null };
  const tcp = firstPort(def, "tcp");
  // A resource with no TCP port has nothing to accept on: it is ready once it runs.
  return tcp === undefined || def.ready.kind === "none"
    ? { kind: "exec", argv: ["sh", "-c", "true"], user: null }
    : { kind: "tcp", port: tcp.port };
};

/** The literal env values of a definition. A `{ secret }` value is not sent: Sealant's spec is plain. */
const literalEnv = (def: ResourceDefinition) =>
  Object.fromEntries(
    Object.entries(def.env).flatMap(([name, value]) =>
      typeof value === "string" ? [[name, value]] : [],
    ),
  );

/** The env names a definition sets from a project secret, which its instance does not get yet. */
export const secretEnvLeftOut = (def: ResourceDefinition): ReadonlyArray<string> =>
  Object.entries(def.env).flatMap(([name, value]) => (typeof value === "string" ? [] : [name]));

/**
 * The instance a definition runs as: its image pinned by digest, its engine settings, its volumes
 * (a Postgres also gets its dumps volume), its limits and its ready check. A worktree resource is
 * reached only from its worktree.
 */
export const resourceInstanceSpec = (input: {
  readonly definition: ResourceDefinition;
  /** The image pinned to its digest: `postgres:17@sha256:…`. */
  readonly image: string;
  readonly worktreeId: WorktreeId | null;
  /** Operator's idle bound; omitted callers use thirty minutes. */
  readonly idleStopAfterSeconds?: number;
}): ResourceInstanceSpec => {
  const def = input.definition;
  const dumps =
    def.preset === "postgres" &&
    !def.volumes.some((volume) => volume.name === "dumps" || volume.mountPath === DUMPS_MOUNT)
      ? [{ name: "dumps", mountPath: DUMPS_MOUNT }]
      : [];
  return {
    alias: def.name,
    worktreeKey: input.worktreeId,
    image: input.image,
    command: def.command,
    env: { ...literalEnv(def), ...presetEnv(def) },
    volumes: [...def.volumes.map(({ name, mountPath }) => ({ name, mountPath })), ...dumps],
    limits: {
      cpuMillicores: Math.max(10, Math.round(def.limits.cpu * 1000)),
      memoryBytes: def.limits.memoryMiB * 1024 * 1024,
    },
    ready: readyOf(def),
    idleStopAfterSeconds: input.idleStopAfterSeconds ?? RESOURCE_IDLE_STOP_SECONDS,
  };
};

/** The identity and remembered rows needed to resolve one worktree's bindings. */
export interface ResourceBindingRows {
  readonly worktreeId: WorktreeId;
  readonly usesProjectResources: boolean;
  readonly resources: ReadonlyArray<{ readonly id: ResourceDefinitionId; readonly name: string }>;
  readonly instances: ReadonlyArray<{
    readonly resourceId: ResourceDefinitionId;
    readonly worktreeId: WorktreeId | null;
    readonly spec: ResourceDefinition;
  }>;
  readonly selections: ReadonlyArray<{
    readonly resourceId: ResourceDefinitionId;
    readonly mode: WorktreeChoice;
  }>;
  readonly ownDatabases: ReadonlySet<ResourceDefinitionId>;
}

/** Resolve availability from remembered rows only. A missing target never binds. */
export const resourceBindings = (rows: ResourceBindingRows): ReadonlyArray<ResourceBinding> =>
  rows.resources.flatMap((resource): ReadonlyArray<ResourceBinding> => {
    const choice = choiceInEffect(
      rows.selections.find((row) => row.resourceId === resource.id)?.mode ?? null,
      rows.usesProjectResources,
    );
    if (choice === "off") return [];
    const project = rows.instances.find(
      (row) => row.resourceId === resource.id && row.worktreeId === null,
    );
    if (choice === "project")
      return project === undefined
        ? []
        : [
            {
              definition: project.spec,
              level: "project",
              resourceId: resource.id,
              instanceKey: resourceInstanceKey(resource.id, null),
              database: project.spec.preset === "postgres" ? SHARED_DATABASE : null,
            },
          ];
    const own = rows.instances.find(
      (row) => row.resourceId === resource.id && row.worktreeId === rows.worktreeId,
    );
    if (own !== undefined)
      return [
        {
          definition: own.spec,
          level: "worktree",
          resourceId: resource.id,
          instanceKey: resourceInstanceKey(resource.id, rows.worktreeId),
          database: own.spec.preset === "postgres" ? SHARED_DATABASE : null,
        },
      ];
    if (project?.spec.preset === "postgres")
      return rows.ownDatabases.has(resource.id)
        ? [
            {
              definition: project.spec,
              level: "worktree",
              resourceId: resource.id,
              instanceKey: resourceInstanceKey(resource.id, null),
              database: ownDatabaseName(rows.worktreeId),
            },
          ]
        : [];
    return [];
  });

/** The server level Core should attach for each selected alias. Own Postgres uses the project server. */
export const reachAliases = (
  bindings: ReadonlyArray<ResourceBinding>,
): Record<string, "project" | "worktree"> =>
  Object.fromEntries(
    bindings.map((binding) => [
      binding.definition.name,
      binding.instanceKey === resourceInstanceKey(binding.resourceId, null)
        ? "project"
        : "worktree",
    ]),
  );

/** The database remembered in the binding; non-database images have none. */
export const boundDatabase = (binding: ResourceBinding): string | null => binding.database;

/** `{host}`, `{port}`, `{port.<name>}` and `{env.<NAME>}` filled in; null when one names a secret. */
const renderExport = (def: ResourceDefinition, template: string): string | null => {
  const values = new Map<string, string>([
    ["host", def.name],
    ...def.ports.slice(0, 1).map((port) => ["port", String(port.port)] as const),
    ...def.ports.map((port) => [`port.${port.name}`, String(port.port)] as const),
    ...Object.entries(literalEnv(def)).map(([name, value]) => [`env.${name}`, value] as const),
  ]);
  let missing = false;
  const rendered = template.replace(/\{([^{}]*)\}/g, (_, placeholder: string) => {
    const value = values.get(placeholder);
    if (value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? null : rendered;
};

/** A binding's exports in URL, host, port, Postgres fields, then declared export order. */
export const resourceBindingEnv = (
  binding: ResourceBinding,
): ReadonlyArray<readonly [string, string]> => {
  const def = binding.definition;
  const prefix = resourceEnvPrefix(def.name);
  const host = def.name;
  const port = firstPort(def);
  const at = `${host}:${port?.port ?? ""}`;
  const database = binding.database ?? SHARED_DATABASE;
  const url =
    def.preset === "postgres"
      ? `postgres://${POSTGRES_USER}@${at}/${database}`
      : def.preset === "redis"
        ? `redis://${at}`
        : def.preset === "mysql"
          ? `mysql://root@${at}/app`
          : def.exports.URL === undefined
            ? `${port?.protocol ?? "tcp"}://${at}`
            : renderExport(def, def.exports.URL);
  return [
    ...(url === null ? [] : [[`${prefix}URL`, url] as const]),
    [`${prefix}HOST`, host],
    ...(port === undefined ? [] : [[`${prefix}PORT`, String(port.port)] as const]),
    ...(def.preset === "postgres"
      ? ([
          [`${prefix}USER`, POSTGRES_USER],
          [`${prefix}PASSWORD`, ""],
          [`${prefix}DATABASE`, database],
        ] as const)
      : []),
    ...Object.entries(def.exports).flatMap(([name, template]) => {
      if (name === "URL") return [];
      const value = renderExport(def, template);
      return value === null ? [] : [[`${prefix}${name}`, value] as const];
    }),
  ];
};

/** The env names one resource left to the project, which sets them itself. */
export interface ResourceEnvLeft {
  readonly resource: ResourceName;
  readonly names: ReadonlyArray<string>;
}

/**
 * The env every process in a worktree gets from the resources it uses (story 2): each one's
 * `MEND_<NAME>_*`. A name the project's env or secrets set is left as the project
 * sets it, and said. Built from the rows alone, never from what runs, so a slow or failed start
 * still gives the right names.
 */
export const resourceProcessEnv = (input: {
  readonly bindings: ReadonlyArray<ResourceBinding>;
  readonly worktreeId: WorktreeId;
  readonly projectEnvNames: ReadonlySet<string>;
}): {
  readonly env: Readonly<Record<string, string>>;
  readonly left: ReadonlyArray<ResourceEnvLeft>;
} => {
  const env: Record<string, string> = {};
  const left: Array<ResourceEnvLeft> = [];
  for (const binding of input.bindings) {
    const def = binding.definition;
    const kept: Array<string> = [];
    for (const [name, value] of resourceBindingEnv(binding)) {
      if (input.projectEnvNames.has(name)) kept.push(name);
      else env[name] = value;
    }
    if (kept.length > 0) left.push({ resource: def.name, names: kept });
  }
  return { env, left };
};

/** `export NAME='value'` lines a POSIX shell reads back exactly, sorted by name. */
export const shellExports = (env: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.entries(env)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `export ${name}='${value.replaceAll("'", `'\\''`)}'`);
